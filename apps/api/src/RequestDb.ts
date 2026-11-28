import { PgClient } from "@effect/sql-pg"
import { Context, Effect, Layer } from "effect"
import * as Reactivity from "effect/reactivity/Reactivity"
import { SqlClient } from "effect/sql"

/**
 * The database client of the request being served. Workers tie a socket to the request that opened it,
 * so services built once share one SqlClient whose connections come from here.
 */
export const RequestSql = Context.Reference<SqlClient.SqlClient | null>("magpie/RequestSql", { defaultValue: () => null })

const lease = Effect.flatMap(Effect.service(RequestSql), (db) => db === null ? Effect.die("No database client for this request") : db.reserve).pipe(
  Effect.withSpan("db.acquire")
)

export const SharedSqlLive = Layer.effect(
  SqlClient.SqlClient,
  SqlClient.make({
    driver: "pg",
    acquirer: lease,
    transactionAcquirer: lease,
    compiler: PgClient.makeCompiler(),
    spanAttributes: [],
    prepareTransactionControls: true
  })
).pipe(Layer.provide(Reactivity.layer))
