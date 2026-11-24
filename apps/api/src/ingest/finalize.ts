import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import { groupSeries } from "./series.ts"

// Below this many ratings an item's quality is unknown, not average.
const MIN_VOTES = 10

export const finalize = Effect.fn("finalize")(function*() {
  const sql = yield* SqlClient.SqlClient
  yield* sql.unsafe(`
    UPDATE item i SET popularity = s.p
    FROM (SELECT id, percent_rank() OVER (PARTITION BY category ORDER BY COALESCE((meta->>'pop_raw')::float8, 0)) AS p FROM item) s
    WHERE s.id = i.id`)
  yield* sql.unsafe(`UPDATE item SET quality = NULL WHERE quality IS NOT NULL`)
  yield* sql.unsafe(`
    WITH stats AS (
      SELECT category, percentile_cont(0.3) WITHIN GROUP (ORDER BY (meta->>'rating_raw')::float8) AS c,
             GREATEST(percentile_cont(0.5) WITHIN GROUP (ORDER BY quality_votes), 25) AS m
      FROM item WHERE meta ? 'rating_raw' GROUP BY category
    ),
    shrunk AS (
      SELECT i.id, i.category,
             (i.quality_votes / (i.quality_votes + s.m)) * (i.meta->>'rating_raw')::float8
             + (s.m / (i.quality_votes + s.m)) * s.c AS q
      FROM item i JOIN stats s USING (category) WHERE i.meta ? 'rating_raw' AND i.quality_votes >= ${MIN_VOTES}
    )
    UPDATE item i SET quality = r.p
    FROM (SELECT id, percent_rank() OVER (PARTITION BY category ORDER BY q) AS p FROM shrunk) r
    WHERE r.id = i.id`)
  yield* sql.unsafe(`
    UPDATE item i SET polarization = r.p
    FROM (SELECT id, percent_rank() OVER (PARTITION BY category ORDER BY (meta->>'polarization_raw')::float8) AS p
          FROM item WHERE meta ? 'polarization_raw') r
    WHERE r.id = i.id`)
  yield* sql.unsafe(`ANALYZE`)
  yield* groupSeries()
  const counts = yield* sql<{ category: string; n: number; rated: number; polarized: number }>`
    SELECT category::text, count(*)::int AS n, count(quality)::int AS rated, count(polarization)::int AS polarized
    FROM item GROUP BY category ORDER BY category`
  yield* Effect.log("catalog", counts)
})
