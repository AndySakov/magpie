import { NodeRuntime, NodeServices } from "@effect/platform-node"
import { PgMigrator } from "@effect/sql-pg"
import { Effect, Layer } from "effect"
import { fileURLToPath } from "node:url"
import { PgLive } from "./Db.ts"

PgMigrator.run({
  loader: PgMigrator.fromFileSystem(fileURLToPath(new URL("./migrations", import.meta.url)))
}).pipe(
  Effect.tap((applied) => Effect.log(`applied ${applied.length} migration(s)`, applied)),
  Effect.provide(Layer.merge(PgLive, NodeServices.layer)),
  NodeRuntime.runMain
)
