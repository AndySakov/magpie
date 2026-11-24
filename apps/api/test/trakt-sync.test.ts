import { PgClient } from "@effect/sql-pg"
import type { ItemId, UserId } from "@magpie/contract"
import { Effect, Layer, Redacted } from "effect"
import { SqlClient } from "effect/sql"
import { fileURLToPath } from "node:url"
import { beforeEach, describe, expect, it } from "vitest"
import { Imports } from "../src/Imports.ts"
import { Library } from "../src/Library.ts"
import { Trakt } from "../src/Trakt.ts"
import { type Meter, TraktApi, TraktError } from "../src/TraktApi.ts"
import { API } from "./client.ts"

// Needs the local database with an ingested catalog, like the e2e tests: API_URL=http://localhost:3000 pnpm test
const run = API ? describe : describe.skip

const fightClub = { title: "Fight Club", year: 1999, ids: { trakt: 432, imdb: "tt0137523", tmdb: 550 } }
const matrix = { title: "The Matrix", year: 1999, ids: { trakt: 481, imdb: "tt0133093", tmdb: 603 } }
const breakingBad = { title: "Breaking Bad", year: 2008, ids: { trakt: 1, imdb: "tt0903747", tmdb: 1396 }, aired_episodes: 62, status: "ended" }

const ACTIVITIES = {
  all: "2024-03-02T00:00:00.000Z",
  movies: { watched_at: "2024-02-01T00:00:00.000Z", rated_at: "2024-02-02T00:00:00.000Z", watchlisted_at: "2024-01-01T00:00:00.000Z" },
  episodes: { watched_at: "2024-03-01T00:00:00.000Z" },
  shows: { rated_at: "2024-01-01T00:00:00.000Z", watchlisted_at: "2024-01-01T00:00:00.000Z" }
}

let activities: typeof ACTIVITIES = ACTIVITIES
let lists: Record<string, unknown> = {}
const calls: Array<string> = []
const tokens: Array<string> = []
let refreshes = 0

const fakeApi = TraktApi.of({
  configured: true,
  redirectUri: "http://localhost:5173/trakt/callback",
  authorizeUrl: (state, challenge) => `https://auth.trakt.tv/oauth/authorize?state=${state}&code_challenge=${challenge}`,
  exchange: (code, _verifier, meter: Meter) =>
    meter.take.pipe(Effect.andThen(code === "good"
      ? Effect.succeed({ accessToken: "a1", refreshToken: "r1", expiresAt: new Date(Date.now() + 7 * 86_400_000) })
      : Effect.fail(new TraktError({ message: "invalid_grant", status: 401 })))),
  refresh: (_token, meter: Meter) =>
    meter.take.pipe(Effect.andThen(Effect.sync(() => {
      refreshes++
      return { accessToken: "a2", refreshToken: "r2", expiresAt: new Date(Date.now() + 7 * 86_400_000) }
    }))),
  revoke: () => Effect.void,
  get: (path, token, meter: Meter) =>
    meter.take.pipe(Effect.andThen(Effect.suspend(() => {
      calls.push(path)
      tokens.push(token)
      if (token === "fail") return Effect.fail(new TraktError({ message: "Trakt 500 on /sync/last_activities", status: 500 }))
      return Effect.succeed(path === "/sync/last_activities" ? activities : path === "/users/settings" ? { user: { username: "tester" } } : lists[path] ?? [])
    })))
})

process.loadEnvFile(fileURLToPath(new URL("../../../.env", import.meta.url)))
const db = PgClient.layer({ url: Redacted.make(process.env.DATABASE_URL!), maxConnections: 2 })
const layer = Trakt.layer.pipe(
  Layer.provide(Imports.layer),
  Layer.provideMerge(Library.layer),
  Layer.provide(Layer.succeed(TraktApi, fakeApi)),
  Layer.provideMerge(db)
)
const unconfigured = Trakt.layer.pipe(
  Layer.provide(Imports.layer.pipe(Layer.provide(Library.layer))),
  Layer.provide(Layer.succeed(TraktApi, TraktApi.of({ ...fakeApi, configured: false }))),
  Layer.provide(db)
)

class Rollback {
  constructor(readonly value: unknown) {}
}

