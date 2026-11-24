import { Effect } from "effect"
import { SqlClient } from "effect/sql"

export default Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  yield* sql`CREATE INDEX item_original_title_trgm ON item USING gin (lower(original_title) gin_trgm_ops)`
})
