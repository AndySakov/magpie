import { Effect } from "effect"
import { SqlClient } from "effect/sql"

export default Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  yield* sql`
    ALTER TABLE item
      -- Anime seasons, OVAs and spin-offs of one show share the id of the entry the deck shows for it.
      ADD COLUMN series bigint`
})
