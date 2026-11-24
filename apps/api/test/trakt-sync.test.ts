import { PgClient } from "@effect/sql-pg"
import type { UserId } from "@magpie/contract"
import { Effect, Layer, Redacted } from "effect"
import { SqlClient } from "effect/sql"
import { fileURLToPath } from "node:url"
import { beforeEach, describe, expect, it } from "vitest"
import { Imports } from "../src/Imports.ts"
import { Library } from "../src/Library.ts"
import { Trakt } from "../src/Trakt.ts"
import { TraktApi, TraktError } from "../src/TraktApi.ts"
import { API } from "./client.ts"

// Needs the local database with an ingested catalog, like the e2e tests: API_URL=http://localhost:3000 pnpm test
const run = API ? describe : describe.skip

const fightClub = { title: "Fight Club", year: 1999, ids: { trakt: 432, imdb: "tt0137523", tmdb: 550 } }
const matrix = { title: "The Matrix", year: 1999, ids: { trakt: 481, imdb: "tt0133093", tmdb: 603 } }
const breakingBad = { title: "Breaking Bad", year: 2008, ids: { trakt: 1, imdb: "tt0903747", tmdb: 1396 }, aired_episodes: 62 }

const ACTIVITIES = {
  all: "2024-03-02T00:00:00.000Z",
  movies: { watched_at: "2024-02-01T00:00:00.000Z", rated_at: "2024-02-02T00:00:00.000Z", watchlisted_at: "2024-01-01T00:00:00.000Z" },
  episodes: { watched_at: "2024-03-01T00:00:00.000Z" },
  shows: { rated_at: "2024-01-01T00:00:00.000Z", watchlisted_at: "2024-01-01T00:00:00.000Z" }
}

let activities: typeof ACTIVITIES = ACTIVITIES
let lists: Record<string, unknown> = {}
const calls: Array<string> = []
let refreshes = 0

const fakeApi = TraktApi.of({
  configured: true,
  redirectUri: "http://localhost:5173/trakt/callback",
  authorizeUrl: (state, challenge) => `https://auth.trakt.tv/oauth/authorize?state=${state}&code_challenge=${challenge}`,
  exchange: (code) =>
    code === "good"
      ? Effect.succeed({ accessToken: "a1", refreshToken: "r1", expiresAt: new Date(Date.now() + 7 * 86_400_000) })
      : Effect.fail(new TraktError({ message: "invalid_grant", status: 401 })),
  refresh: () => {
    refreshes++
    return Effect.succeed({ accessToken: "a2", refreshToken: "r2", expiresAt: new Date(Date.now() + 7 * 86_400_000) })
  },
  revoke: () => Effect.void,
  get: (path) => {
    calls.push(path)
    const body = path === "/sync/last_activities" ? activities : path === "/users/settings" ? { user: { username: "tester" } } : lists[path] ?? []
    return Effect.succeed({ body, requests: 1 })
  }
})

process.loadEnvFile(fileURLToPath(new URL("../../../.env", import.meta.url)))
const layer = Trakt.layer.pipe(
  Layer.provide(Imports.layer.pipe(Layer.provide(Library.layer))),
  Layer.provide(Layer.succeed(TraktApi, fakeApi)),
  Layer.provideMerge(PgClient.layer({ url: Redacted.make(process.env.DATABASE_URL!), maxConnections: 2 }))
)

class Rollback {
  constructor(readonly value: unknown) {}
}

type Env = Trakt | SqlClient.SqlClient
type Ctx = { readonly userId: UserId; readonly trakt: Trakt["Service"]; readonly sql: SqlClient.SqlClient }

// Each test runs in one transaction that is always rolled back, with a fresh user already connected to Trakt.
const isolated = <A>(body: (ctx: Ctx) => Effect.Effect<A, unknown, Env>) =>
  Effect.runPromise(Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    const trakt = yield* Trakt
    return yield* sql.withTransaction(Effect.gen(function*() {
      const [u] = yield* sql<{ id: string }>`INSERT INTO app_user (name) VALUES ('trakt-sync-test') RETURNING id::text`
      const userId = u!.id as UserId
      yield* sql`INSERT INTO trakt_connection (user_id, access_token, refresh_token, expires_at)
                 VALUES (${userId}::uuid, 'a1', 'r1', now() + interval '6 days')`
      return yield* Effect.flatMap(body({ userId, trakt, sql }), (a) => Effect.fail(new Rollback(a)))
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

  it("reports titles it can't place so the user can pick them", async () => {
    lists = { "/sync/watched/movies": [{ last_watched_at: "2024-02-01T00:00:00.000Z", movie: { title: "Qzxv Nonexistent Film", year: 1901, ids: { trakt: 5 } } }] }
    const result = await isolated(({ trakt, userId }) => trakt.sync(userId))
    expect(result.unmatched.map((u) => [u.title, u.year, u.status])).toEqual([["Qzxv Nonexistent Film", 1901, "finished"]])
  })
})