type Env = Trakt | Library | SqlClient.SqlClient
type Ctx = { readonly userId: UserId; readonly trakt: Trakt["Service"]; readonly library: Library["Service"]; readonly sql: SqlClient.SqlClient }

// Each test runs in one transaction that is always rolled back, with a fresh user already connected to Trakt.
const isolated = <A>(body: (ctx: Ctx) => Effect.Effect<A, unknown, Env>) =>
  Effect.runPromise(Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    const trakt = yield* Trakt
    const library = yield* Library
    return yield* sql.withTransaction(Effect.gen(function*() {
      const [u] = yield* sql<{ id: string }>`INSERT INTO app_user (name) VALUES ('trakt-sync-test') RETURNING id::text`
      const userId = u!.id as UserId
      yield* sql`INSERT INTO trakt_connection (user_id, access_token, refresh_token, expires_at)
                 VALUES (${userId}::uuid, 'a1', 'r1', now() + interval '6 days')`
      return yield* Effect.flatMap(body({ userId, trakt, library, sql }), (a) => Effect.fail(new Rollback(a)))
    }))
  }).pipe(
    Effect.catchIf((e): e is Rollback => e instanceof Rollback, (e) => Effect.succeed(e.value as A)),
    Effect.provide(layer)
  )) as Promise<A>

const library = (sql: SqlClient.SqlClient, userId: UserId) =>
  sql<{ row: string }>`SELECT i.title || ':' || COALESCE(ui.status::text, '-') || ':' || COALESCE(ui.rating::text, '-') || ':' || COALESCE(ui.progress::text, '-') AS row
                       FROM user_item ui JOIN item i ON i.id = ui.item_id WHERE ui.user_id::text = ${userId} ORDER BY 1`.pipe(
    Effect.map((rows) => rows.map((r) => r.row))
  )

