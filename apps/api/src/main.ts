import { NodeHttpServer, NodeRuntime } from "@effect/platform-node"
import { Config, Effect, Layer } from "effect"
import { HttpMiddleware, HttpRouter } from "effect/http"
import { createServer } from "node:http"
import { DbLive } from "./Db.ts"
import { Embedder } from "./Embedder.ts"
import { ApiLive, AuthenticationLive } from "./Http.ts"

const ServerLive = Layer.unwrap(
  Effect.map(Config.Port("PORT").pipe(Config.withDefault(3000)), (port) =>
    NodeHttpServer.layer(createServer, { port }))
)

HttpRouter.serve(ApiLive, { middleware: HttpMiddleware.logger }).pipe(
  Layer.provide(AuthenticationLive),
  Layer.provide(Embedder.none),
  Layer.provide(DbLive),
  Layer.provide(ServerLive),
  Layer.launch,
  NodeRuntime.runMain
)
