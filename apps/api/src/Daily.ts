import { Context, Effect, Layer, Option, Schema } from "effect"
import { SqlClient } from "effect/sql"
import { Availability } from "./Availability.ts"
import { EMBED_MODEL } from "./catalog.ts"
import { Embedder } from "./Embedder.ts"
import { type Assessment, assess, describe, LIMITS, shouldAlert } from "./Usage.ts"
import { QUALITY_PARTITION } from "./ingest/finalize.ts"

export interface Mailer {
  send(message: { from: string; to: string; subject: string; text: string }): Promise<unknown>
}

export interface DailyConfig {
  readonly accountId: string
  readonly scriptName: string
  /** Read-only Cloudflare token with Account Analytics: Read. Without it only database metrics are checked. */
  readonly analyticsToken: Option.Option<string>
  readonly mail: Option.Option<{ readonly mailer: Mailer; readonly from: string; readonly to: string }>
}

const MAINTENANCE_HOUR_UTC = 3
// TMDB requests per hourly run. Free Workers allow 50 subrequests per invocation, and the usage check needs a few.
const SWEEP_BUDGET = 30
const MB = 1024 * 1024

const Analytics = Schema.Struct({
  data: Schema.Struct({
    viewer: Schema.Struct({
      accounts: Schema.Array(Schema.Struct({
        requests: Schema.Array(Schema.Struct({ sum: Schema.Struct({ requests: Schema.Number }) })),
        script: Schema.Array(Schema.Struct({
          sum: Schema.Struct({ requests: Schema.Number }),
          quantiles: Schema.Struct({ cpuTimeP99: Schema.Number }),
          dimensions: Schema.Struct({ status: Schema.String })
        })),
        hyperdrive: Schema.Array(Schema.Struct({ count: Schema.Number })),
        ai: Schema.Array(Schema.Struct({ sum: Schema.Struct({ totalNeurons: Schema.Number }) }))
      }))
    })
  })
})

const ANALYTICS_QUERY = `query($a: String!, $d: Date!, $s: String!) { viewer { accounts(filter: { accountTag: $a }) {
  requests: workersInvocationsAdaptive(limit: 10000, filter: { date: $d }) { sum { requests } }
  script: workersInvocationsAdaptive(limit: 10, filter: { date: $d, scriptName: $s }) { sum { requests } quantiles { cpuTimeP99 } dimensions { status } }
  hyperdrive: hyperdriveQueriesAdaptiveGroups(limit: 10000, filter: { date: $d }) { count }
  ai: aiInferenceAdaptiveGroups(limit: 10000, filter: { date: $d }) { sum { totalNeurons } }
} } }`

const sum = (xs: ReadonlyArray<number>) => xs.reduce((a, b) => a + b, 0)

