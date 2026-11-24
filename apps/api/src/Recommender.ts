import { type Category, type Preferences, Recommendation, type UserId, type UserNotFound } from "@magpie/contract"
import { Context, Effect, Layer } from "effect"
import { SqlClient } from "effect/sql"
import { EMBED_MODEL } from "./catalog.ts"
import { ITEM_COLUMNS, type ItemRow, toItem } from "./Items.ts"
import { Availability, servicesFilter } from "./Availability.ts"
import { Users } from "./Users.ts"

// Minimum quality percentile for any recommendation, and the stricter bar for link-derived ones:
// a link (sequel, shared creator) transfers interest, never quality.
const QUALITY_FLOOR = 0.2
const LINK_QUALITY_FLOOR = 0.5
const HALF_LIFE_DAYS: Record<Category, number> = { movie: 540, tv: 540, anime: 540, book: 900 }
const MAX_PER_CREATOR = 2
const PEER_SAMPLE = 800

type Source = Recommendation["source"]

interface Candidate {
  readonly id: number
  readonly quality: number | null
  readonly popularity: number
  readonly genres: ReadonlyArray<string>
  readonly lead: string | null
  readonly similarity: number | null
  readonly because: string | null
  // No synopsis and no tags: the embedding encodes little beyond the title, so similarity alone is noise.
  readonly thin: boolean
}

// How much a past interaction says about taste, in [-1.5, 1.5]. Vector maths stays in Postgres: Workers get 10 ms of CPU.
const SIGNAL_WEIGHT = `CASE
  WHEN ui.rating IS NOT NULL THEN ((ui.rating - 3) / 2.0) * 1.5
  WHEN ui.status = 'dropped' THEN -0.6
  WHEN ui.interest = -1 THEN -0.4
  WHEN ui.status = 'finished' THEN 0.5
  WHEN ui.interest = 1 OR ui.status IN ('want', 'in_progress') THEN 0.4
  ELSE 0 END`

/** Liked items with embeddings, for "Because you liked". Takes the user id, category and model as $1, $2, $3. */
const LIKED = `liked AS (
  SELECT i.title, e.embedding FROM user_item ui JOIN item i ON i.id = ui.item_id
  JOIN item_embedding e ON e.item_id = i.id AND e.model = $3
  WHERE ui.user_id::text = $1 AND i.category = $2::category AND ${SIGNAL_WEIGHT} > 0.3
)`

/** Similarity to the taste vector ($4) and the two closest liked titles, for a candidate aliased i with embedding e. */
const SCORED_COLUMNS = `i.id::int AS id, i.quality, i.popularity, i.genres[1:2] AS genres,
  (SELECT c.name FROM (SELECT creator_id, role FROM item_creator WHERE item_id = i.id LIMIT 3) ic
   JOIN creator c ON c.id = ic.creator_id ORDER BY ic.role LIMIT 1) AS lead,
  (i.synopsis IS NULL AND cardinality(i.tags) = 0) AS thin,
  1 - (e.embedding <=> $4::halfvec(384)) AS similarity,
  (SELECT string_agg(n.title, ' and ' ORDER BY n.d) FROM (
     SELECT l.title, l.embedding <=> e.embedding AS d FROM liked l
     WHERE e.embedding IS NOT NULL AND 1 - (l.embedding <=> e.embedding) > 0.6
     ORDER BY d LIMIT 2) n) AS because`

