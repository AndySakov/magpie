import { ImportResult, TraktFailed, TraktStatus, type UserId } from "@magpie/contract"
import { Context, Effect, Layer, Result, Schema } from "effect"
import { SqlClient } from "effect/sql"
import { type ImportRow, Imports } from "./Imports.ts"
import { Meter, TraktApi, type TraktError, type Tokens } from "./TraktApi.ts"

const SOURCE = "trakt"
// Refresh a day early: access tokens last 7 days and the cron only checks hourly.
const REFRESH_MARGIN_MS = 86_400_000
const OAUTH_TTL = "15 minutes"
// What a usual sync needs: last activities, a token refresh, and a page of each list. The cron only starts a user with this
// much budget left. A bigger sync stops at the budget and fails, and the user goes to the back of the queue.
const PER_USER_RESERVE = 12
// Workers allow 50 subrequests per request. Leave a few for everything that isn't Trakt.
const REQUEST_BUDGET = 45

const Ids = Schema.Struct({
  trakt: Schema.Number,
  imdb: Schema.optional(Schema.NullOr(Schema.String)),
  tmdb: Schema.optional(Schema.NullOr(Schema.Number))
})
const Media = Schema.Struct({
  title: Schema.NullOr(Schema.String),
  year: Schema.NullOr(Schema.Number),
  ids: Ids,
  aired_episodes: Schema.optional(Schema.NullOr(Schema.Number)),
  status: Schema.optional(Schema.NullOr(Schema.String))
})
type Media = typeof Media.Type

const WatchedMovies = Schema.Array(Schema.Struct({ last_watched_at: Schema.String, movie: Media }))
const WatchedShows = Schema.Array(Schema.Struct({
  // Episode plays across the show. Trakt no longer sends per-episode seasons here, so rewatches count twice.
  plays: Schema.Number,
  last_watched_at: Schema.String,
  show: Media
}))
const Ratings = Schema.Array(Schema.Struct({
  rated_at: Schema.String,
  rating: Schema.Number,
  movie: Schema.optional(Media),
  show: Schema.optional(Media)
}))
const Watchlist = Schema.Array(Schema.Struct({ listed_at: Schema.String, movie: Schema.optional(Media), show: Schema.optional(Media) }))
const Settings = Schema.Struct({ user: Schema.Struct({ username: Schema.String }) })

export interface TraktLists {
  readonly watchlistMovies?: typeof Watchlist.Type
  readonly watchlistShows?: typeof Watchlist.Type
  readonly watchedMovies?: typeof WatchedMovies.Type
  readonly watchedShows?: typeof WatchedShows.Type
  readonly movieRatings?: typeof Ratings.Type
  readonly showRatings?: typeof Ratings.Type
}

const ref = (m: Media, category: "movie" | "tv") =>
  m.ids.imdb ? { source: "imdb", id: m.ids.imdb }
  : m.ids.tmdb ? { source: `tmdb_${category}`, id: String(m.ids.tmdb) }
  : undefined

const row = (m: Media, category: "movie" | "tv", key: string, at: string, rest: Pick<ImportRow, "status" | "rating"> & { progress?: number }): ImportRow => {
  const r = ref(m, category)
  return { key, category, title: m.title ?? "", year: m.year, ...(r ? { ref: r } : {}), at: new Date(at), ...rest }
}

const stars = (rating: number) => Math.round(rating) / 2

/**
 * Library rows from Trakt lists: watchlist, then watched, then ratings.
 * Keys change whenever the underlying fact does (new watch, new rating, more episodes), so re-syncs only add new events.
 */
