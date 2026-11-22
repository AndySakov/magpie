import { Effect } from "effect"
import { SqlClient } from "effect/sql"

export default Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  yield* sql`
    CREATE TABLE usage_daily (
      day date NOT NULL,
      metric text NOT NULL,
      value float8 NOT NULL,
      PRIMARY KEY (day, metric)
    )`
  yield* sql`
    CREATE TABLE usage_alert (
      metric text PRIMARY KEY,
      level int NOT NULL,
      sent_at timestamptz NOT NULL
    )`
})
