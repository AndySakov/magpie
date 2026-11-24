import { ItemNotFound, Provider, type ProviderId, Region, type UserId, type WatchSetup, WatchOptions } from "@magpie/contract"
import { Context, Effect, Layer, Result } from "effect"
import { SqlClient } from "effect/sql"
import { type Media, type ProviderEntry, Tmdb } from "./Tmdb.ts"
import { Users } from "./Users.ts"

const LOGO_BASE = "https://image.tmdb.org/t/p/w92"
const REFRESH_DAYS = 7

const toProvider = (p: { readonly id: number; readonly name: string; readonly logo_path: string | null | undefined }) =>
  new Provider({ id: p.id as ProviderId, name: p.name, logoUrl: p.logo_path ? `${LOGO_BASE}${p.logo_path}` : null })

const fromEntry = (p: ProviderEntry) => toProvider({ id: p.provider_id, name: p.provider_name, logo_path: p.logo_path })

/** Filters on the user's services only when they asked for it and the setup is complete. */
export const servicesFilter = (watch: WatchSetup) =>
  watch.onlyMine && watch.region !== null && watch.services.length > 0
    ? { region: watch.region, services: watch.services as ReadonlyArray<number> }
    : null

export class Availability extends Context.Service<Availability, {
  readonly regions: Effect.Effect<ReadonlyArray<Region>>
  providers(region: string): Effect.Effect<ReadonlyArray<Provider>>
  options(userId: UserId, itemId: number): Effect.Effect<WatchOptions | null, ItemNotFound>
  /** Which of the user's services carry each item, from the last sweep. */
  availableOn(itemIds: ReadonlyArray<number>, watch: WatchSetup): Effect.Effect<ReadonlyMap<number, ReadonlyArray<Provider>>>
  /**
   * Advances the availability sweep by at most `budget` TMDB requests. Covers every (region, provider) some user
   * subscribes to and refreshes each weekly. Resumable: progress is stored per (region, provider, media).
   */
  sweep(budget: number): Effect.Effect<{ readonly requests: number; readonly finished: number }>
}>()("magpie/Availability") {
  static readonly layer = Layer.effect(
    Availability,
    Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient
      const tmdb = yield* Tmdb
      const users = yield* Users

      const regions = tmdb.regions.pipe(
        Effect.map((rs) => rs.map((r) => new Region(r))),
        Effect.orDie
      )

      const providers = Effect.fn("Availability.providers")(function*(region: string) {
        const entries = yield* tmdb.providers(region).pipe(Effect.orDie)
        if (entries.length > 0) {
          yield* sql`
            INSERT INTO watch_provider (id, name, logo_path)
            SELECT * FROM unnest(${entries.map((p) => p.provider_id)}::int[], ${entries.map((p) => p.provider_name)}::text[],
                                 ${entries.map((p) => p.logo_path ?? null)}::text[])
            ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, logo_path = EXCLUDED.logo_path`.pipe(Effect.orDie)
        }
        return entries.map(fromEntry)
      })

      const options = Effect.fn("Availability.options")(function*(userId: UserId, itemId: number) {
        const rows = yield* sql<{ category: string; tmdb: string | null }>`
          SELECT i.category::text AS category, x.external_id AS tmdb FROM item i
          LEFT JOIN item_external_id x ON x.item_id = i.id AND x.source = 'tmdb_' || i.category::text
          WHERE i.id = ${itemId}`.pipe(Effect.orDie)
        const row = rows[0]
        if (!row) return yield* new ItemNotFound()
        const prefs = yield* users.preferences(userId).pipe(Effect.orDie)
        const region = prefs.watch.region
        if (region === null || row.tmdb === null || (row.category !== "movie" && row.category !== "tv")) return null
        const all = yield* tmdb.offers(row.category, row.tmdb).pipe(Effect.orDie)
        const here = all[region]
        const list = (xs: ReadonlyArray<ProviderEntry> | undefined) => (xs ?? []).map(fromEntry)
        const free = [...list(here?.free), ...list(here?.ads)]
        return new WatchOptions({
          region,
          link: here?.link ?? null,
          stream: list(here?.flatrate),
          free: free.filter((p, i) => free.findIndex((q) => q.id === p.id) === i),
          rent: list(here?.rent),
          buy: list(here?.buy)
        })
      })

      const availableOn = Effect.fn("Availability.availableOn")(function*(itemIds: ReadonlyArray<number>, watch: WatchSetup) {
        const out = new Map<number, Array<Provider>>()
        if (watch.region === null || watch.services.length === 0 || itemIds.length === 0) return out
        const rows = yield* sql<{ item_id: number; id: number; name: string; logo_path: string | null }>`
          SELECT a.item_id::int AS item_id, p.id, p.name, p.logo_path
          FROM item_availability a JOIN watch_provider p ON p.id = a.provider_id
          WHERE a.item_id = ANY(${itemIds}::bigint[]) AND a.region = ${watch.region}
            AND a.provider_id = ANY(${watch.services}::int[])
          ORDER BY array_position(${watch.services}::int[], a.provider_id)`.pipe(Effect.orDie)
        for (const r of rows) out.set(r.item_id, [...(out.get(r.item_id) ?? []), toProvider(r)])
        return out
      })

      // Keeps one sweep row per wanted (region, provider, media) and drops availability nobody needs any more.
      const WANTED = `wanted AS (
        SELECT DISTINCT u.preferences->'watch'->>'region' AS region, s.value::int AS provider_id
        FROM app_user u, jsonb_array_elements_text(COALESCE(u.preferences->'watch'->'services', '[]')) s
        WHERE u.preferences->'watch'->>'region' IS NOT NULL
      )`
      const syncTargets = sql.withTransaction(Effect.all([
        sql.unsafe(`WITH ${WANTED}
          INSERT INTO availability_sweep (region, provider_id, media)
          SELECT w.region, w.provider_id, m.media FROM wanted w CROSS JOIN (VALUES ('movie'), ('tv')) m (media)
          ON CONFLICT DO NOTHING`),
        sql.unsafe(`WITH ${WANTED} DELETE FROM availability_sweep s
          WHERE NOT EXISTS (SELECT 1 FROM wanted w WHERE w.region = s.region AND w.provider_id = s.provider_id)`),
        sql.unsafe(`WITH ${WANTED} DELETE FROM item_availability a
          WHERE NOT EXISTS (SELECT 1 FROM wanted w WHERE w.region = a.region AND w.provider_id = a.provider_id)`)
      ], { discard: true }))

      const nextTarget = (skip: ReadonlyArray<string>) => sql<{ region: string; provider_id: number; media: Media; next_page: number | null }>`
        SELECT region, provider_id, media, next_page FROM availability_sweep
        WHERE (next_page IS NOT NULL OR finished_at IS NULL OR finished_at < now() - make_interval(days => ${REFRESH_DAYS}))
          AND region || '/' || provider_id || '/' || media <> ALL(${skip}::text[])
        ORDER BY next_page IS NULL, finished_at NULLS FIRST
        LIMIT 1`

      const sweep = Effect.fn("Availability.sweep")(function*(budget: number) {
        yield* syncTargets
        let requests = 0
        let finished = 0
        // Targets that failed this run. Skipping them keeps one bad list from holding up every other service.
        const failed: Array<string> = []
        while (requests < budget) {
          const [target] = yield* nextTarget(failed)
          if (!target) break
          const { region, provider_id: provider, media } = target
          const key = `${region}/${provider}/${media}`
          let page = target.next_page ?? 1
          if (target.next_page === null) {
            yield* sql`UPDATE availability_sweep SET next_page = 1, started_at = now()
                       WHERE region = ${region} AND provider_id = ${provider} AND media = ${media}`
          }
          while (requests < budget) {
            requests++
            const fetched = yield* Effect.result(tmdb.discover(media, region, provider, page))
            if (Result.isFailure(fetched)) {
              yield* Effect.logWarning(`availability sweep skipped ${key} at page ${page}: ${fetched.failure.message}`)
              failed.push(key)
              break
            }
            const result = fetched.success
            // Store the matches and record progress in one statement, so a failure on the next page resumes here.
            const store = sql`
              WITH stored AS (
                INSERT INTO item_availability (region, provider_id, item_id, seen_at)
                SELECT ${region}, ${provider}, x.item_id, now() FROM item_external_id x
                WHERE x.source = ${`tmdb_${media}`} AND x.external_id = ANY(${result.ids.map(String)}::text[])
                ON CONFLICT (region, provider_id, item_id) DO UPDATE SET seen_at = EXCLUDED.seen_at
                RETURNING 1
              )
              UPDATE availability_sweep SET next_page = ${page + 1}
              WHERE region = ${region} AND provider_id = ${provider} AND media = ${media}`
            if (page < result.totalPages) {
              yield* store
              page++
              continue
            }
            // The last page and the finish commit together: a stored page past the end would be requested forever.
            yield* sql.withTransaction(Effect.all([
              store,
              sql`
                DELETE FROM item_availability a USING item i, availability_sweep s
                WHERE a.item_id = i.id AND i.category = ${media}::category
                  AND s.region = ${region} AND s.provider_id = ${provider} AND s.media = ${media}
                  AND a.region = s.region AND a.provider_id = s.provider_id AND a.seen_at < s.started_at`,
              sql`UPDATE availability_sweep SET next_page = NULL, finished_at = now()
                  WHERE region = ${region} AND provider_id = ${provider} AND media = ${media}`
            ], { discard: true }))
            finished++
            break
          }
        }
        return { requests, finished }
      }, Effect.orDie)

      return Availability.of({ regions, providers, options, availableOn, sweep })
    })
  ).pipe(Layer.provide(Users.layer))
}
