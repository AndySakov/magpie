import { PgClient } from "@effect/sql-pg"
import { env } from "cloudflare:workers"
import { Context, Effect, Layer, Option, Redacted, Tracer } from "effect"
import { SqlClient } from "effect/sql"
import { HttpRouter, HttpServer } from "effect/http"
import * as Reactivity from "effect/reactivity/Reactivity"
import { Availability } from "./Availability.ts"
import { Daily, type Mailer } from "./Daily.ts"
import { Embedder, type WorkersAi } from "./Embedder.ts"
import { ApiLive, AuthenticationLive } from "./Http.ts"
import { RequestSql, SharedSqlLive } from "./RequestDb.ts"
import { Tmdb } from "./Tmdb.ts"
import { Imports } from "./Imports.ts"
import { Library } from "./Library.ts"
import { Trakt } from "./Trakt.ts"
import { TraktApi } from "./TraktApi.ts"

export interface Env {
  readonly HYPERDRIVE: { readonly connectionString: string }
  readonly AI: WorkersAi
  readonly ALCHEMY_WORKER_NAME: string
  readonly ALCHEMY_CLOUDFLARE_ACCOUNT_ID: string
  readonly CF_ANALYTICS_TOKEN?: string
  readonly EMAIL?: Mailer
  readonly ALERT_EMAIL_FROM?: string
  readonly ALERT_EMAIL_TO?: string
}

const app = HttpRouter.toWebHandler(
  ApiLive.pipe(
    Layer.provide(AuthenticationLive),
    Layer.provide(Embedder.workersAi((env as unknown as Env).AI)),
    Layer.provide(SharedSqlLive),
    Layer.provide(HttpServer.layerServices)
  )
)

const withDb = <A>(env: Env, f: (db: SqlClient.SqlClient) => Promise<A>) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.flatMap(
        PgClient.make({ url: Redacted.make(env.HYPERDRIVE.connectionString), maxConnections: 3 }),
        (db) => Effect.promise(() => f(db))
      )
    ).pipe(Effect.provide(Reactivity.layer))
  )

const daily = (env: Env) =>
  Daily.layer({
    accountId: env.ALCHEMY_CLOUDFLARE_ACCOUNT_ID,
    scriptName: env.ALCHEMY_WORKER_NAME,
    analyticsToken: Option.fromNullishOr(env.CF_ANALYTICS_TOKEN),
    mail: env.EMAIL && env.ALERT_EMAIL_FROM && env.ALERT_EMAIL_TO
      ? Option.some({ mailer: env.EMAIL, from: env.ALERT_EMAIL_FROM, to: env.ALERT_EMAIL_TO })
      : Option.none()
  }).pipe(
    Layer.provide(Availability.layer),
    Layer.provide(Tmdb.layer),
    Layer.provide(Embedder.workersAi(env.AI)),
    Layer.provide(SharedSqlLive)
  )

// Trakt syncs on its own trigger so it gets its own 50-subrequest budget, separate from the sweep and usage check.
const TRAKT_CRON = "30 * * * *"
const TRAKT_BUDGET = 40

const trakt = Trakt.layer.pipe(
  Layer.provide(Imports.layer.pipe(Layer.provide(Library.layer))),
  Layer.provide(TraktApi.layer),
  Layer.provide(SharedSqlLive)
)

// Database time per request, readable in the browser's network panel and through PerformanceResourceTiming.
const timings = () => {
  const spans: Array<Tracer.NativeSpan> = []
  const tracer = Tracer.make({
    span(options) {
      const span = new Tracer.NativeSpan(options)
      spans.push(span)
      return span
    }
  })
  const header = (totalMs: number) => {
    const sum = (name: string) => {
      const ended = spans.flatMap((s) => s.name === name && s.status._tag === "Ended" ? [Number(s.status.endTime - s.status.startTime) / 1e6] : [])
      return { count: ended.length, ms: ended.reduce((a, b) => a + b, 0) }
    }
    const q = sum("sql.execute")
    const c = sum("db.acquire")
    return `db;dur=${q.ms.toFixed(1)};desc="${q.count} queries", acquire;dur=${c.ms.toFixed(1)};desc="${c.count} leases", worker;dur=${totalMs}`
  }
  return { tracer, header }
}

export default {
  fetch: async (request: Request, env: Env) => {
    const start = Date.now()
    const t = timings()
    const res = await withDb(env, (db) => app.handler(request, Context.make(RequestSql, db).pipe(Context.add(Tracer.Tracer, t.tracer))))
    const out = new Response(res.body, res)
    out.headers.append("Server-Timing", t.header(Date.now() - start))
    return out
  },
  scheduled: (controller: { readonly scheduledTime: number; readonly cron: string }, env: Env, ctx: { waitUntil(p: Promise<unknown>): void }) =>
    ctx.waitUntil(withDb(env, (db) =>
      Effect.runPromise(
        (controller.cron === TRAKT_CRON
          ? Effect.flatMap(Effect.service(Trakt), (t) => t.syncDue(TRAKT_BUDGET)).pipe(
            Effect.flatMap((r) => Effect.log(`trakt: synced ${r.users} users with ${r.requests} requests`)),
            Effect.provide(trakt)
          )
          : Effect.flatMap(Effect.service(Daily), (d) => d.run(new Date(controller.scheduledTime))).pipe(Effect.provide(daily(env)))
        ).pipe(Effect.provideService(RequestSql, db))
      )
    ))
}
