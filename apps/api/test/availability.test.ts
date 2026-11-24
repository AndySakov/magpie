import { PgClient } from "@effect/sql-pg"
import { type ProviderId, WatchSetup } from "@magpie/contract"
import { Effect, Layer, Redacted } from "effect"
import { SqlClient } from "effect/sql"
import { fileURLToPath } from "node:url"
import { beforeEach, describe, expect, it } from "vitest"
import { Availability } from "../src/Availability.ts"
import { type Media, Tmdb, TmdbError } from "../src/Tmdb.ts"
import { API } from "./client.ts"

// Needs the local database with an ingested catalog, like the e2e tests: API_URL=http://localhost:3000 pnpm test
const run = API ? describe : describe.skip

const REGION = "XT"
const P1 = 990001
const P2 = 990002

// Discover pages per provider and media, as TMDB ids. 550 Fight Club, 603 The Matrix, 13 Forrest Gump, 680 Pulp Fiction,
// 1399 Game of Thrones, 1396 Breaking Bad.
let catalogue: Record<string, ReadonlyArray<ReadonlyArray<number>>> = {}
let failAt: string | null = null
const calls: Array<string> = []

const fakeTmdb = Tmdb.of({
  regions: Effect.succeed([]),
  providers: () => Effect.succeed([]),
  offers: () => Effect.succeed({}),
  discover: (media: Media, region: string, providerId: number, page: number) => {
    const key = `${region}/${providerId}/${media}`
    calls.push(`${key}#${page}`)
    if (failAt === `${key}#${page}`) return Effect.fail(new TmdbError({ message: "rate limited" }))
    const pages = catalogue[key] ?? [[]]
    return Effect.succeed({ totalPages: pages.length, ids: pages[page - 1] ?? [] })
  }
})

process.loadEnvFile(fileURLToPath(new URL("../../../.env", import.meta.url)))
const layer = Availability.layer.pipe(
  Layer.provideMerge(Layer.succeed(Tmdb, fakeTmdb)),
  Layer.provideMerge(PgClient.layer({ url: Redacted.make(process.env.DATABASE_URL!), maxConnections: 2 }))
)
const runDb = <A, E>(effect: Effect.Effect<A, E, Availability | SqlClient.SqlClient>) => Effect.runPromise(Effect.provide(effect, layer))

class Rollback {
  constructor(readonly value: unknown) {}
}

// Each test runs in one transaction that hides every other user's services and is always rolled back, so the sweep only
// sees this test's data and the local database is left as it was.
const isolated = <A>(body: Effect.Effect<A, unknown, Availability | SqlClient.SqlClient>) =>
  runDb(Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    return yield* sql.withTransaction(Effect.gen(function*() {
      yield* sql`UPDATE app_user SET preferences = preferences - 'watch'`
      yield* sql`INSERT INTO app_user (name) VALUES ('availability-test')`
      yield* sql`INSERT INTO watch_provider (id, name, logo_path) VALUES (${P1}, 'Test Flix', '/a.png'), (${P2}, 'Test Plus', NULL)
                 ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, logo_path = EXCLUDED.logo_path`
      yield* setServices([P1, P2])
      return yield* Effect.flatMap(body, (a) => Effect.fail(new Rollback(a)))
    }))
  }).pipe(Effect.catchIf((e): e is Rollback => e instanceof Rollback, (e) => Effect.succeed(e.value as A)))) as Promise<A>

const sweep = (budget: number) => Effect.flatMap(Effect.service(Availability), (a) => a.sweep(budget))

// "provider:title" for every availability row in the test region.
const available = Effect.flatMap(Effect.service(SqlClient.SqlClient), (sql) =>
  sql<{ row: string }>`SELECT a.provider_id || ':' || i.title AS row FROM item_availability a JOIN item i ON i.id = a.item_id
                       WHERE a.region = ${REGION} ORDER BY 1`).pipe(Effect.map((rows) => rows.map((r) => r.row)))

const setServices = (services: ReadonlyArray<number>) =>
  Effect.flatMap(Effect.service(SqlClient.SqlClient), (sql) =>
    sql`UPDATE app_user SET preferences = jsonb_set(preferences, '{watch}', ${JSON.stringify({ region: REGION, services, onlyMine: true })}::jsonb)
        WHERE name = 'availability-test'`)

const exec = (f: (sql: SqlClient.SqlClient) => Effect.Effect<unknown, unknown>) => Effect.flatMap(Effect.service(SqlClient.SqlClient), f)

