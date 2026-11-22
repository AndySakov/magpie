import { NodeRuntime } from "@effect/platform-node"
import { pipeline } from "@huggingface/transformers"
import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import { PgLive } from "../Db.ts"
import { EMBED_MODEL, type EmbedRow, embedText } from "../catalog.ts"
import { chunk } from "./lib.ts"

const PAGE = 2048
const BATCH = 128

const program = Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  const extract = yield* Effect.promise(() => pipeline("feature-extraction", EMBED_MODEL, { dtype: "q8" }))
  let done = 0
  const started = Date.now()
  while (true) {
    const rows = yield* sql<EmbedRow & { readonly id: number }>`
      SELECT i.id::int AS id, i.category::text AS category, i.title, i.year, i.synopsis, i.genres, i.tags,
             (SELECT string_agg(c.name, ', ') FROM (
                SELECT c.name FROM item_creator ic JOIN creator c ON c.id = ic.creator_id
                WHERE ic.item_id = i.id LIMIT 3) c) AS creators
      FROM item i
      WHERE NOT EXISTS (SELECT 1 FROM item_embedding e WHERE e.item_id = i.id AND e.model = ${EMBED_MODEL})
      ORDER BY i.popularity DESC
      LIMIT ${PAGE}`
    if (rows.length === 0) break
    const out: Array<{ id: number; v: string }> = []
    const sorted = rows.map((r) => ({ id: r.id, text: embedText(r) })).sort((a, b) => a.text.length - b.text.length)
    for (const batch of chunk(sorted, BATCH)) {
      const tensor = yield* Effect.promise(() => extract(batch.map((b) => b.text), { pooling: "cls", normalize: true }))
      const vectors = tensor.tolist() as Array<Array<number>>
      batch.forEach((r, i) => out.push({ id: r.id, v: `[${vectors[i]!.map((x) => x.toFixed(6)).join(",")}]` }))
    }
    yield* sql.unsafe(
      `INSERT INTO item_embedding (item_id, model, embedding)
       SELECT x.id, $2, x.v::halfvec(384) FROM jsonb_to_recordset($1::jsonb) AS x(id bigint, v text)
       ON CONFLICT (item_id, model) DO UPDATE SET embedding = EXCLUDED.embedding`,
      [JSON.stringify(out), EMBED_MODEL]
    )
    done += rows.length
    const rate = done / ((Date.now() - started) / 1000)
    yield* Effect.log(`embedded ${done} items (${rate.toFixed(0)}/s)`)
  }
})

if (import.meta.url === `file://${process.argv[1]}`) {
  program.pipe(Effect.provide(PgLive), NodeRuntime.runMain)
}