export const traktRows = (lists: TraktLists): Array<ImportRow> => {
  const rows: Array<ImportRow> = []
  for (const w of lists.watchlistMovies ?? []) {
    if (w.movie) rows.push(row(w.movie, "movie", `watchlist:movie:${w.movie.ids.trakt}:${w.listed_at}`, w.listed_at, { status: "want", rating: null }))
  }
  for (const w of lists.watchlistShows ?? []) {
    if (w.show) rows.push(row(w.show, "tv", `watchlist:show:${w.show.ids.trakt}:${w.listed_at}`, w.listed_at, { status: "want", rating: null }))
  }
  for (const w of lists.watchedMovies ?? []) {
    rows.push(row(w.movie, "movie", `watched:movie:${w.movie.ids.trakt}:${w.last_watched_at}`, w.last_watched_at, { status: "finished", rating: null }))
  }
  for (const w of lists.watchedShows ?? []) {
    const aired = w.show.aired_episodes ?? null
    const episodes = aired === null ? w.plays : Math.min(w.plays, aired)
    if (episodes === 0) continue
    // Caught up on a show that is still airing is in progress: imports never move a title back from finished.
    const done = aired !== null && episodes >= aired && (w.show.status === "ended" || w.show.status === "canceled")
    rows.push(row(w.show, "tv", `watched:show:${w.show.ids.trakt}:${episodes}${done ? ":finished" : ""}`, w.last_watched_at, {
      status: done ? "finished" : "in_progress",
      rating: null,
      progress: episodes
    }))
  }
  for (const r of lists.movieRatings ?? []) {
    if (r.movie) rows.push(row(r.movie, "movie", `rating:movie:${r.movie.ids.trakt}:${r.rated_at}`, r.rated_at, { status: "finished", rating: stars(r.rating) }))
  }
  for (const r of lists.showRatings ?? []) {
    if (r.show) rows.push(row(r.show, "tv", `rating:show:${r.show.ids.trakt}:${r.rated_at}`, r.rated_at, { status: null, rating: stars(r.rating) }))
  }
  return rows
}

// Which /sync/last_activities timestamp guards each list.
const LISTS = [
  { name: "watchlistMovies", path: "/sync/watchlist/movies/rank/asc", paginated: true, activity: ["movies", "watchlisted_at"], schema: Watchlist },
  { name: "watchlistShows", path: "/sync/watchlist/shows/rank/asc", paginated: true, activity: ["shows", "watchlisted_at"], schema: Watchlist },
  { name: "watchedMovies", path: "/sync/watched/movies", paginated: false, activity: ["movies", "watched_at"], schema: WatchedMovies },
  { name: "watchedShows", path: "/sync/watched/shows?extended=full", paginated: false, activity: ["episodes", "watched_at"], schema: WatchedShows },
  { name: "movieRatings", path: "/sync/ratings/movies", paginated: true, activity: ["movies", "rated_at"], schema: Ratings },
  { name: "showRatings", path: "/sync/ratings/shows", paginated: true, activity: ["shows", "rated_at"], schema: Ratings }
] as const

const activityAt = (activities: unknown, [group, field]: readonly [string, string]) =>
  (activities as Record<string, Record<string, unknown> | undefined> | null)?.[group]?.[field] ?? null

const base64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
const randomToken = () => base64url(crypto.getRandomValues(new Uint8Array(48)))
const challengeOf = (verifier: string) =>
  Effect.promise(() => crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))).pipe(Effect.map((d) => base64url(new Uint8Array(d))))

const failed = (e: TraktError) =>
  new TraktFailed({ message: e.status === 401 || e.status === 403 ? "Trakt refused the connection. Connect Trakt again." : e.message })

