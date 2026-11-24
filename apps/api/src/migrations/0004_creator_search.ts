import { Effect } from "effect"
import { SqlClient } from "effect/sql"

export default Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  yield* sql`CREATE INDEX creator_name_trgm ON creator USING gin (lower(name) gin_trgm_ops)`
})
