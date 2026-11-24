import { Config, Context, Data, Effect, Layer, Option, Redacted, Schema } from "effect"

export class TmdbError extends Data.TaggedError("TmdbError")<{ readonly message: string }> {}

export type Media = "movie" | "tv"

const ProviderEntry = Schema.Struct({
  provider_id: Schema.Number,
  provider_name: Schema.String,
  logo_path: Schema.optional(Schema.NullOr(Schema.String)),
  display_priority: Schema.optional(Schema.Number),
  display_priorities: Schema.optional(Schema.Record(Schema.String, Schema.NullOr(Schema.Number)))
})

const RegionOffers = Schema.Struct({
  link: Schema.optional(Schema.String),
  flatrate: Schema.optional(Schema.Array(ProviderEntry)),
  free: Schema.optional(Schema.Array(ProviderEntry)),
  ads: Schema.optional(Schema.Array(ProviderEntry)),
  rent: Schema.optional(Schema.Array(ProviderEntry)),
  buy: Schema.optional(Schema.Array(ProviderEntry))
})
export type RegionOffers = typeof RegionOffers.Type
export type ProviderEntry = typeof ProviderEntry.Type

const Regions = Schema.Struct({ results: Schema.Array(Schema.Struct({ iso_3166_1: Schema.String, english_name: Schema.String })) })
const Providers = Schema.Struct({ results: Schema.Array(ProviderEntry) })
const ItemProviders = Schema.Struct({ results: Schema.Record(Schema.String, RegionOffers) })
const Discover = Schema.Struct({ total_pages: Schema.Number, results: Schema.Array(Schema.Struct({ id: Schema.Number })) })

const HOUR = 3600
const DAY = 24 * HOUR

interface EdgeCache {
  match(key: string): Promise<Response | undefined>
  put(key: string, response: Response): Promise<void>
}

/**
 * Lookups that change slowly go through the Workers cache, keyed without the API key. Under Node there is no
 * `caches.default`, so every call goes to TMDB.
 */
const cached = async (key: string, ttlSeconds: number, load: () => Promise<string>): Promise<string> => {
  const edge = (globalThis as { caches?: { default?: EdgeCache } }).caches?.default
  const url = `https://tmdb.cache.magpie/${key}`
  const hit = await edge?.match(url)
  if (hit) return hit.text()
  const body = await load()
  await edge?.put(url, new Response(body, { headers: { "content-type": "application/json", "cache-control": `max-age=${ttlSeconds}` } }))
  return body
}

// TMDB rejects pages past 500 on discover.
export const MAX_DISCOVER_PAGE = 500

export class Tmdb extends Context.Service<Tmdb, {
  readonly regions: Effect.Effect<ReadonlyArray<{ readonly code: string; readonly name: string }>, TmdbError>
  /** Movie and TV providers for a region, most prominent first. */
  providers(region: string): Effect.Effect<ReadonlyArray<ProviderEntry>, TmdbError>
  /** Offers per region for one title. Empty when TMDB has none. */
  offers(media: Media, tmdbId: string): Effect.Effect<Readonly<Record<string, RegionOffers>>, TmdbError>
  /** One page of titles streaming (subscription, free or ads) on a provider in a region, most popular first. */
  discover(media: Media, region: string, providerId: number, page: number): Effect.Effect<{ readonly totalPages: number; readonly ids: ReadonlyArray<number> }, TmdbError>
}>()("magpie/Tmdb") {
  static readonly layer = Layer.effect(
    Tmdb,
    Effect.gen(function*() {
      const token = yield* Config.option(Config.Redacted("TMDB_API_TOKEN"))
      const secret = Option.match(token, { onNone: () => "", onSome: (t) => Redacted.value(t).trim() })
      const v3Key = /^[0-9a-f]{32}$/i.test(secret)

      const get = <S extends Schema.Top>(schema: S, path: string, params: Record<string, string> = {}, ttlSeconds = 0) => {
        if (secret === "") return Effect.fail(new TmdbError({ message: "TMDB_API_TOKEN is not set" }))
        const query = new URLSearchParams({ ...params, ...(v3Key ? { api_key: secret } : {}) })
        const headers: Record<string, string> = v3Key ? { accept: "application/json" } : { accept: "application/json", authorization: `Bearer ${secret}` }
        const load = async () => {
          const r = await fetch(`https://api.themoviedb.org/3${path}?${query}`, { headers, signal: AbortSignal.timeout(8000) })
          if (!r.ok) throw new Error(`TMDB ${r.status} on ${path}`)
          return r.text()
        }
        return Effect.tryPromise({
          try: async () => JSON.parse(await (ttlSeconds > 0 ? cached(`${path}?${new URLSearchParams(params)}`, ttlSeconds, load) : load())) as unknown,
          catch: (e) => new TmdbError({ message: e instanceof Error ? e.message : String(e) })
        }).pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(schema)),
          Effect.mapError((e) => (e instanceof TmdbError ? e : new TmdbError({ message: `Unexpected TMDB response on ${path}` })))
        ) as Effect.Effect<S["Type"], TmdbError>
      }

      const regions = get(Regions, "/watch/providers/regions", {}, DAY).pipe(
        Effect.map((r) => r.results.map((x) => ({ code: x.iso_3166_1, name: x.english_name })).sort((a, b) => a.name.localeCompare(b.name)))
      )

      const providers = (region: string) =>
        Effect.all([
          get(Providers, "/watch/providers/movie", { watch_region: region }, DAY),
          get(Providers, "/watch/providers/tv", { watch_region: region }, DAY)
        ], { concurrency: 2 }).pipe(
          Effect.map(([movie, tv]) => {
            const byId = new Map<number, ProviderEntry>()
            for (const p of [...movie.results, ...tv.results]) if (!byId.has(p.provider_id)) byId.set(p.provider_id, p)
            const rank = (p: ProviderEntry) => p.display_priorities?.[region] ?? p.display_priority ?? Number.MAX_SAFE_INTEGER
            return [...byId.values()].sort((a, b) => rank(a) - rank(b))
          })
        )

      const offers = (media: Media, tmdbId: string) =>
        get(ItemProviders, `/${media}/${tmdbId}/watch/providers`, {}, 6 * HOUR).pipe(Effect.map((r) => r.results))

      const discover = (media: Media, region: string, providerId: number, page: number) =>
        get(Discover, `/discover/${media}`, {
          watch_region: region,
          with_watch_providers: String(providerId),
          with_watch_monetization_types: "flatrate|free|ads",
          sort_by: "popularity.desc",
          page: String(page)
        }).pipe(Effect.map((r) => ({ totalPages: Math.min(r.total_pages, MAX_DISCOVER_PAGE), ids: r.results.map((x) => x.id) })))

      return Tmdb.of({ regions, providers, offers, discover })
    })
  )
}
