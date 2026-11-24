import { Effect } from "effect"
import { SqlClient } from "effect/sql"

// AniDB's related-anime lists include character crossovers, which chain unrelated shows together. A related link
// only joins two entries into one series when their titles are this similar (pg_trgm), sequels always do.
const TITLE_SIMILARITY = 0.45

/**
 * Groups anime seasons, OVAs, films and spin-offs into series. Each grouped entry's `series` is the id of the
 * series' first TV entry (any format when it has none), where a newcomer would start. Entries alone stay NULL.
 */
export const groupSeries = Effect.fn("groupSeries")(function*() {
  const sql = yield* SqlClient.SqlClient
  const nodes = yield* sql<{ id: number; tv: boolean; year: number | null; popularity: number; series: number | null; titles: Array<string>; linked: boolean }>`
    SELECT i.id::int AS id, i.meta->>'format' = 'TV' AS tv, i.year, i.popularity, i.series::int AS series,
           array_remove(ARRAY[lower(i.title), lower(i.original_title)], NULL) AS titles,
           EXISTS (SELECT 1 FROM item_relation r WHERE r.from_item = i.id OR r.to_item = i.id) AS linked
    FROM item i WHERE i.category = 'anime'`
  const edges = yield* sql<{ a: number; b: number }>`
    SELECT r.from_item::int AS a, r.to_item::int AS b
    FROM item_relation r
    JOIN item x ON x.id = r.from_item AND x.category = 'anime'
    JOIN item y ON y.id = r.to_item AND y.category = 'anime'
    WHERE r.kind = 'sequel_of'
       OR similarity(lower(coalesce(x.original_title, x.title)), lower(coalesce(y.original_title, y.title))) >= ${TITLE_SIMILARITY}`

  const parent = new Map(nodes.map((n) => [n.id, n.id]))
  const root = (id: number): number => {
    let r = id
    while (parent.get(r) !== r) r = parent.get(r)!
    parent.set(id, r)
    return r
  }
  for (const { a, b } of edges) parent.set(root(a), root(b))

  // Entries known only to AniDB come without relations. An OVA, film or special like that joins the entry whose
  // title it extends by a word or two: "Shingeki no Kyojin OAD" joins "Shingeki no Kyojin".
  const byTitle = new Map<string, number>()
  for (const n of nodes) for (const t of n.titles) if (!byTitle.has(t)) byTitle.set(t, n.id)
  for (const n of nodes) {
    if (n.linked || n.tv) continue
    const match = n.titles.flatMap((t) => {
      const words = t.split(" ")
      return [1, 2].flatMap((drop) => (words.length > drop + 1 ? [byTitle.get(words.slice(0, -drop).join(" "))] : []))
    }).find((id) => id !== undefined && id !== n.id)
    if (match !== undefined) parent.set(root(n.id), root(match))
  }

  const better = (x: (typeof nodes)[number], y: (typeof nodes)[number]) =>
    x.tv !== y.tv
      ? x.tv
      : x.year !== y.year
        ? (x.year ?? Infinity) < (y.year ?? Infinity)
        : x.popularity !== y.popularity
          ? x.popularity > y.popularity
          : x.id < y.id
  const head = new Map<number, (typeof nodes)[number]>()
  const size = new Map<number, number>()
  for (const n of nodes) {
    const r = root(n.id)
    size.set(r, (size.get(r) ?? 0) + 1)
    const h = head.get(r)
    if (!h || better(n, h)) head.set(r, n)
  }

  const changed = nodes.flatMap((n) => {
    const r = root(n.id)
    const series = size.get(r)! > 1 ? head.get(r)!.id : null
    return series === n.series ? [] : [{ id: n.id, series }]
  })
  for (let i = 0; i < changed.length; i += 5000) {
    const chunk = changed.slice(i, i + 5000)
    yield* sql`
      UPDATE item SET series = v.series
      FROM unnest(${chunk.map((c) => c.id)}::bigint[], ${chunk.map((c) => c.series)}::bigint[]) AS v(id, series)
      WHERE item.id = v.id`
  }
  const grouped = [...size.values()].filter((n) => n > 1)
  yield* Effect.log(`series: ${grouped.length} series cover ${grouped.reduce((s, n) => s + n, 0)} anime, ${changed.length} rows changed`)
})