// `deck` also restricts movies and TV to the user's streaming services when they asked for that. Calibration never does:
// it measures taste, not what's watchable tonight.
const filterClause = (prefs: Preferences, category: Category, offset: number, deck = false) => {
  const f = prefs.filters
  const clauses: Array<string> = []
  const params: Array<unknown> = []
  const p = (v: unknown) => {
    params.push(v)
    return `$${offset + params.length}`
  }
  if (!f.showMature) clauses.push("NOT i.is_adult")
  if (f.blockedGenres.length) clauses.push(`NOT (i.genres && ${p(f.blockedGenres)}::text[])`)
  if (f.blockedCreators.length) {
    clauses.push(`NOT EXISTS (SELECT 1 FROM item_creator ic JOIN creator c ON c.id = ic.creator_id
      WHERE ic.item_id = i.id AND lower(c.name) = ANY(${p(f.blockedCreators.map((c) => c.toLowerCase()))}::text[]))`)
  }
  if (category === "movie" && f.maxMinutes) clauses.push(`(i.length_value IS NULL OR i.length_value <= ${p(f.maxMinutes)})`)
  if ((category === "anime" || category === "tv") && f.maxEpisodes) clauses.push(`(i.length_value IS NULL OR i.length_value <= ${p(f.maxEpisodes)})`)
  if (category === "book" && f.maxPages) clauses.push(`(i.length_value IS NULL OR i.length_value <= ${p(f.maxPages)})`)
  if (f.languages.length && category !== "anime") clauses.push(`i.languages && ${p(f.languages)}::text[]`)
  const services = deck && (category === "movie" || category === "tv") ? servicesFilter(prefs.watch) : null
  if (services) {
    clauses.push(`EXISTS (SELECT 1 FROM item_availability a WHERE a.item_id = i.id
      AND a.region = ${p(services.region)} AND a.provider_id = ANY(${p(services.services)}::int[]))`)
  }
  return { sql: clauses.length ? ` AND ${clauses.join(" AND ")}` : "", params }
}

