import type { Category, Item } from "@magpie/contract"
import { Config, Context, Effect, Layer, Option, Redacted, Schema } from "effect"
import { SqlClient } from "effect/sql"
import { BOOK_GENRES, toIso1 } from "./catalog.ts"
import { Embedder } from "./Embedder.ts"
import { ITEM_COLUMNS, type ItemRow, toItem } from "./Items.ts"

type ExternalId = { readonly source: string; readonly externalId: string }
type CreatorRef = ExternalId & { readonly name: string; readonly role: string }

interface Candidate {
  readonly ids: readonly [ExternalId, ...Array<ExternalId>]
  readonly category: Category
  readonly title: string
  readonly originalTitle: string | null
  readonly year: number | null
  readonly synopsis: string | null
  readonly genres: ReadonlyArray<string>
  readonly lengthValue: number | null
  readonly lengthUnit: "minutes" | "episodes" | "pages" | null
  readonly isAdult: boolean
  readonly languages: ReadonlyArray<string>
  readonly imageUrl: string | null
  readonly votes: number
  readonly meta: Record<string, unknown>
  readonly creators: ReadonlyArray<CreatorRef>
}

const CACHE_DAYS = 14
const PER_SOURCE = 8
const TIMEOUT = "4 seconds"
const IMAGE_BASE = "https://image.tmdb.org/t/p"

const TMDB_GENRES: Record<number, ReadonlyArray<string>> = {
  28: ["action"], 12: ["adventure"], 16: ["animation"], 35: ["comedy"], 80: ["crime"], 99: ["documentary"],
  18: ["drama"], 10751: ["family"], 14: ["fantasy"], 36: ["history"], 27: ["horror"], 10402: ["music"],
  9648: ["mystery"], 10749: ["romance"], 878: ["sci-fi"], 53: ["thriller"], 10752: ["war"], 37: ["western"],
  10759: ["action", "adventure"], 10762: ["family"], 10763: ["news"], 10764: ["reality-tv"],
  10765: ["sci-fi", "fantasy"], 10766: ["drama"], 10767: ["talk-show"], 10768: ["war"]
}

const TmdbResult = Schema.Struct({
  id: Schema.Number,
  media_type: Schema.optional(Schema.String),
  title: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String),
  original_title: Schema.optional(Schema.String),
  original_name: Schema.optional(Schema.String),
  release_date: Schema.optional(Schema.String),
  first_air_date: Schema.optional(Schema.String),
  overview: Schema.optional(Schema.String),
  genre_ids: Schema.optional(Schema.Array(Schema.Number)),
  poster_path: Schema.optional(Schema.NullOr(Schema.String)),
  backdrop_path: Schema.optional(Schema.NullOr(Schema.String)),
  original_language: Schema.optional(Schema.String),
  popularity: Schema.optional(Schema.Number),
  vote_average: Schema.optional(Schema.Number),
  vote_count: Schema.optional(Schema.Number),
  adult: Schema.optional(Schema.Boolean)
})
const TmdbPage = Schema.Struct({ results: Schema.Array(TmdbResult) })

const AniListMedia = Schema.Struct({
  id: Schema.Number,
  idMal: Schema.NullOr(Schema.Number),
  title: Schema.Struct({ romaji: Schema.NullOr(Schema.String), english: Schema.NullOr(Schema.String) }),
  startDate: Schema.Struct({ year: Schema.NullOr(Schema.Number) }),
  genres: Schema.Array(Schema.String),
  episodes: Schema.NullOr(Schema.Number),
  format: Schema.NullOr(Schema.String),
  isAdult: Schema.NullOr(Schema.Boolean),
  description: Schema.NullOr(Schema.String),
  averageScore: Schema.NullOr(Schema.Number),
  popularity: Schema.NullOr(Schema.Number),
  coverImage: Schema.Struct({ large: Schema.NullOr(Schema.String) }),
  studios: Schema.Struct({ nodes: Schema.Array(Schema.Struct({ name: Schema.String })) })
})
const AniListPage = Schema.Struct({
  data: Schema.Struct({ Page: Schema.Struct({ media: Schema.Array(AniListMedia) }) })
})
const ANILIST_QUERY = `query ($q: String, $n: Int) { Page(perPage: $n) { media(search: $q, type: ANIME, sort: SEARCH_MATCH) {
  id idMal title { romaji english } startDate { year } genres episodes format isAdult description(asHtml: false)
  averageScore popularity coverImage { large } studios(isMain: true) { nodes { name } } } } }`

