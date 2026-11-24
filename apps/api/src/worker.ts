import { PgClient } from "@effect/sql-pg"
import { env } from "cloudflare:workers"
import { Context, Effect, Layer, Option, Redacted } from "effect"
import { SqlClient } from "effect/sql"
import { HttpRouter, HttpServer } from "effect/http"
import * as Reactivity from "effect/reactivity/Reactivity"
import { Availability } from "./Availability.ts"
import { Daily, type Mailer } from "./Daily.ts"
import { Embedder, type WorkersAi } from "./Embedder.ts"
import { ApiLive, AuthenticationLive } from "./Http.ts"
import { RequestSql, SharedSqlLive } from "./RequestDb.ts"
import { Tmdb } from "./Tmdb.ts"

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

export default {
  fetch: (request: Request, env: Env) => withDb(env, (db) => app.handler(request, Context.make(RequestSql, db))),
  scheduled: (controller: { readonly scheduledTime: number }, env: Env, ctx: { waitUntil(p: Promise<unknown>): void }) =>
    ctx.waitUntil(withDb(env, (db) =>
      Effect.runPromise(
        Effect.flatMap(Effect.service(Daily), (d) => d.run(new Date(controller.scheduledTime))).pipe(
          Effect.provide(daily(env)),
          Effect.provideService(RequestSql, db)
        )
      )
    ))
}
