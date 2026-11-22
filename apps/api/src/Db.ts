import { NodeServices } from "@effect/platform-node"
import { PgClient, PgMigrator } from "@effect/sql-pg"
import { Config, Layer } from "effect"
import { fileURLToPath } from "node:url"

export const PgLive = PgClient.layerConfig({
  url: Config.Redacted("DATABASE_URL"),
  maxConnections: Config.Int("DATABASE_MAX_CONNECTIONS").pipe(Config.withDefault(10))
})

export const MigratorLive = PgMigrator.layer({
  loader: PgMigrator.fromFileSystem(fileURLToPath(new URL("./migrations", import.meta.url)))
}).pipe(Layer.provide(NodeServices.layer))

export const DbLive = MigratorLive.pipe(Layer.provideMerge(PgLive))
