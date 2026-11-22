import { Effect, Schema } from "effect"
import { existsSync } from "node:fs"
import { readFile, writeFile } from "node:fs/promises"
import {
  addExternalIds,
  type CreatorRow,
  dataPath,
  type ExternalIdRow,
  type ItemRow,
  lines,
  linkCreators,
  linkRelations,
  type RelationRow,
  sleep,
  upsertItems
} from "./lib.ts"

const ANILIST_GENRES = new Set([
  "action", "adventure", "comedy", "drama", "ecchi", "fantasy", "horror", "mahou shoujo", "mecha", "music",
  "mystery", "psychological", "romance", "sci-fi", "slice of life", "sports", "supernatural", "thriller"
])

const AodEntry = Schema.Struct({
  sources: Schema.Array(Schema.String),
  title: Schema.String,
  type: Schema.String,
  episodes: Schema.Number,
  status: Schema.String,
  animeSeason: Schema.Struct({ year: Schema.optional(Schema.Number) }),
  picture: Schema.optional(Schema.String),
  score: Schema.optional(Schema.Struct({ arithmeticMean: Schema.Number })),
  studios: Schema.optional(Schema.Array(Schema.String)),
  relatedAnime: Schema.optional(Schema.Array(Schema.String)),
  tags: Schema.optional(Schema.Array(Schema.String))
})
type AodEntry = typeof AodEntry.Type

const AniListMedia = Schema.Struct({
  id: Schema.Number,
  idMal: Schema.NullOr(Schema.Number),
  title: Schema.Struct({ romaji: Schema.NullOr(Schema.String), english: Schema.NullOr(Schema.String) }),
  description: Schema.NullOr(Schema.String),
  genres: Schema.Array(Schema.String),
  averageScore: Schema.NullOr(Schema.Number),
  popularity: Schema.NullOr(Schema.Number),
  isAdult: Schema.Boolean,
  episodes: Schema.NullOr(Schema.Number),
  seasonYear: Schema.NullOr(Schema.Number),
  coverImage: Schema.Struct({ large: Schema.NullOr(Schema.String) }),
  stats: Schema.NullOr(Schema.Struct({
    scoreDistribution: Schema.NullOr(Schema.Array(Schema.Struct({ score: Schema.Number, amount: Schema.Number })))
  })),
  studios: Schema.Struct({ nodes: Schema.Array(Schema.Struct({ id: Schema.Number, name: Schema.String })) }),
  relations: Schema.Struct({
    edges: Schema.Array(Schema.Struct({
      relationType: Schema.String,
      node: Schema.Struct({ id: Schema.Number, type: Schema.String })
    }))
  })
})
type AniListMedia = typeof AniListMedia.Type

const QUERY = `query ($page: Int) { Page(page: $page, perPage: 50) { media(type: ANIME, sort: POPULARITY_DESC) {
  id idMal title { romaji english } description(asHtml: false) genres averageScore popularity isAdult episodes seasonYear
  coverImage { large } stats { scoreDistribution { score amount } }
  studios(isMain: true) { nodes { id name } }
  relations { edges { relationType node { id type } } }
} } }`

const fetchAniListTop = Effect.fn("fetchAniListTop")(function*() {
  const cache = yield* dataPath("anilist_top.json")
  if (existsSync(cache)) {
    const raw = yield* Effect.promise(() => readFile(cache, "utf8"))
    return yield* Schema.decodeUnknownEffect(Schema.Array(AniListMedia))(JSON.parse(raw))
  }
  const all: Array<unknown> = []
  for (let page = 1; page <= 100; page++) {
    const body = yield* Effect.tryPromise(() =>
      fetch("https://graphql.anilist.co", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ query: QUERY, variables: { page } })
      }).then(async (r) => {
        if (r.status === 429) throw new Error("rate limited")
        if (!r.ok) throw new Error(`AniList ${r.status}`)
        return r.json() as Promise<{ data: { Page: { media: Array<unknown> } } }>
      })
    ).pipe(Effect.tapError((e) => Effect.log(`AniList page ${page}: ${e}, backing off`).pipe(Effect.andThen(sleep(60_000)))), Effect.retry({ times: 5 }))
    all.push(...body.data.Page.media)
    if (page % 10 === 0) yield* Effect.log(`AniList: ${all.length} titles`)
    yield* sleep(2_200)
  }
  yield* Effect.promise(() => writeFile(cache, JSON.stringify(all)))
  return yield* Schema.decodeUnknownEffect(Schema.Array(AniListMedia))(all)
})

const SOURCE_PATTERNS: ReadonlyArray<readonly [string, RegExp]> = [
  ["anilist", /anilist\.co\/anime\/(\d+)/],
  ["mal", /myanimelist\.net\/anime\/(\d+)/],
  ["kitsu", /kitsu\.(?:app|io)\/anime\/(\d+)/],
  ["anidb", /anidb\.net\/anime\/(\d+)/]
]

const parseSources = (urls: ReadonlyArray<string>) => {
  const ids: Record<string, string> = {}
  for (const url of urls) {
    for (const [source, re] of SOURCE_PATTERNS) {
      const m = url.match(re)
      if (m?.[1] && !ids[source]) ids[source] = m[1]
    }
  }
  return ids
}

