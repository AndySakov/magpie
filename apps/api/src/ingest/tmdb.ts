import { Config, Effect, Option, Redacted } from "effect"
import { SqlClient } from "effect/sql"
import { EMBED_MODEL } from "../catalog.ts"

const TOP_N = 40_000
const CONCURRENCY = 16
const IMAGE_BASE = "https://image.tmdb.org/t/p"

interface Target {
  readonly id: number
  readonly category: "movie" | "tv"
  readonly imdb: string
  readonly tmdb: string | null
}

interface Details {
  readonly id: number
  readonly overview?: string
  readonly poster_path?: string | null
  readonly backdrop_path?: string | null
  readonly number_of_episodes?: number
  readonly original_language?: string
  readonly videos?: { results: Array<{ site: string; type: string; key: string; official: boolean }> }
}

// Fills synopsis, poster, backdrop, trailer and TV episode counts for the most popular movies/TV.
// Skips silently without TMDB_API_TOKEN. Re-embeds items whose synopsis changed.
export const ingestTmdb = Effect.fn("ingestTmdb")(function*() {
  const token = yield* Config.option(Config.Redacted("TMDB_API_TOKEN"))
  if (Option.isNone(token) || Redacted.value(token.value).length === 0) {
    return yield* Effect.log("tmdb: TMDB_API_TOKEN not set, skipping")
  }
  const secret = Redacted.value(token.value).trim()
  const v3Key = /^[0-9a-f]{32}$/i.test(secret)
  const headers: Record<string, string> = v3Key
    ? { accept: "application/json" }
    : { authorization: `Bearer ${secret}`, accept: "application/json" }
  const url = (path: string) =>
    `https://api.themoviedb.org/3${path}${v3Key ? `${path.includes("?") ? "&" : "?"}api_key=${secret}` : ""}`
  const get = (path: string) =>
    Effect.tryPromise(() =>
      fetch(url(path), { headers }).then(async (r) => {
        if (r.status === 429) throw new Error("rate limited")
        if (r.status === 404) return null
        if (!r.ok) throw new Error(`TMDB ${r.status}`)
        return r.json() as Promise<unknown>
      })
    ).pipe(Effect.retry({ times: 4 }), Effect.orElseSucceed(() => null))

  const sql = yield* SqlClient.SqlClient
  const targets = yield* sql<Target>`
    SELECT i.id::int AS id, i.category::text AS category, imdb.external_id AS imdb,
           (SELECT external_id FROM item_external_id t WHERE t.item_id = i.id AND t.source = 'tmdb_' || i.category::text) AS tmdb
    FROM item i JOIN item_external_id imdb ON imdb.item_id = i.id AND imdb.source = 'imdb'
    WHERE i.category IN ('movie', 'tv') AND NOT (i.meta ? 'tmdb_checked')
    ORDER BY i.popularity DESC LIMIT ${TOP_N}`

  let done = 0
  yield* Effect.forEach(targets, (t) =>
    Effect.gen(function*() {
      let tmdbId = t.tmdb
      if (!tmdbId) {
        const found = (yield* get(`/find/${t.imdb}?external_source=imdb_id`)) as
          | { movie_results?: Array<{ id: number }>; tv_results?: Array<{ id: number }> }
          | null
        const hit = t.category === "movie" ? found?.movie_results?.[0] : found?.tv_results?.[0]
        tmdbId = hit ? String(hit.id) : null
      }
      const details = tmdbId
        ? ((yield* get(`/${t.category}/${tmdbId}?append_to_response=videos`)) as Details | null)
        : null
      const trailer = details?.videos?.results.find((v) => v.site === "YouTube" && v.type === "Trailer" && v.official)
        ?? details?.videos?.results.find((v) => v.site === "YouTube" && v.type === "Trailer")
      const meta = {
        tmdb_checked: true,
        ...(details?.backdrop_path ? { backdrop_url: `${IMAGE_BASE}/w1280${details.backdrop_path}` } : {}),
        ...(trailer ? { trailer_youtube: trailer.key } : {})
      }
      yield* sql`
        UPDATE item SET
          synopsis = COALESCE(NULLIF(${details?.overview ?? null}, ''), synopsis),
          image_url = COALESCE(${details?.poster_path ? `${IMAGE_BASE}/w500${details.poster_path}` : null}, image_url),
          language = COALESCE(${details?.original_language ?? null}, language),
          length_value = CASE WHEN category = 'tv' THEN COALESCE(${details?.number_of_episodes ?? null}, length_value) ELSE length_value END,
          length_unit = CASE WHEN category = 'tv' AND ${details?.number_of_episodes ?? null}::int IS NOT NULL THEN 'episodes' ELSE length_unit END,
          meta = meta || ${JSON.stringify(meta)}::jsonb
        WHERE id = ${t.id}`
      if (tmdbId) {
        yield* sql`INSERT INTO item_external_id (source, external_id, item_id) VALUES (${`tmdb_${t.category}`}, ${tmdbId}, ${t.id}) ON CONFLICT DO NOTHING`
      }
      if (details?.overview) yield* sql`DELETE FROM item_embedding WHERE item_id = ${t.id} AND model = ${EMBED_MODEL}`
      done++
      if (done % 1000 === 0) yield* Effect.log(`tmdb: ${done}/${targets.length}`)
    }), { concurrency: CONCURRENCY, discard: true })
  yield* Effect.log(`tmdb: enriched ${done} titles. Run the embed step to refresh changed embeddings.`)
})