export class Daily extends Context.Service<Daily, {
  run(now: Date): Effect.Effect<void>
}>()("magpie/Daily") {
  static readonly layer = (config: DailyConfig) =>
    Layer.effect(
      Daily,
      Effect.gen(function*() {
        const sql = yield* SqlClient.SqlClient
        const embedder = yield* Embedder
        const availability = yield* Availability

        const embedMissing = Effect.gen(function*() {
          const rows = yield* sql<{ id: number }>`
            SELECT i.id::int AS id FROM item i
            WHERE i.meta ? 'enriched_at'
              AND NOT EXISTS (SELECT 1 FROM item_embedding e WHERE e.item_id = i.id AND e.model = ${EMBED_MODEL})
            LIMIT 300`
          const n = yield* embedder.embedItems(rows.map((r) => r.id))
          yield* Effect.log(`embedded ${n} of ${rows.length} enriched items`)
        })

        // Ranks enriched items against the catalog without rewriting existing rows: a full-table UPDATE would double
        // the item table on disk until vacuum, and storage is the tightest free-tier limit.
        const rankFresh = sql.withTransaction(Effect.gen(function*() {
          yield* sql`
            WITH fresh AS (SELECT id, category FROM item WHERE meta ? 'enriched_at' AND NOT meta ? 'ranked_at'),
            stats AS (
              SELECT category, percentile_cont(0.3) WITHIN GROUP (ORDER BY (meta->>'rating_raw')::float8) AS c,
                     GREATEST(percentile_cont(0.5) WITHIN GROUP (ORDER BY quality_votes), 25) AS m
              FROM item WHERE meta ? 'rating_raw' AND category IN (SELECT category FROM fresh) GROUP BY category
            ),
            shrunk AS (
              SELECT i.id, i.category, i.year,
                     (i.quality_votes / (i.quality_votes + s.m)) * (i.meta->>'rating_raw')::float8
                     + (s.m / (i.quality_votes + s.m)) * s.c AS q
              FROM item i JOIN stats s USING (category) WHERE i.meta ? 'rating_raw' AND i.quality_votes >= 10
            ),
            ranked AS (SELECT id, percent_rank() OVER (PARTITION BY ${sql.literal(QUALITY_PARTITION)} ORDER BY q) AS p FROM shrunk)
            UPDATE item i SET quality = r.p FROM ranked r JOIN fresh f USING (id) WHERE i.id = r.id`
          const updated = yield* sql<{ n: number }>`
            WITH fresh AS (SELECT id, category FROM item WHERE meta ? 'enriched_at' AND NOT meta ? 'ranked_at'),
            ranked AS (
              SELECT id, percent_rank() OVER (PARTITION BY category ORDER BY COALESCE((meta->>'pop_raw')::float8, 0)) AS p
              FROM item WHERE category IN (SELECT category FROM fresh)
            ),
            done AS (
              UPDATE item i SET popularity = r.p, meta = i.meta || jsonb_build_object('ranked_at', now())
              FROM ranked r JOIN fresh f USING (id) WHERE i.id = r.id RETURNING 1
            )
            SELECT count(*)::int AS n FROM done`
          yield* Effect.log(`ranked ${updated[0]?.n ?? 0} enriched items`)
        }))

        const analytics = (token: string, day: string) =>
          Effect.tryPromise(() =>
            fetch("https://api.cloudflare.com/client/v4/graphql", {
              method: "POST",
              headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
              body: JSON.stringify({ query: ANALYTICS_QUERY, variables: { a: config.accountId, d: day, s: config.scriptName } })
            }).then((r) => r.json())
          ).pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(Analytics)),
            Effect.map((r) => r.data.viewer.accounts[0]!)
          )

        const record = (day: string, metric: string, value: number) =>
          sql`INSERT INTO usage_daily (day, metric, value) VALUES (${day}::date, ${metric}, ${value})
              ON CONFLICT (day, metric) DO UPDATE SET value = EXCLUDED.value`

        const checkUsage = Effect.fn("Daily.checkUsage")(function*(now: Date) {
          const day = now.toISOString().slice(0, 10)
          const dayElapsed = (now.getTime() - Date.parse(`${day}T00:00:00Z`)) / 86_400_000
          const monthStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)
          const monthEnd = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)
          const monthElapsed = (now.getTime() - monthStart) / (monthEnd - monthStart)
          const used = new Map<string, { value: number; elapsed: number }>()

          const [size] = yield* sql<{ bytes: number }>`SELECT pg_database_size(current_database())::float8 AS bytes`
          used.set("prisma_storage", { value: size!.bytes / MB, elapsed: 1 })

          if (Option.isSome(config.analyticsToken)) {
            const a = yield* analytics(config.analyticsToken.value, day)
            const queries = sum(a.hyperdrive.map((h) => h.count))
            used.set("workers_requests", { value: sum(a.requests.map((r) => r.sum.requests)), elapsed: dayElapsed })
            used.set("hyperdrive_queries", { value: queries, elapsed: dayElapsed })
            used.set("ai_neurons", { value: sum(a.ai.map((r) => r.sum.totalNeurons)), elapsed: dayElapsed })
            used.set("workers_cpu_p99", { value: Math.max(0, ...a.script.map((s) => s.quantiles.cpuTimeP99)) / 1000, elapsed: 1 })
            used.set("workers_cpu_exceeded", {
              value: sum(a.script.filter((s) => s.dimensions.status.startsWith("exceeded")).map((s) => s.sum.requests)),
              elapsed: 1
            })
            yield* record(day, "hyperdrive_queries", queries)
            const [month] = yield* sql<{ total: number }>`
              SELECT COALESCE(sum(value), 0)::float8 AS total FROM usage_daily
              WHERE metric = 'hyperdrive_queries' AND day >= date_trunc('month', ${day}::date)`
            used.set("prisma_operations", { value: month!.total, elapsed: monthElapsed })
          }

          const assessments = LIMITS.flatMap((limit) => {
            const u = used.get(limit.metric)
            return u ? [assess(limit, u.value, u.elapsed)] : []
          })
          const previous = new Map(
            (yield* sql<{ metric: string; level: number; sent_at: Date }>`SELECT metric, level, sent_at FROM usage_alert`)
              .map((r) => [r.metric, { level: r.level, sentAt: new Date(r.sent_at) }])
          )
          const due: Array<Assessment> = assessments.filter((a) => shouldAlert(a.level, previous.get(a.limit.metric) ?? null, now))
          const calm = assessments.filter((a) => a.level === 0).map((a) => a.limit.metric)
          yield* sql`DELETE FROM usage_alert WHERE metric = ANY(${calm}::text[])`
          if (due.length === 0) return
          const text = [
            "Magpie is getting close to a free-tier limit:",
            "",
            ...due.map(describe),
            "",
            "Everything else being watched:",
            ...assessments.filter((a) => !due.includes(a)).map((a) => `- ${describe(a).split("\n")[0]}`)
          ].join("\n")
          yield* Effect.logWarning(text)
          if (Option.isNone(config.mail)) return
          const { mailer, from, to } = config.mail.value
          const worst = Math.max(...due.map((a) => a.level))
          yield* Effect.tryPromise(() =>
            mailer.send({ from, to, subject: `Magpie: ${worst >= 3 ? "over" : "near"} a free-tier limit (${due.map((a) => a.limit.label.split(" (")[0]).join(", ")})`, text })
          )
          for (const a of due) {
            yield* sql`INSERT INTO usage_alert (metric, level, sent_at) VALUES (${a.limit.metric}, ${a.level}, ${now})
                       ON CONFLICT (metric) DO UPDATE SET level = EXCLUDED.level, sent_at = EXCLUDED.sent_at`
          }
        })

        const run = Effect.fn("Daily.run")(function*(now: Date) {
          if (now.getUTCHours() === MAINTENANCE_HOUR_UTC) {
            yield* embedMissing.pipe(Effect.catchCause((c) => Effect.logError("embedding sweep failed", c)))
            yield* rankFresh.pipe(Effect.catchCause((c) => Effect.logError("ranking failed", c)))
          }
          yield* availability.sweep(SWEEP_BUDGET).pipe(
            Effect.tap((r) => Effect.log(`availability sweep: ${r.requests} requests, ${r.finished} lists finished`)),
            Effect.catchCause((c) => Effect.logError("availability sweep failed", c))
          )
          yield* checkUsage(now).pipe(Effect.catchCause((c) => Effect.logError("usage check failed", c)))
        })

        return Daily.of({ run })
      })
    )
}
