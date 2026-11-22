import { Effect } from "effect"
import { SqlClient } from "effect/sql"

export default Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  yield* sql`DROP INDEX IF EXISTS item_embedding_hnsw`
  yield* sql`ALTER TABLE item_embedding ALTER COLUMN embedding TYPE halfvec(384) USING embedding::halfvec(384)`
  yield* sql`CREATE INDEX item_embedding_hnsw ON item_embedding USING hnsw (embedding halfvec_cosine_ops)`
})
