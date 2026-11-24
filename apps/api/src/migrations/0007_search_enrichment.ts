import { Effect } from "effect"
import { SqlClient } from "effect/sql"

export default Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  yield* sql`
    CREATE TABLE search_enrichment (
      query text PRIMARY KEY,
      searched_at timestamptz NOT NULL DEFAULT now()
    )`
})