const primaryKey = (ids: Record<string, string>) =>
  ids.anilist ? `anilist:${ids.anilist}` : ids.mal ? `mal:${ids.mal}` : ids.kitsu ? `kitsu:${ids.kitsu}` : ids.anidb ? `anidb:${ids.anidb}` : null

const stripHtml = (s: string) => s.replace(/<br\s*\/?>/g, "\n").replace(/<[^>]+>/g, "").replace(/\n{3,}/g, "\n\n").trim()

const stddev = (dist: ReadonlyArray<{ score: number; amount: number }>) => {
  const n = dist.reduce((a, d) => a + d.amount, 0)
  if (n < 50) return null
  const mean = dist.reduce((a, d) => a + d.score * d.amount, 0) / n
  return Math.sqrt(dist.reduce((a, d) => a + d.amount * (d.score - mean) ** 2, 0) / n) / 100
}

export const ingestAnime = Effect.fn("ingestAnime")(function*() {
  const top = yield* fetchAniListTop()
  const byAniList = new Map<number, AniListMedia>(top.map((m) => [m.id, m]))

  const decode = Schema.decodeUnknownSync(AodEntry)
  const entries: Array<{ key: string; ids: Record<string, string>; aod: AodEntry }> = []
  const path = yield* dataPath("aod.jsonl")
  yield* Effect.promise(async () => {
    let first = true
    for await (const line of lines(path)) {
      if (first) { first = false; continue }
      if (!line) continue
      const aod = decode(JSON.parse(line))
      const ids = parseSources(aod.sources)
      const key = primaryKey(ids)
      const inTop = ids.anilist !== undefined && byAniList.has(Number(ids.anilist))
      const keepType = ["TV", "MOVIE", "ONA", "OVA"].includes(aod.type)
      if (key && (inTop || (keepType && aod.status !== "UPCOMING"))) entries.push({ key, ids, aod })
    }
  })

  const items: Array<ItemRow> = []
  const extIds: Array<ExternalIdRow> = []
  const creators: Array<CreatorRow> = []
  const relations: Array<RelationRow> = []

  for (const { key, ids, aod } of entries) {
    const al = ids.anilist ? byAniList.get(Number(ids.anilist)) : undefined
    const tags = (aod.tags ?? []).slice(0, 25)
    const genres = al ? al.genres.map((g) => g.toLowerCase()) : tags.filter((t) => ANILIST_GENRES.has(t))
    items.push({
      ext_id: key,
      category: "anime",
      title: al?.title.english ?? al?.title.romaji ?? aod.title,
      original_title: al?.title.romaji ?? aod.title,
      year: al?.seasonYear ?? aod.animeSeason.year ?? null,
      synopsis: al?.description ? stripHtml(al.description) : null,
      genres,
      tags,
      length_value: al?.episodes ?? (aod.episodes > 0 ? aod.episodes : null),
      length_unit: "episodes",
      is_adult: al?.isAdult ?? tags.includes("hentai"),
      language: "ja",
      image_url: al?.coverImage.large ?? aod.picture ?? null,
      pop_raw: al?.popularity ?? null,
      rating_raw: al?.averageScore != null ? al.averageScore / 100 : aod.score ? aod.score.arithmeticMean / 10 : null,
      votes: al?.popularity ?? 0,
      polarization_raw: al?.stats?.scoreDistribution ? stddev(al.stats.scoreDistribution) : null,
      meta: { format: aod.type }
    })
    for (const [source, id] of Object.entries(ids)) extIds.push({ ext_id: key, source, external_id: id })
    const studios = al ? al.studios.nodes.map((s) => s.name) : (aod.studios ?? [])
    for (const name of studios.slice(0, 3)) {
      creators.push({ ext_id: key, creator_source: "studio", creator_id: name.toLowerCase(), name, role: "studio" })
    }
    if (al) {
      for (const edge of al.relations.edges) {
        if (edge.node.type !== "ANIME") continue
        const other = String(edge.node.id)
        if (edge.relationType === "SEQUEL") {
          relations.push({ from_source: "anilist", from_id: other, to_source: "anilist", to_id: String(al.id), kind: "sequel_of" })
        } else if (["SIDE_STORY", "SPIN_OFF", "ALTERNATIVE", "PARENT", "SUMMARY"].includes(edge.relationType)) {
          relations.push({ from_source: "anilist", from_id: String(al.id), to_source: "anilist", to_id: other, kind: "related" })
        }
      }
    }
    for (const url of aod.relatedAnime ?? []) {
      const related = parseSources([url])
      const target = related.anilist ? ["anilist", related.anilist] : related.mal ? ["mal", related.mal] : null
      if (target) relations.push({ from_source: "aod", from_id: key, to_source: target[0]!, to_id: target[1]!, kind: "related" })
    }
  }

  yield* upsertItems("aod", items)
  yield* addExternalIds("aod", extIds)
  yield* linkCreators("aod", creators)
  yield* linkRelations(relations)
  yield* Effect.log(`anime: ${items.length} items, ${relations.length} relations`)
})
