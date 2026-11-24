import { Effect } from "effect"
import { SqlClient } from "effect/sql"

// Below this many ratings an item's quality is unknown, not average.
export const MIN_VOTES = 10
// Films and TV rank against their own decade: old titles still being rated are the remembered ones, so a
// catalogue-wide percentile flatters them.
export const QUALITY_PARTITION = "category, CASE WHEN category IN ('movie', 'tv') THEN year / 10 END"
const BATCHES = 8

/**
 * Quality is the shrunk rating's percentile within its partition. Rows are rewritten a slice at a time with a VACUUM in
 * between, so later slices reuse the space earlier ones freed: rewriting the whole table at once doubles it on disk,
 * and storage is the tightest free-tier limit.
 */
export const rankQuality = Effect.fn("rankQuality")(function*() {
  const sql = yield* SqlClient.SqlClient
  const [range] = yield* sql<{ lo: number; hi: number }>`SELECT min(id)::int AS lo, max(id)::int AS hi FROM item`
  if (!range || range.lo === null) return
  const step = Math.ceil((range.hi - range.lo + 1) / BATCHES)
  let changed = 0
  for (let lo = range.lo; lo <= range.hi; lo += step) {
    const rows = yield* sql.unsafe<{ n: number }>(`
      WITH stats AS (
        SELECT category, percentile_cont(0.3) WITHIN GROUP (ORDER BY (meta->>'rating_raw')::float8) AS c,
               GREATEST(percentile_cont(0.5) WITHIN GROUP (ORDER BY quality_votes), 25) AS m
        FROM item WHERE meta ? 'rating_raw' GROUP BY category
      ),
      shrunk AS (
        SELECT i.id, i.category, i.year,
               (i.quality_votes / (i.quality_votes + s.m)) * (i.meta->>'rating_raw')::float8
               + (s.m / (i.quality_votes + s.m)) * s.c AS q
        FROM item i JOIN stats s USING (category) WHERE i.meta ? 'rating_raw' AND i.quality_votes >= ${MIN_VOTES}
      ),
      ranked AS (SELECT id, percent_rank() OVER (PARTITION BY ${QUALITY_PARTITION} ORDER BY q) AS p FROM shrunk),
      target AS (SELECT i.id, r.p FROM item i LEFT JOIN ranked r USING (id) WHERE i.id >= $1 AND i.id < $2),
      done AS (
        UPDATE item i SET quality = t.p FROM target t WHERE i.id = t.id AND i.quality IS DISTINCT FROM t.p::real RETURNING 1
      )
      SELECT count(*)::int AS n FROM done`, [lo, lo + step])
    changed += rows[0]?.n ?? 0
    yield* sql.unsafe(`VACUUM item`)
  }
  yield* Effect.log(`quality: ${changed} items re-ranked`)
})

export const finalize = Effect.fn("finalize")(function*() {
  const sql = yield* SqlClient.SqlClient
  yield* sql.unsafe(`
    UPDATE item i SET popularity = s.p
    FROM (SELECT id, percent_rank() OVER (PARTITION BY category ORDER BY COALESCE((meta->>'pop_raw')::float8, 0)) AS p FROM item) s
    WHERE s.id = i.id`)
  yield* rankQuality()
  yield* sql.unsafe(`
    UPDATE item i SET polarization = r.p
    FROM (SELECT id, percent_rank() OVER (PARTITION BY category ORDER BY (meta->>'polarization_raw')::float8) AS p
          FROM item WHERE meta ? 'polarization_raw') r
    WHERE r.id = i.id`)
  yield* sql.unsafe(`ANALYZE`)
  const counts = yield* sql<{ category: string; n: number; rated: number; polarized: number }>`
    SELECT category::text, count(*)::int AS n, count(quality)::int AS rated, count(polarization)::int AS polarized
    FROM item GROUP BY category ORDER BY category`
  yield* Effect.log("catalog", counts)
})
