import { Effect } from "effect"
import { SqlClient } from "effect/sql"

export default Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  yield* sql`
    ALTER TABLE trakt_connection
      -- Trakt rows that matched no catalog title, so later syncs don't try to match them again.
      ADD COLUMN skipped text[] NOT NULL DEFAULT '{}'`
})
