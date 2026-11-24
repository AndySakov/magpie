import { Context, Effect, Layer } from "effect"
import { SqlClient } from "effect/sql"
import { EMBED_MODEL, type EmbedRow, embedText } from "./catalog.ts"

export interface WorkersAi {
  run(model: string, input: { text: ReadonlyArray<string>; pooling: "cls" }): Promise<{ data: ReadonlyArray<ReadonlyArray<number>> }>
}

// Workers AI caps a bge request at 100 texts.
const BATCH = 100

/** Stores embeddings for items that lack one. Without a model (local dev) it does nothing: `pnpm embed` covers that. */
export class Embedder extends Context.Service<Embedder, {
  embedItems(ids: ReadonlyArray<number>): Effect.Effect<number>
}>()("magpie/Embedder") {
  static readonly none = Layer.succeed(Embedder, Embedder.of({ embedItems: () => Effect.succeed(0) }))

  // Same model as the local Xenova q8 one; with CLS pooling the vectors agree to cosine >= 0.99.
  static readonly workersAi = (ai: WorkersAi) =>
    Layer.effect(
      Embedder,
      Effect.gen(function*() {
        const sql = yield* SqlClient.SqlClient
        const embedItems = Effect.fn("Embedder.embedItems")(function*(ids: ReadonlyArray<number>) {
          if (ids.length === 0) return 0
          const rows = yield* sql<EmbedRow & { readonly id: number }>`
            SELECT i.id::int AS id, i.category::text AS category, i.title, i.year, i.synopsis, i.genres, i.tags,
                   (SELECT string_agg(c.name, ', ') FROM (
                      SELECT c.name FROM item_creator ic JOIN creator c ON c.id = ic.creator_id
                      WHERE ic.item_id = i.id LIMIT 3) c) AS creators
            FROM item i
            WHERE i.id = ANY(${ids}::bigint[])
              AND NOT EXISTS (SELECT 1 FROM item_embedding e WHERE e.item_id = i.id AND e.model = ${EMBED_MODEL})`
          let stored = 0
          for (let start = 0; start < rows.length; start += BATCH) {
            const batch = rows.slice(start, start + BATCH)
            const { data } = yield* Effect.tryPromise(() => ai.run("@cf/baai/bge-small-en-v1.5", { text: batch.map(embedText), pooling: "cls" }))
            yield* sql`
              INSERT INTO item_embedding (item_id, model, embedding)
              SELECT x.id, ${EMBED_MODEL}, l2_normalize(x.v::text::vector)::halfvec(384)
              FROM jsonb_to_recordset(${JSON.stringify(batch.map((r, i) => ({ id: r.id, v: data[i] })))}::jsonb) AS x(id bigint, v jsonb)
              ON CONFLICT (item_id, model) DO NOTHING`
            stored += batch.length
          }
          return stored
        }, Effect.tapCause((cause) => Effect.logWarning("embedding failed", cause)), Effect.orElseSucceed(() => 0))
        return Embedder.of({ embedItems })
      })
    )
}