export class Trakt extends Context.Service<Trakt, {
  status(userId: UserId): Effect.Effect<TraktStatus>
  connect(userId: UserId): Effect.Effect<{ readonly url: string }, TraktFailed>
  callback(userId: UserId, code: string, state: string): Effect.Effect<ImportResult, TraktFailed>
  sync(userId: UserId): Effect.Effect<ImportResult, TraktFailed>
  disconnect(userId: UserId): Effect.Effect<void>
  /** Cron: syncs connected users, least recently checked first, within `budget` Trakt requests. */
  syncDue(budget: number): Effect.Effect<{ readonly users: number; readonly requests: number }>
}>()("magpie/Trakt") {
  static readonly layer = Layer.effect(
    Trakt,
    Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient
      const api = yield* TraktApi
      const imports = yield* Imports

      const requireConfigured = api.configured
        ? Effect.void
        : Effect.fail(new TraktFailed({ message: "Trakt isn't set up on this Magpie. Ask whoever runs it to add a Trakt app." }))

      const status = Effect.fn("Trakt.status")(function*(userId: UserId) {
        const [c] = yield* sql<{ username: string | null; synced_at: Date | null }>`
          SELECT username, synced_at FROM trakt_connection WHERE user_id::text = ${userId}`.pipe(Effect.orDie)
        return new TraktStatus({
          configured: api.configured,
          connected: c !== undefined,
          username: c?.username ?? null,
          syncedAt: c?.synced_at ? new Date(c.synced_at).toISOString() : null
        })
      })

      const connect = Effect.fn("Trakt.connect")(function*(userId: UserId) {
        yield* requireConfigured
        const state = randomToken()
        const verifier = randomToken()
        yield* sql`
          INSERT INTO trakt_oauth (user_id, state, verifier) VALUES (${userId}::uuid, ${state}, ${verifier})
          ON CONFLICT (user_id) DO UPDATE SET state = EXCLUDED.state, verifier = EXCLUDED.verifier, created_at = now()`.pipe(Effect.orDie)
        return { url: api.authorizeUrl(state, yield* challengeOf(verifier)) }
      })

      // Single-use refresh tokens: the row lock stops the cron and a manual sync from both spending the same one.
      const accessToken = Effect.fn(function*(userId: UserId, meter: Meter) {
        return yield* sql.withTransaction(Effect.gen(function*() {
          const [c] = yield* sql<{ access_token: string; refresh_token: string; expires_at: Date }>`
            SELECT access_token, refresh_token, expires_at FROM trakt_connection WHERE user_id::text = ${userId} FOR UPDATE`.pipe(Effect.orDie)
          if (!c) return yield* new TraktFailed({ message: "Connect Trakt first." })
          if (new Date(c.expires_at).getTime() - Date.now() > REFRESH_MARGIN_MS) return c.access_token
          const fresh = yield* api.refresh(c.refresh_token, meter).pipe(Effect.mapError(failed))
          yield* save(userId, fresh)
          return fresh.accessToken
        })).pipe(Effect.catchTag("SqlError", Effect.die))
      })

      const save = (userId: UserId, t: Tokens) =>
        sql`UPDATE trakt_connection SET access_token = ${t.accessToken}, refresh_token = ${t.refreshToken}, expires_at = ${t.expiresAt}
            WHERE user_id::text = ${userId}`.pipe(Effect.orDie)

      const syncMetered = Effect.fn("Trakt.sync")(function*(userId: UserId, meter: Meter) {
        yield* requireConfigured
        const token = yield* accessToken(userId, meter)
        const get = (path: string, paginated = false) => api.get(path, token, meter, { paginated }).pipe(Effect.mapError(failed))

        const [c] = yield* sql<{ last_activities: unknown; skipped: ReadonlyArray<string> }>`
          SELECT last_activities, skipped FROM trakt_connection WHERE user_id::text = ${userId}`.pipe(Effect.orDie)
        const previous = c?.last_activities ?? null
        const activities = yield* get("/sync/last_activities")

        const lists: Record<string, unknown> = {}
        for (const l of LISTS) {
          const now = activityAt(activities, l.activity)
          if (previous !== null && now !== null && now === activityAt(previous, l.activity)) continue
          const body = yield* get(l.path, l.paginated)
          lists[l.name] = yield* Schema.decodeUnknownEffect(l.schema as Schema.Codec<unknown>)(body).pipe(
            Effect.mapError(() => new TraktFailed({ message: `Trakt sent an unexpected ${l.name} list` }))
          )
        }

        const rows = traktRows(lists as TraktLists)
        // Skip rows already applied or already found to match nothing, so a refetched list only matches what is new.
        const ids = rows.map((r) => `${SOURCE}:${r.key}:${r.status ? "status" : "rated"}`)
        const applied = (candidates: ReadonlyArray<string>) =>
          candidates.length === 0 ? Effect.succeed(new Set<string>()) : sql<{ id: string }>`
            SELECT source_event_id AS id FROM event
            WHERE user_id::text = ${userId} AND source = ${SOURCE} AND source_event_id = ANY(${candidates}::text[])`.pipe(
            Effect.map((found) => new Set(found.map((r) => r.id))),
            Effect.orDie
          )
        const seen = yield* applied(ids)
        for (const id of c?.skipped ?? []) seen.add(id)
        const fresh = rows.flatMap((r, i) => (seen.has(ids[i]!) ? [] : [{ row: r, id: ids[i]! }]))
        const result = fresh.length === 0
          ? new ImportResult({ total: 0, matched: 0, unmatched: [] })
          : yield* imports.seed(userId, SOURCE, fresh.map((f) => f.row)).pipe(Effect.orDie)
        const nowApplied = yield* applied(fresh.map((f) => f.id))
        const skipped = fresh.flatMap((f) => (nowApplied.has(f.id) ? [] : [f.id]))

        yield* sql`UPDATE trakt_connection SET last_activities = ${JSON.stringify(activities)}::jsonb, synced_at = now(), checked_at = now(),
                     skipped = skipped || ${skipped}::text[]
                   WHERE user_id::text = ${userId}`.pipe(Effect.orDie)
        return result
      })

      const sync = (userId: UserId) => syncMetered(userId, new Meter(REQUEST_BUDGET))

      const callback = Effect.fn("Trakt.callback")(function*(userId: UserId, code: string, state: string) {
        yield* requireConfigured
        const [pending] = yield* sql<{ verifier: string }>`
          DELETE FROM trakt_oauth WHERE user_id::text = ${userId} AND state = ${state} AND created_at > now() - ${OAUTH_TTL}::interval
          RETURNING verifier`.pipe(Effect.orDie)
        if (!pending) return yield* new TraktFailed({ message: "That Trakt sign-in expired or was already used. Try connecting again." })
        const meter = new Meter(REQUEST_BUDGET)
        const tokens = yield* api.exchange(code, pending.verifier, meter).pipe(Effect.mapError(failed))
        const settings = yield* api.get("/users/settings", tokens.accessToken, meter).pipe(
          Effect.flatMap((body) => Schema.decodeUnknownEffect(Settings)(body)),
          Effect.map((s) => s.user.username),
          Effect.orElseSucceed(() => null)
        )
        yield* sql`
          INSERT INTO trakt_connection (user_id, username, access_token, refresh_token, expires_at)
          VALUES (${userId}::uuid, ${settings}, ${tokens.accessToken}, ${tokens.refreshToken}, ${tokens.expiresAt})
          ON CONFLICT (user_id) DO UPDATE SET username = EXCLUDED.username, access_token = EXCLUDED.access_token,
            refresh_token = EXCLUDED.refresh_token, expires_at = EXCLUDED.expires_at, last_activities = NULL, skipped = '{}'`.pipe(Effect.orDie)
        return yield* syncMetered(userId, meter)
      })

      const disconnect = Effect.fn("Trakt.disconnect")(function*(userId: UserId) {
        const [c] = yield* sql<{ access_token: string }>`
          DELETE FROM trakt_connection WHERE user_id::text = ${userId} RETURNING access_token`.pipe(Effect.orDie)
        if (c && api.configured) yield* api.revoke(c.access_token).pipe(Effect.ignore)
      })

      const syncDue = Effect.fn("Trakt.syncDue")(function*(budget: number) {
        if (!api.configured) return { users: 0, requests: 0 }
        const due = yield* sql<{ user_id: string }>`
          SELECT user_id::text FROM trakt_connection ORDER BY checked_at NULLS FIRST`.pipe(Effect.orDie)
        const meter = new Meter(budget)
        let users = 0
        for (const { user_id } of due) {
          if (meter.spent + PER_USER_RESERVE > budget) break
          const userId = user_id as UserId
          yield* sql`UPDATE trakt_connection SET checked_at = now() WHERE user_id::text = ${userId}`.pipe(Effect.orDie)
          const r = yield* Effect.result(syncMetered(userId, meter))
          if (Result.isFailure(r)) yield* Effect.logWarning(`trakt sync failed for ${userId}: ${r.failure.message}`)
          else users++
        }
        return { users, requests: meter.spent }
      })

      return Trakt.of({ status, connect, callback, sync, disconnect, syncDue })
    })
  )
}