const OpenLibraryDoc = Schema.Struct({
  key: Schema.String,
  title: Schema.String,
  author_name: Schema.optional(Schema.Array(Schema.String)),
  author_key: Schema.optional(Schema.Array(Schema.String)),
  first_publish_year: Schema.optional(Schema.Number),
  subject: Schema.optional(Schema.Array(Schema.String)),
  cover_i: Schema.optional(Schema.Number),
  ratings_average: Schema.optional(Schema.Number),
  ratings_count: Schema.optional(Schema.Number),
  readinglog_count: Schema.optional(Schema.Number),
  number_of_pages_median: Schema.optional(Schema.Number),
  language: Schema.optional(Schema.Array(Schema.String)),
  first_sentence: Schema.optional(Schema.Array(Schema.String))
})
const OpenLibraryPage = Schema.Struct({ docs: Schema.Array(OpenLibraryDoc) })
const OPEN_LIBRARY_FIELDS =
  "key,title,author_name,author_key,first_publish_year,subject,cover_i,ratings_average,ratings_count,readinglog_count,number_of_pages_median,language,first_sentence"

const yearOf = (date: string | undefined) => (date && /^\d{4}/.test(date) ? Number(date.slice(0, 4)) : null)
const stripTags = (text: string) => text.replace(/<[^>]+>/g, "").replace(/\s+\n/g, "\n").trim()

const fromTmdb = (r: typeof TmdbResult.Type, category: "movie" | "tv"): Candidate | null => {
  const title = category === "movie" ? r.title : r.name
  if (!title) return null
  const original = category === "movie" ? r.original_title : r.original_name
  return {
    ids: [{ source: `tmdb_${category}`, externalId: String(r.id) }],
    category,
    title,
    originalTitle: original && original !== title ? original : null,
    year: yearOf(category === "movie" ? r.release_date : r.first_air_date),
    synopsis: r.overview || null,
    genres: [...new Set((r.genre_ids ?? []).flatMap((g) => TMDB_GENRES[g] ?? []))],
    lengthValue: null,
    lengthUnit: null,
    isAdult: r.adult ?? false,
    languages: r.original_language ? [r.original_language] : [],
    imageUrl: r.poster_path ? `${IMAGE_BASE}/w500${r.poster_path}` : null,
    votes: r.vote_count ?? 0,
    meta: {
      pop_raw: r.vote_count ?? null,
      rating_raw: r.vote_average && r.vote_count ? r.vote_average / 10 : null,
      ...(r.backdrop_path ? { backdrop_url: `${IMAGE_BASE}/w1280${r.backdrop_path}` } : {})
    },
    creators: []
  }
}

const fromAniList = (m: typeof AniListMedia.Type): Candidate | null => {
  const title = m.title.english ?? m.title.romaji
  if (!title) return null
  return {
    ids: [{ source: "anilist", externalId: String(m.id) }, ...(m.idMal ? [{ source: "mal", externalId: String(m.idMal) }] : [])],
    category: "anime",
    title,
    originalTitle: m.title.romaji && m.title.romaji !== title ? m.title.romaji : null,
    year: m.startDate.year,
    synopsis: m.description ? stripTags(m.description) : null,
    genres: m.genres.map((g) => g.toLowerCase()),
    lengthValue: m.episodes,
    lengthUnit: m.episodes ? "episodes" : null,
    isAdult: m.isAdult ?? false,
    languages: ["ja"],
    imageUrl: m.coverImage.large,
    votes: m.popularity ?? 0,
    meta: { pop_raw: m.popularity, rating_raw: m.averageScore ? m.averageScore / 100 : null, ...(m.format ? { format: m.format } : {}) },
    creators: m.studios.nodes.map((s) => ({ source: "studio", externalId: s.name.toLowerCase(), name: s.name, role: "studio" }))
  }
}

const fromOpenLibrary = (d: typeof OpenLibraryDoc.Type): Candidate | null => {
  if (!d.readinglog_count && !d.ratings_count) return null
  const subjects = d.subject ?? []
  const languages = [...new Set((d.language ?? []).map(toIso1).filter((c): c is string => c !== null))]
  return {
    ids: [{ source: "openlibrary", externalId: d.key.replace("/works/", "") }],
    category: "book",
    title: d.title,
    originalTitle: null,
    year: d.first_publish_year ?? null,
    synopsis: d.first_sentence?.[0] ?? null,
    genres: BOOK_GENRES.filter(([, re]) => subjects.some((s) => re.test(s))).map(([g]) => g),
    lengthValue: d.number_of_pages_median ?? null,
    lengthUnit: d.number_of_pages_median ? "pages" : null,
    isAdult: false,
    languages,
    imageUrl: d.cover_i ? `https://covers.openlibrary.org/b/id/${d.cover_i}-L.jpg` : null,
    votes: d.ratings_count ?? 0,
    meta: { pop_raw: d.readinglog_count ?? null, rating_raw: d.ratings_average ? d.ratings_average / 5 : null },
    creators: (d.author_name ?? []).flatMap((name, i) => {
      const key = d.author_key?.[i]
      return key ? [{ source: "openlibrary", externalId: key, name, role: "author" }] : []
    })
  }
}

