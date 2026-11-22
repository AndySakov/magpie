import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import {
  addExternalIds,
  chunk,
  type CreatorRow,
  dataPath,
  type ExternalIdRow,
  type ItemRow,
  lines,
  linkCreators,
  upsertItems
} from "./lib.ts"

const MIN_VOTES = 300
// Every 4th MovieLens user keeps neighbour search fast while leaving ~50k raters.
const ML_USER_SAMPLE = 4
const ML_MIN_RATINGS_FOR_SPREAD = 300

const TYPES: Record<string, "movie" | "tv"> = { movie: "movie", tvMovie: "movie", tvSeries: "tv", tvMiniSeries: "tv" }

const nullable = (v: string | undefined) => (v === undefined || v === "\\N" ? null : v)

export const ingestScreen = Effect.fn("ingestScreen")(function*() {
  const ratingsPath = yield* dataPath("title.ratings.tsv.gz")
  const basicsPath = yield* dataPath("title.basics.tsv.gz")
  const crewPath = yield* dataPath("title.crew.tsv.gz")
  const namesPath = yield* dataPath("name.basics.tsv.gz")

  const votes = new Map<string, readonly [number, number]>()
  yield* Effect.promise(async () => {
    let first = true
    for await (const l of lines(ratingsPath)) {
      if (first) { first = false; continue }
      const [id, avg, n] = l.split("\t")
      if (id && Number(n) >= MIN_VOTES) votes.set(id, [Number(avg), Number(n)])
    }
  })

  const items: Array<ItemRow> = []
  yield* Effect.promise(async () => {
    let first = true
    for await (const l of lines(basicsPath)) {
      if (first) { first = false; continue }
      const [id, type, primary, original, adult, start, , runtime, genres] = l.split("\t")
      const category = type ? TYPES[type] : undefined
      const v = id ? votes.get(id) : undefined
      if (!id || !category || !v || adult === "1" || !primary) continue
      const minutes = nullable(runtime)
      items.push({
        ext_id: id,
        category,
        title: primary,
        original_title: original && original !== primary ? original : null,
        year: nullable(start) ? Number(start) : null,
        genres: (nullable(genres) ?? "").split(",").filter(Boolean).map((g) => g.toLowerCase()),
        length_value: category === "movie" && minutes ? Number(minutes) : null,
        length_unit: category === "movie" && minutes ? "minutes" : null,
        pop_raw: v[1],
        rating_raw: v[0] / 10,
        votes: v[1],
        meta: { imdb_type: type }
      })
    }
  })
  const kept = new Set(items.map((i) => i.ext_id))
  yield* Effect.log(`imdb: ${items.length} titles with >= ${MIN_VOTES} votes`)

  const crew: Array<{ id: string; person: string; role: string }> = []
  yield* Effect.promise(async () => {
    let first = true
    for await (const l of lines(crewPath)) {
      if (first) { first = false; continue }
      const [id, directors, writers] = l.split("\t")
      if (!id || !kept.has(id)) continue
      for (const d of (nullable(directors) ?? "").split(",").filter(Boolean).slice(0, 3)) crew.push({ id, person: d, role: "director" })
      for (const w of (nullable(writers) ?? "").split(",").filter(Boolean).slice(0, 3)) crew.push({ id, person: w, role: "writer" })
    }
  })
  const wanted = new Set(crew.map((c) => c.person))
  const names = new Map<string, string>()
  yield* Effect.promise(async () => {
    let first = true
    for await (const l of lines(namesPath)) {
      if (first) { first = false; continue }
      const tab = l.indexOf("\t")
      const id = l.slice(0, tab)
      if (!wanted.has(id)) continue
      names.set(id, l.slice(tab + 1, l.indexOf("\t", tab + 1)))
    }
  })
  const creators: Array<CreatorRow> = crew.flatMap((c) => {
    const name = names.get(c.person)
    return name ? [{ ext_id: c.id, creator_source: "imdb", creator_id: c.person, name, role: c.role }] : []
  })

  // MovieLens: IDs, community tags, rating spread, and a sample of raters for neighbour search.
  const mlDir = yield* dataPath("ml-32m")
  const mlToImdb = new Map<string, string>()
  const extIds: Array<ExternalIdRow> = []
  yield* Effect.promise(async () => {
    let first = true
    for await (const l of lines(`${mlDir}/links.csv`)) {
      if (first) { first = false; continue }
      const [ml, imdb, tmdb] = l.split(",")
      if (!ml || !imdb) continue
      const tt = `tt${imdb}`
      if (!kept.has(tt)) continue
      mlToImdb.set(ml, tt)
      extIds.push({ ext_id: tt, source: "movielens", external_id: ml })
      if (tmdb) extIds.push({ ext_id: tt, source: "tmdb_movie", external_id: tmdb })
    }
  })

  const tagCounts = new Map<string, Map<string, number>>()
  yield* Effect.promise(async () => {
    let first = true
    for await (const l of lines(`${mlDir}/tags.csv`)) {
      if (first) { first = false; continue }
      const parts = l.split(",")
      const tt = mlToImdb.get(parts[1] ?? "")
      const tag = parts.slice(2, -1).join(",").replace(/^"|"$/g, "").trim().toLowerCase()
      if (!tt || tag.length < 2 || tag.length > 40) continue
      const m = tagCounts.get(tt) ?? new Map<string, number>()
      m.set(tag, (m.get(tag) ?? 0) + 1)
      tagCounts.set(tt, m)
    }
  })

  const spread = new Map<string, { n: number; sum: number; sq: number }>()
  const sampled: Array<{ u: number; m: string; r: number }> = []
  yield* Effect.promise(async () => {
    let first = true
    for await (const l of lines(`${mlDir}/ratings.csv`)) {
      if (first) { first = false; continue }
      const c1 = l.indexOf(",")
      const c2 = l.indexOf(",", c1 + 1)
      const c3 = l.indexOf(",", c2 + 1)
      const tt = mlToImdb.get(l.slice(c1 + 1, c2))
      if (!tt) continue
      const r = Number(l.slice(c2 + 1, c3))
      const s = spread.get(tt) ?? { n: 0, sum: 0, sq: 0 }
      s.n++; s.sum += r; s.sq += r * r
      spread.set(tt, s)
      const u = Number(l.slice(0, c1))
      if (u % ML_USER_SAMPLE === 0) sampled.push({ u, m: tt, r })
    }
  })

  const enriched = items.map((item) => {
    const tags = [...(tagCounts.get(item.ext_id)?.entries() ?? [])]
      .filter(([, n]) => n >= 2)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20)
      .map(([t]) => t)
    const s = spread.get(item.ext_id)
    const polarization_raw = s && s.n >= ML_MIN_RATINGS_FOR_SPREAD
      ? Math.sqrt(s.sq / s.n - (s.sum / s.n) ** 2) / 5
      : null
    return { ...item, tags, polarization_raw }
  })

  yield* upsertItems("imdb", enriched)
  yield* addExternalIds("imdb", extIds)
  yield* linkCreators("imdb", creators)

  const sql = yield* SqlClient.SqlClient
  yield* sql`TRUNCATE ml_rating`
  for (const batch of chunk(sampled, 20_000)) {
    yield* sql.unsafe(
      `INSERT INTO ml_rating (ml_user, item_id, rating)
       SELECT x.u, e.item_id, x.r FROM jsonb_to_recordset($1::jsonb) AS x(u int, m text, r real)
       JOIN item_external_id e ON e.source = 'imdb' AND e.external_id = x.m
       ON CONFLICT DO NOTHING`,
      [JSON.stringify(batch)]
    )
  }
  yield* Effect.log(`movielens: ${sampled.length} sampled ratings, ${spread.size} titles with spread`)
})