export class Recommender extends Context.Service<Recommender, {
  deck(userId: UserId, category: Category, limit: number): Effect.Effect<ReadonlyArray<Recommendation>, UserNotFound>
  calibration(userId: UserId, category: Category, limit: number): Effect.Effect<ReadonlyArray<Recommendation>, UserNotFound>
}>()("magpie/Recommender") {
  static readonly layer = Layer.effect(
    Recommender,
    Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient
      const users = yield* Users
      const availability = yield* Availability

      const tasteVector = Effect.fn(function*(userId: UserId, category: Category, prefs: Preferences) {
        const [mine] = yield* sql.unsafe<{ v: string | null; mass: number | null }>(
          `WITH s AS (
             SELECT e.embedding::vector AS v, (${SIGNAL_WEIGHT}) * power(0.5, EXTRACT(EPOCH FROM now() - ui.updated_at) / 86400 / $4) AS w
             FROM user_item ui JOIN item i ON i.id = ui.item_id
             JOIN item_embedding e ON e.item_id = i.id AND e.model = $3
             WHERE ui.user_id::text = $1 AND i.category = $2::category
           )
           SELECT l2_normalize(sum(v * array_fill((CASE WHEN w > 0 THEN w ELSE w * 0.5 END)::real, ARRAY[vector_dims(v)])::vector))::text AS v,
                  sum(greatest(w, 0))::float8 AS mass
           FROM s WHERE w <> 0`,
          [userId, category, EMBED_MODEL, HALF_LIFE_DAYS[category]]
        ).pipe(Effect.orDie)
        if (mine?.v && (mine.mass ?? 0) > 0.3) return mine.v
        // Cold start: centroid of popular, well-rated items in the chosen genres.
        const genres = prefs.genres[category] ?? []
        const rows = yield* sql.unsafe<{ v: string | null }>(
          `SELECT l2_normalize(avg(e.embedding::vector))::text AS v FROM (
             SELECT i.id FROM item i WHERE i.category = $1::category AND ($2::text[] = '{}' OR i.genres && $2::text[])
             AND COALESCE(i.quality, 0.5) > 0.5 ORDER BY i.popularity DESC LIMIT 60) t
           JOIN item_embedding e ON e.item_id = t.id AND e.model = $3`,
          [category, genres, EMBED_MODEL]
        ).pipe(Effect.orDie)
        return rows[0]?.v ?? null
      })

      const similar = Effect.fn(function*(category: Category, taste: string, prefs: Preferences, userId: UserId) {
        const filters = filterClause(prefs, category, 4, true)
        return yield* sql.withTransaction(Effect.gen(function*() {
          yield* sql`SELECT set_config('hnsw.ef_search', '400', true), set_config('hnsw.iterative_scan', 'relaxed_order', true)`
          return yield* sql.unsafe<Candidate>(
            `WITH ${LIKED}, near AS (
               SELECT e.item_id, e.embedding FROM item_embedding e JOIN item i ON i.id = e.item_id
               WHERE e.model = $3 AND i.category = $2::category
                 AND (i.synopsis IS NOT NULL OR cardinality(i.tags) > 0)
                 AND NOT EXISTS (SELECT 1 FROM user_item ui WHERE ui.user_id::text = $1 AND ui.item_id = i.id)
                 ${filters.sql}
               ORDER BY e.embedding <=> $4::halfvec(384)
               LIMIT 400
             )
             SELECT ${SCORED_COLUMNS} FROM near e JOIN item i ON i.id = e.item_id`,
            [userId, category, EMBED_MODEL, taste, ...filters.params]
          )
        })).pipe(Effect.orDie)
      })

      // MovieLens raters who agree with the user on overlapping titles, and what they loved. Popular films have thousands
      // of ratings, so peers come from the first PEER_SAMPLE raters of each film: the same raters across films, so
      // overlaps survive, at a tenth of the rows.
      const neighbours = Effect.fn(function*(userId: UserId, category: Category, prefs: Preferences) {
        if (category !== "movie") return new Map<number, number>()
        const rows = yield* sql<{ item_id: number; strength: number }>`
          WITH mine AS (
            SELECT ui.item_id, ui.rating FROM user_item ui JOIN item i ON i.id = ui.item_id
            WHERE ui.user_id = ${userId}::uuid AND ui.rating IS NOT NULL AND i.category = 'movie'
          ),
          peers AS (
            SELECT r.ml_user, sum(1 - abs(r.rating - m.rating) / 2.25) AS agreement, count(*) AS overlap
            FROM mine m CROSS JOIN LATERAL (
              SELECT x.ml_user, x.rating FROM ml_rating x WHERE x.item_id = m.item_id ORDER BY x.ml_user LIMIT ${PEER_SAMPLE}
            ) r
            GROUP BY r.ml_user HAVING count(*) >= LEAST(3, (SELECT count(*) FROM mine))
            ORDER BY sum(1 - abs(r.rating - m.rating) / 2.25) DESC LIMIT 60
          )
          SELECT r.item_id::int AS item_id, sum(p.agreement * (r.rating - 3.5))::float8 AS strength
          FROM peers p JOIN ml_rating r ON r.ml_user = p.ml_user
          WHERE r.rating >= 4.5 AND p.agreement > 0
            AND NOT EXISTS (SELECT 1 FROM user_item ui WHERE ui.user_id = ${userId}::uuid AND ui.item_id = r.item_id)
          GROUP BY r.item_id HAVING count(*) >= 2
          ORDER BY strength DESC LIMIT 150`.pipe(Effect.orDie)
        void prefs
        return new Map(rows.map((r) => [r.item_id, r.strength]))
      })

      // Sequels/related items and shared creators of things the user liked.
      const links = Effect.fn(function*(userId: UserId, category: Category) {
        return yield* sql<{ item_id: number; via: string; how: string }>`
          WITH liked AS (
            SELECT ui.item_id, i.title FROM user_item ui JOIN item i ON i.id = ui.item_id
            WHERE ui.user_id::text = ${userId} AND i.category = ${category}::category
              AND (ui.rating >= 4 OR (ui.rating IS NULL AND ui.interest = 1))
            ORDER BY ui.updated_at DESC LIMIT 40
          )
          SELECT r.to_item::int AS item_id, l.title AS via,
                 CASE r.kind WHEN 'sequel_of' THEN 'prequel' ELSE 'related' END AS how
          FROM liked l JOIN item_relation r ON r.from_item = l.item_id
          UNION ALL
          SELECT r.from_item::int, l.title, CASE r.kind WHEN 'sequel_of' THEN 'sequel' ELSE 'related' END
          FROM liked l JOIN item_relation r ON r.to_item = l.item_id
          UNION ALL
          SELECT ic2.item_id::int, l.title, 'creator:' || c.name
          FROM liked l JOIN item_creator ic ON ic.item_id = l.item_id
          JOIN creator c ON c.id = ic.creator_id
          JOIN item_creator ic2 ON ic2.creator_id = ic.creator_id AND ic2.item_id <> l.item_id
          LIMIT 300`.pipe(Effect.orDie)
      })

      const fetchCandidates = Effect.fn(function*(ids: ReadonlyArray<number>, taste: string, userId: UserId, category: Category, prefs: Preferences) {
        if (ids.length === 0) return [] as ReadonlyArray<Candidate>
        const filters = filterClause(prefs, category, 5, true)
        return yield* sql.unsafe<Candidate>(
          `WITH ${LIKED}
           SELECT ${SCORED_COLUMNS}
           FROM item i LEFT JOIN item_embedding e ON e.item_id = i.id AND e.model = $3
           WHERE i.id = ANY($5::bigint[]) AND i.category = $2::category
             AND NOT EXISTS (SELECT 1 FROM user_item ui WHERE ui.user_id::text = $1 AND ui.item_id = i.id)
             ${filters.sql}`,
          [userId, category, EMBED_MODEL, taste, ids, ...filters.params]
        ).pipe(Effect.orDie)
      })

      const deck = Effect.fn("Recommender.deck")(function*(userId: UserId, category: Category, limit: number) {
        const prefs = yield* users.preferences(userId)
        const dial = Math.min(Math.max(prefs.dial[category] ?? 0.35, 0), 1)
        const taste = yield* tasteVector(userId, category, prefs)
        if (!taste) return yield* calibration(userId, category, limit)

        const [sim, peer, linkRows] = yield* Effect.all([
          similar(category, taste, prefs, userId),
          neighbours(userId, category, prefs),
          links(userId, category)
        ], { concurrency: 3 })

        const linkInfo = new Map<number, { via: string; how: string }>()
        for (const l of linkRows) if (!linkInfo.has(l.item_id)) linkInfo.set(l.item_id, l)

        const known = new Set(sim.map((c) => c.id))
        const extra = yield* fetchCandidates(
          [...peer.keys(), ...linkInfo.keys()].filter((id) => !known.has(id)),
          taste,
          userId,
          category,
          prefs
        )
        const maxPeer = Math.max(1, ...peer.values())

        const scored = [...sim, ...extra].flatMap((c) => {
          const q = c.quality ?? 0.45
          const link = linkInfo.get(c.id)
          const peerStrength = (peer.get(c.id) ?? 0) / maxPeer
          if (q < QUALITY_FLOOR) return []
          if ((c.thin || c.quality === null) && !peerStrength && !link) return []
          if (link && !peerStrength && q < LINK_QUALITY_FLOOR && c.similarity === null) return []
          const similarity = c.similarity ?? 0.5
          const novelty = 1 - c.popularity
          const gem = novelty * q
          let score = (1 - dial) * similarity + dial * (0.5 * novelty + 0.3 * similarity) + 0.25 * q + 0.15 * gem
          score += 0.25 * (1 - 0.7 * dial) * peerStrength
          if (link && q >= LINK_QUALITY_FLOOR) score += 0.08
          score += dial * 0.15 * Math.random()

          let source: Source = "similar"
          const reasons: Array<string> = []
          if (peerStrength > 0.15) {
            source = "neighbours"
            reasons.push("People who rate like you loved this")
          }
          if (link && q >= LINK_QUALITY_FLOOR) {
            if (source === "similar") source = "link"
            reasons.push(
              link.how.startsWith("creator:") ? `From ${link.how.slice(8)}, like ${link.via}`
              : link.how === "sequel" ? `Sequel to ${link.via}`
              : link.how === "prequel" ? `Comes before ${link.via}`
              : `Connected to ${link.via}`
            )
          }
          if (c.because) reasons.push(`Because you liked ${c.because}`)
          if (gem > 0.45 && c.popularity < 0.5) reasons.push("Hidden gem: few have found it, most who did loved it")
          if (dial > 0.6 && similarity < 0.75 && reasons.length === 0) {
            source = "explore"
            reasons.push(`A detour${c.genres[0] ? ` into ${c.genres[0]}` : ""}`)
          }
          if (reasons.length === 0) reasons.push(c.genres.length ? `Matches your taste in ${c.genres.slice(0, 2).join(" and ")}` : "Matches your taste")
          return [{ c, score, source, reasons }]
        })

        scored.sort((a, b) => b.score - a.score)
        const perCreator = new Map<string, number>()
        const picked: typeof scored = []
        const perLink = new Map<string, number>()
        for (const s of scored) {
          const how = linkInfo.get(s.c.id)?.how
          if (how && s.source === "link") {
            const n = perLink.get(how) ?? 0
            if (n >= MAX_PER_CREATOR) continue
            perLink.set(how, n + 1)
          }
          const lead = s.c.lead
          if (lead) {
            const n = perCreator.get(lead) ?? 0
            if (n >= MAX_PER_CREATOR) continue
            perCreator.set(lead, n + 1)
          }
          picked.push(s)
          if (picked.length >= limit) break
        }
        const rows = yield* sql.unsafe<ItemRow>(`SELECT ${ITEM_COLUMNS} FROM item i WHERE i.id = ANY($1::bigint[])`, [picked.map((s) => s.c.id)])
          .pipe(Effect.orDie)
        const byId = new Map(rows.map((r) => [r.id, r]))
        const on = yield* availability.availableOn(picked.map((s) => s.c.id), prefs.watch)
        return picked.flatMap((s) => {
          const row = byId.get(s.c.id)
          return row
            ? [new Recommendation({ item: toItem(row, false), score: Number(s.score.toFixed(4)), source: s.source, reasons: s.reasons, availableOn: on.get(s.c.id) ?? [] })]
            : []
        })
      })

      // Onboarding deck: alternate popular titles (fast "seen it" coverage) with divisive ones (high taste signal).
      const calibration = Effect.fn("Recommender.calibration")(function*(userId: UserId, category: Category, limit: number) {
        const prefs = yield* users.preferences(userId)
        const genres = prefs.genres[category] ?? []
        const filters = filterClause(prefs, category, 3)
        const rows = yield* sql.unsafe<ItemRow & { kind: string }>(
          `WITH pool AS (
             SELECT i.* FROM item i
             WHERE i.category = $1::category AND ($2::text[] = '{}' OR i.genres && $2::text[])
               AND NOT EXISTS (SELECT 1 FROM user_item ui WHERE ui.user_id::text = $3 AND ui.item_id = i.id)
               ${filters.sql}
           ),
           popular AS (
             SELECT id, 'popular' AS kind, row_number() OVER (ORDER BY popularity DESC) AS n
             FROM pool WHERE COALESCE(quality, 0.5) >= 0.35 ORDER BY popularity DESC LIMIT 80
           ),
           divisive_pool AS (
             SELECT DISTINCT ON (regexp_replace(split_part(lower(title), ':', 1), '[[:space:]]+([0-9]+|[ivx]+)$', '')) id, polarization
             FROM pool
             WHERE polarization >= 0.75 AND popularity >= 0.95 AND quality BETWEEN 0.4 AND 0.97 AND quality_votes >= 40
               AND year IS NOT NULL AND year < EXTRACT(YEAR FROM now())
             ORDER BY regexp_replace(split_part(lower(title), ':', 1), '[[:space:]]+([0-9]+|[ivx]+)$', ''), polarization DESC
           ),
           divisive AS (
             SELECT id, 'divisive' AS kind, row_number() OVER (ORDER BY polarization DESC) AS n
             FROM divisive_pool ORDER BY polarization DESC LIMIT 40
           ),
           mixed AS (
             SELECT id, kind, n * 2 AS ord FROM popular UNION ALL SELECT id, kind, n * 3 + 0.5 FROM divisive
           ),
           ranked AS (SELECT DISTINCT ON (id) id, kind, ord FROM mixed ORDER BY id, ord)
           SELECT ${ITEM_COLUMNS}, r.kind FROM ranked r JOIN item i ON i.id = r.id ORDER BY r.ord LIMIT ${Math.min(limit, 60)}`,
          [category, genres, userId, ...filters.params]
        ).pipe(Effect.orDie)
        return rows.map((r) =>
          new Recommendation({
            item: toItem(r, false),
            score: 0,
            source: "calibration",
            availableOn: [],
            reasons: [r.kind === "divisive" ? "Divisive: people split hard on this one" : category === "book" ? "Most readers have met this one" : "Most people have seen this"]
          })
        )
      })

      return Recommender.of({ deck, calibration })
    })
  ).pipe(Layer.provide(Availability.layer), Layer.provide(Users.layer))
}