run("availability sweep", () => {
  beforeEach(() => {
    catalogue = {
      [`${REGION}/${P1}/movie`]: [[550, 603], [13, 999999999]],
      [`${REGION}/${P1}/tv`]: [[1399]],
      [`${REGION}/${P2}/movie`]: [[680]],
      [`${REGION}/${P2}/tv`]: [[]]
    }
    failAt = null
    calls.length = 0
  })

  it("pages through every subscribed provider and stores only catalogue matches", async () => {
    const [first, rows, second] = await isolated(Effect.all([sweep(100), available, sweep(100)]))
    expect(first).toEqual({ requests: 5, finished: 4 })
    expect(rows).toEqual([`${P1}:Fight Club`, `${P1}:Forrest Gump`, `${P1}:Game of Thrones`, `${P1}:The Matrix`, `${P2}:Pulp Fiction`])
    expect(second).toEqual({ requests: 0, finished: 0 })
  })

  it("stops at the budget and resumes from the next page", async () => {
    await isolated(Effect.all([sweep(1), sweep(1), sweep(100)]))
    expect(calls.filter((c) => c.startsWith(`${REGION}/${P1}/movie`))).toEqual([`${REGION}/${P1}/movie#1`, `${REGION}/${P1}/movie#2`])
    expect(calls).toHaveLength(5)
  })

  it("drops titles that left a service once a weekly refresh completes", async () => {
    const rows = await isolated(Effect.gen(function*() {
      yield* sweep(100)
      catalogue[`${REGION}/${P1}/movie`] = [[550], [13]]
      yield* exec((sql) => sql`UPDATE availability_sweep SET finished_at = now() - interval '8 days' WHERE region = ${REGION}`)
      // A transaction's now() is fixed, so the refresh must look like it started later than the first sweep's writes.
      yield* exec((sql) => sql`UPDATE item_availability SET seen_at = seen_at - interval '1 hour' WHERE region = ${REGION}`)
      yield* sweep(100)
      return yield* available
    }))
    expect(rows).toEqual([`${P1}:Fight Club`, `${P1}:Forrest Gump`, `${P1}:Game of Thrones`, `${P2}:Pulp Fiction`])
  })

  it("forgets a service nobody subscribes to any more", async () => {
    const [rows, lists] = await isolated(Effect.gen(function*() {
      yield* sweep(100)
      yield* setServices([P2])
      yield* sweep(100)
      const lists = yield* exec((sql) => sql<{ provider_id: number }>`SELECT DISTINCT provider_id FROM availability_sweep WHERE region = ${REGION}`)
      return [yield* available, (lists as ReadonlyArray<{ provider_id: number }>).map((r) => r.provider_id)] as const
    }))
    expect(rows).toEqual([`${P2}:Pulp Fiction`])
    expect(lists).toEqual([P2])
  })

  it("keeps its place when TMDB fails mid-list", async () => {
    const rows = await isolated(Effect.gen(function*() {
      failAt = `${REGION}/${P1}/movie#2`
      const first = yield* sweep(100)
      expect(first).toEqual({ requests: 5, finished: 3 })
      failAt = null
      calls.length = 0
      yield* sweep(100)
      return yield* available
    }))
    expect(calls).toContain(`${REGION}/${P1}/movie#2`)
    expect(calls).not.toContain(`${REGION}/${P1}/movie#1`)
    expect(rows).toContain(`${P1}:Forrest Gump`)
  })

  it("a list that keeps failing doesn't hold up the other services", async () => {
    const [result, rows] = await isolated(Effect.gen(function*() {
      // Already in progress, so it is first in line every run.
      yield* exec((sql) => sql`INSERT INTO availability_sweep (region, provider_id, media, next_page, started_at)
                               VALUES (${REGION}, ${P1}, 'movie', 1, now())`)
      failAt = `${REGION}/${P1}/movie#1`
      return [yield* sweep(100), yield* available] as const
    }))
    expect(result).toEqual({ requests: 4, finished: 3 })
    expect(rows).toEqual([`${P1}:Game of Thrones`, `${P2}:Pulp Fiction`])
  })

  it("reports the user's services carrying each title, in the user's order", async () => {
    catalogue[`${REGION}/${P2}/movie`] = [[680, 550]]
    const on = await isolated(Effect.gen(function*() {
      yield* sweep(100)
      const [fightClub] = (yield* exec((sql) =>
        sql<{ id: number }>`SELECT item_id::int AS id FROM item_external_id WHERE source = 'tmdb_movie' AND external_id = '550'`)) as ReadonlyArray<{ id: number }>
      const setup = new WatchSetup({ region: REGION, services: [P2, P1] as Array<ProviderId>, onlyMine: false })
      const map = yield* Effect.flatMap(Effect.service(Availability), (a) => a.availableOn([fightClub!.id], setup))
      return map.get(fightClub!.id)?.map((p) => [p.name, p.logoUrl])
    }))
    expect(on).toEqual([["Test Plus", null], ["Test Flix", "https://image.tmdb.org/t/p/w92/a.png"]])
  })
})