const words = (text: string) => new Set(text.toLowerCase().normalize("NFKD").replace(/[^\p{L}\p{N}]+/gu, " ").trim().split(" ").filter(Boolean))

/** Most of the shorter side's words, and a fair share of the longer side's, appear on both. Drops loose matches. */
const overlaps = (title: string, q: string) => {
  const a = words(title)
  const b = words(q)
  if (a.size === 0 || b.size === 0) return false
  let shared = 0
  for (const w of a) if (b.has(w)) shared++
  return shared / Math.min(a.size, b.size) >= 0.6 && shared / Math.max(a.size, b.size) >= 0.25
}

const relevant = (c: Candidate, q: string) => overlaps(c.title, q) || (c.originalTitle !== null && overlaps(c.originalTitle, q))

const matchRank = (title: string, originalTitle: string | null, q: string) => {
  const names = [title, originalTitle ?? ""].map((t) => t.toLowerCase())
  if (names.some((t) => t === q)) return 3
  if (names.some((t) => t.startsWith(q))) return 2
  if (names.some((t) => t.includes(` ${q}`))) return 1
  return 0
}

export class Enrich extends Context.Service<Enrich, {
  /** Looks a query up in the external catalogues and stores anything new. Returns what it found, new or not. */
  search(q: string, category: Category | null, showMature: boolean): Effect.Effect<ReadonlyArray<Item>>
}>()("magpie/Enrich") {
  static readonly layer = Layer.effect(
    Enrich,
    Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient
      const embedder = yield* Embedder
      const token = yield* Config.option(Config.Redacted("TMDB_API_TOKEN"))
      const tmdbSecret = Option.match(token, { onNone: () => "", onSome: (t) => Redacted.value(t).trim() })

      const getJson = <S extends Schema.Top>(schema: S, url: string, init?: RequestInit) =>
        Effect.tryPromise({
          try: (signal) =>
            fetch(url, { ...init, signal }).then((r) => {
              if (!r.ok) throw new Error(`${new URL(url).host} answered ${r.status}`)
              return r.json() as Promise<unknown>
            }),
          catch: (e) => e as Error
        }).pipe(
          Effect.flatMap((json) => Effect.try({ try: () => Schema.decodeUnknownSync(schema as never)(json) as S["Type"], catch: (e) => e as Error })),
          Effect.timeout(TIMEOUT),
          Effect.tapError((e) => Effect.logWarning(`enrich: ${String(e)}`)),
          Effect.option
        )

      const tmdb = (q: string, kind: "movie" | "tv" | "multi") => {
        if (tmdbSecret === "") return Effect.succeed(Option.none<ReadonlyArray<Candidate>>())
        const v3Key = /^[0-9a-f]{32}$/i.test(tmdbSecret)
        const params = new URLSearchParams({ query: q, include_adult: "false", ...(v3Key ? { api_key: tmdbSecret } : {}) })
        const headers: Record<string, string> = v3Key ? { accept: "application/json" } : { accept: "application/json", authorization: `Bearer ${tmdbSecret}` }
        return getJson(TmdbPage, `https://api.themoviedb.org/3/search/${kind}?${params}`, { headers }).pipe(
          Effect.map(Option.map((page) =>
            page.results
              .flatMap((r) => {
                const category = kind === "multi" ? r.media_type : kind
                return category === "movie" || category === "tv" ? [fromTmdb(r, category)] : []
              })
              .filter((c): c is Candidate => c !== null)
              .slice(0, PER_SOURCE)
          ))
        )
      }

      const anilist = (q: string) =>
        getJson(AniListPage, "https://graphql.anilist.co", {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json" },
          body: JSON.stringify({ query: ANILIST_QUERY, variables: { q, n: PER_SOURCE } })
        }).pipe(Effect.map(Option.map((page) => page.data.Page.media.map(fromAniList).filter((c): c is Candidate => c !== null))))

      const openLibrary = (q: string) =>
        getJson(
          OpenLibraryPage,
          `https://openlibrary.org/search.json?${new URLSearchParams({ q, fields: OPEN_LIBRARY_FIELDS, limit: String(PER_SOURCE) })}`,
          { headers: { accept: "application/json", "user-agent": "Magpie/1.0 (friends-only recommendations)" } }
        ).pipe(Effect.map(Option.map((page) => page.docs.map(fromOpenLibrary).filter((c): c is Candidate => c !== null))))

      const lookups = (q: string, category: Category | null) => {
        switch (category) {
          case "movie":
          case "tv":
            return [tmdb(q, category)]
          case "anime":
            return [anilist(q)]
          case "book":
            return [openLibrary(q)]
          case null:
            return [tmdb(q, "multi"), anilist(q), openLibrary(q)]
        }
      }

      const persist = (c: Candidate) =>
        sql.withTransaction(Effect.gen(function*() {
          const [primary] = c.ids
          yield* sql`SELECT pg_advisory_xact_lock(hashtext(${`${primary.source}:${primary.externalId}`}))`
          const ids = JSON.stringify(c.ids)
          const known = yield* sql<{ item_id: number }>`
            SELECT e.item_id::int AS item_id FROM item_external_id e
            JOIN jsonb_to_recordset(${ids}::jsonb) AS x(source text, "externalId" text)
              ON e.source = x.source AND e.external_id = x."externalId"
            LIMIT 1`
          if (known[0]) return { id: known[0].item_id, inserted: false }
          const [inserted] = yield* sql<{ id: number }>`
            INSERT INTO item (category, title, original_title, year, synopsis, genres, length_value, length_unit, is_adult,
                              language, languages, image_url, quality_votes, meta)
            VALUES (${c.category}::category, ${c.title}, ${c.originalTitle}, ${c.year}, ${c.synopsis}, ${c.genres}::text[],
                    ${c.lengthValue}, ${c.lengthUnit}, ${c.isAdult}, ${c.languages[0] ?? null}, ${c.languages}::text[],
                    ${c.imageUrl}, ${c.votes},
                    jsonb_strip_nulls(${JSON.stringify({ ...c.meta, enriched_at: new Date().toISOString() })}::jsonb))
            RETURNING id::int AS id`
          const id = inserted!.id
          yield* sql`
            INSERT INTO item_external_id (source, external_id, item_id)
            SELECT x.source, x."externalId", ${id} FROM jsonb_to_recordset(${ids}::jsonb) AS x(source text, "externalId" text)
            ON CONFLICT DO NOTHING`
          if (c.creators.length > 0) {
            yield* sql`
              WITH input AS (SELECT * FROM jsonb_to_recordset(${JSON.stringify(c.creators)}::jsonb)
                               AS x(source text, "externalId" text, name text, role text)),
              upserted AS (
                INSERT INTO creator (source, external_id, name)
                SELECT DISTINCT source, "externalId", name FROM input
                ON CONFLICT (source, external_id) DO UPDATE SET name = creator.name
                RETURNING id, source, external_id
              )
              INSERT INTO item_creator (item_id, creator_id, role)
              SELECT ${id}, u.id, i.role FROM input i JOIN upserted u ON u.source = i.source AND u.external_id = i."externalId"
              ON CONFLICT DO NOTHING`
          }
          return { id, inserted: true }
        }))

      const search = Effect.fn("Enrich.search")(function*(q: string, category: Category | null, showMature: boolean) {
        const query = q.trim().toLowerCase()
        const key = `${category ?? "all"}:${query}`
        const fresh = yield* sql<{ query: string }>`
          SELECT query FROM search_enrichment WHERE query = ${key} AND searched_at > now() - make_interval(days => ${CACHE_DAYS})`
        if (fresh.length > 0) return []

        const results = yield* Effect.all(lookups(query, category), { concurrency: "unbounded" })
        if (results.every(Option.isNone)) return []
        const candidates = results
          .flatMap((r) => Option.getOrElse(r, () => []))
          .filter((c) => (showMature || !c.isAdult) && relevant(c, query))
          .map((c, order) => ({ c, order, rank: matchRank(c.title, c.originalTitle, query) }))
          .sort((a, b) => b.rank - a.rank || a.order - b.order)

        const persisted = yield* Effect.forEach(candidates, ({ c }) => persist(c), { concurrency: 4 })
        yield* embedder.embedItems(persisted.flatMap((p) => p.inserted ? [p.id] : []))
        const ids = persisted.map((p) => p.id)
        yield* sql`
          INSERT INTO search_enrichment (query) VALUES (${key})
          ON CONFLICT (query) DO UPDATE SET searched_at = now()`
        if (ids.length === 0) return []

        const rows = yield* sql.unsafe<ItemRow>(`SELECT ${ITEM_COLUMNS} FROM item i WHERE i.id = ANY($1::bigint[])`, [ids])
        const byId = new Map(rows.map((r) => [Number(r.id), r]))
        return [...new Set(ids)].flatMap((id) => {
          const row = byId.get(id)
          return row ? [toItem(row, false)] : []
        })
      }, Effect.orDie)

      return Enrich.of({ search })
    })
  )
}