run("trakt sync", () => {
  beforeEach(() => {
    activities = ACTIVITIES
    lists = {
      "/sync/watchlist/movies/rank/asc": [{ listed_at: "2024-01-01T00:00:00.000Z", movie: matrix }],
      "/sync/watched/movies": [{ last_watched_at: "2024-02-01T00:00:00.000Z", movie: fightClub }],
      "/sync/watched/shows?extended=full": [{ plays: 20, last_watched_at: "2024-03-01T00:00:00.000Z", show: breakingBad }],
      "/sync/ratings/movies": [{ rated_at: "2024-02-02T00:00:00.000Z", rating: 9, movie: fightClub }]
    }
    calls.length = 0
    tokens.length = 0
    refreshes = 0
  })

  it("first sync imports watched, rated and watchlisted titles by IMDb id", async () => {
    const [result, rows] = await isolated(({ trakt, sql, userId }) =>
      Effect.all([trakt.sync(userId), library(sql, userId)], { concurrency: 1 }))
    expect([result.total, result.matched, result.unmatched]).toEqual([4, 4, []])
    expect(rows).toEqual(["Breaking Bad:in_progress:-:20", "Fight Club:finished:4.5:-", "The Matrix:want:-:-"])
    expect(calls).toHaveLength(7)
  })

  it("a sync with unchanged activity only asks Trakt for its activity timestamps", async () => {
    const second = await isolated(({ trakt, userId }) =>
      Effect.gen(function*() {
        yield* trakt.sync(userId)
        calls.length = 0
        return yield* trakt.sync(userId)
      }))
    expect(calls).toEqual(["/sync/last_activities"])
    expect(second.total).toBe(0)
  })

  it("refetches only changed lists and applies only new rows", async () => {
    const [result, rows] = await isolated(({ trakt, sql, userId }) =>
      Effect.gen(function*() {
        yield* trakt.sync(userId)
        calls.length = 0
        activities = { ...ACTIVITIES, movies: { ...ACTIVITIES.movies, rated_at: "2024-05-01T00:00:00.000Z" } }
        lists["/sync/ratings/movies"] = [
          { rated_at: "2024-02-02T00:00:00.000Z", rating: 9, movie: fightClub },
          { rated_at: "2024-05-01T00:00:00.000Z", rating: 6, movie: matrix }
        ]
        return [yield* trakt.sync(userId), yield* library(sql, userId)] as const
      }))
    expect(calls).toEqual(["/sync/last_activities", "/sync/ratings/movies"])
    expect([result.total, result.matched]).toEqual([1, 1])
    expect(rows).toContain("The Matrix:finished:3:-")
  })

  it("refreshes an expiring token once and keeps the rotated pair", async () => {
    const tokens = await isolated(({ trakt, sql, userId }) =>
      Effect.gen(function*() {
        yield* sql`UPDATE trakt_connection SET expires_at = now() + interval '1 hour' WHERE user_id::text = ${userId}`
        yield* trakt.sync(userId)
        yield* trakt.sync(userId)
        return yield* sql<{ access_token: string; refresh_token: string }>`
          SELECT access_token, refresh_token FROM trakt_connection WHERE user_id::text = ${userId}`
      }))
    expect(refreshes).toBe(1)
    expect(tokens).toEqual([{ access_token: "a2", refresh_token: "r2" }])
  })

  it("finishes sign-in only for the state it issued, then imports everything", async () => {
    const [wrong, result, status] = await isolated(({ trakt, sql, userId }) =>
      Effect.gen(function*() {
        yield* sql`DELETE FROM trakt_connection WHERE user_id::text = ${userId}`
        const { url } = yield* trakt.connect(userId)
        const state = new URL(url).searchParams.get("state")!
        const wrong = yield* Effect.flip(trakt.callback(userId, "good", "not-the-state"))
        const result = yield* trakt.callback(userId, "good", state)
        return [wrong.message, result, yield* trakt.status(userId)] as const
      }))
    expect(wrong).toBe("That Trakt sign-in expired or was already used. Try connecting again.")
    expect([result.total, result.matched]).toEqual([4, 4])
    expect([status.connected, status.username]).toEqual([true, "tester"])
  })

  it("refuses a sign-in that was already used, has expired, or that Trakt rejects", async () => {
    const messages = await isolated(({ trakt, sql, userId }) =>
      Effect.gen(function*() {
        const stateOf = (url: string) => new URL(url).searchParams.get("state")!
        const used = stateOf((yield* trakt.connect(userId)).url)
        yield* trakt.callback(userId, "good", used)
        const replayed = yield* Effect.flip(trakt.callback(userId, "good", used))
        const stale = stateOf((yield* trakt.connect(userId)).url)
        yield* sql`UPDATE trakt_oauth SET created_at = now() - interval '16 minutes' WHERE user_id::text = ${userId}`
        const expired = yield* Effect.flip(trakt.callback(userId, "good", stale))
        const rejected = yield* Effect.flip(trakt.callback(userId, "bad", stateOf((yield* trakt.connect(userId)).url)))
        return [replayed.message, expired.message, rejected.message]
      }))
    expect(messages).toEqual([
      "That Trakt sign-in expired or was already used. Try connecting again.",
      "That Trakt sign-in expired or was already used. Try connecting again.",
      "Trakt refused the connection. Connect Trakt again."
    ])
  })

  it("never moves a title backwards: finished stays finished when Trakt has less", async () => {
    const rows = await isolated(({ trakt, sql, userId }) =>
      Effect.gen(function*() {
        yield* sql`
          INSERT INTO user_item (user_id, item_id, status, progress, updated_at)
          SELECT ${userId}::uuid, item_id, 'finished', ${null}, now() - interval '1 year'
          FROM item_external_id WHERE source = 'imdb' AND external_id IN ('tt0903747', 'tt0110912')`
        lists = {
          "/sync/watchlist/movies/rank/asc": [{ listed_at: "2024-01-01T00:00:00.000Z", movie: { title: "Pulp Fiction", year: 1994, ids: { trakt: 554, imdb: "tt0110912", tmdb: 680 } } }],
          "/sync/watched/shows?extended=full": [{ plays: 20, last_watched_at: "2024-03-01T00:00:00.000Z", show: breakingBad }]
        }
        yield* trakt.sync(userId)
        return yield* library(sql, userId)
      }))
    expect(rows).toEqual(["Breaking Bad:finished:-:20", "Pulp Fiction:finished:-:-"])
  })

  it("imports move status and progress forward only, while manual edits can go anywhere", async () => {
    const rows = await isolated(({ library: lib, sql, userId }) =>
      Effect.gen(function*() {
        const [item] = yield* sql<{ id: number }>`SELECT item_id::int AS id FROM item_external_id WHERE source = 'imdb' AND external_id = 'tt0137523'`
        const itemId = item!.id as ItemId
        const imported = (key: string) => ({ source: "trakt", sourceEventId: `test:${key}` })
        yield* lib.apply(userId, itemId, { status: "in_progress", progress: 30 }, imported("a"))
        yield* lib.apply(userId, itemId, { status: "want" }, imported("b"))
        yield* lib.apply(userId, itemId, { progress: 20 }, imported("c"))
        const afterImports = yield* library(sql, userId)
        yield* lib.apply(userId, itemId, { status: "want", progress: 5 })
        return [...afterImports, ...(yield* library(sql, userId))]
      }))
    expect(rows).toEqual(["Fight Club:in_progress:-:30", "Fight Club:want:-:5"])
  })

  it("doesn't try to match a title again once it matched nothing", async () => {
    const nowhere = { last_watched_at: "2024-02-01T00:00:00.000Z", movie: { title: "Qzxv Nonexistent Film", year: 1901, ids: { trakt: 5 } } }
    lists = { "/sync/watched/movies": [nowhere] }
    const second = await isolated(({ trakt, userId }) =>
      Effect.gen(function*() {
        yield* trakt.sync(userId)
        activities = { ...ACTIVITIES, movies: { ...ACTIVITIES.movies, watched_at: "2024-06-01T00:00:00.000Z" } }
        lists = { "/sync/watched/movies": [nowhere, { last_watched_at: "2024-06-01T00:00:00.000Z", movie: matrix }] }
        return yield* trakt.sync(userId)
      }))
    expect([second.total, second.matched, second.unmatched]).toEqual([1, 1, []])
  })

  it("cron syncs the longest-waiting users within the budget and counts a failed user's requests", async () => {
    const [result, checked] = await isolated(({ trakt, sql }) =>
      Effect.gen(function*() {
        yield* sql`UPDATE trakt_connection SET checked_at = now()`
        for (const [token, day] of [["u1", 1], ["fail", 2], ["u3", 3]] as const) {
          const [u] = yield* sql<{ id: string }>`INSERT INTO app_user (name) VALUES (${`trakt-cron-${token}`}) RETURNING id::text`
          yield* sql`INSERT INTO trakt_connection (user_id, access_token, refresh_token, expires_at, last_activities, checked_at)
                     VALUES (${u!.id}::uuid, ${token}, 'r', now() + interval '6 days', ${JSON.stringify(ACTIVITIES)}::jsonb,
                             ${`2000-01-0${day}`}::timestamptz)`
        }
        const result = yield* trakt.syncDue(14)
        const checked = yield* sql<{ access_token: string }>`
          SELECT access_token FROM trakt_connection WHERE checked_at > now() - interval '1 minute' AND access_token IN ('u1', 'fail', 'u3')
          ORDER BY access_token`
        return [result, checked.map((c) => c.access_token)] as const
      }))
    expect(tokens).toEqual(["u1", "fail", "u3"])
    expect(result).toEqual({ users: 2, requests: 3 })
    expect(checked).toEqual(["fail", "u1", "u3"])
  })

  it("without a Trakt app, reports it unavailable and refuses to connect", async () => {
    const [status, refused] = await Effect.runPromise(Effect.gen(function*() {
      const trakt = yield* Trakt
      const userId = crypto.randomUUID() as UserId
      return [yield* trakt.status(userId), yield* Effect.flip(trakt.connect(userId))] as const
    }).pipe(Effect.provide(unconfigured)))
    expect([status.configured, status.connected]).toEqual([false, false])
    expect(refused.message).toBe("Trakt isn't set up on this Magpie. Ask whoever runs it to add a Trakt app.")
  })

  it("reports titles it can't place so the user can pick them", async () => {
    lists = { "/sync/watched/movies": [{ last_watched_at: "2024-02-01T00:00:00.000Z", movie: { title: "Qzxv Nonexistent Film", year: 1901, ids: { trakt: 5 } } }] }
    const result = await isolated(({ trakt, userId }) => trakt.sync(userId))
    expect(result.unmatched.map((u) => [u.title, u.year, u.status])).toEqual([["Qzxv Nonexistent Film", 1901, "finished"]])
  })
})
