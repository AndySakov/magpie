import { Effect } from "effect"
import { SqlClient } from "effect/sql"

export default Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  yield* sql`CREATE UNIQUE INDEX app_user_name_lower ON app_user (lower(name))`
})
