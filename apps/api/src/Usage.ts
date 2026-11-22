export type Period = "day" | "month" | "total"

export interface Limit {
  readonly metric: string
  readonly label: string
  readonly limit: number
  readonly period: Period
  readonly unit: string
  readonly advice: string
}

/** Free-tier ceilings this deployment depends on. Daily limits reset at 00:00 UTC, Prisma's monthly one on the 1st. */
export const LIMITS: ReadonlyArray<Limit> = [
  {
    metric: "workers_requests",
    label: "Cloudflare Workers requests (whole account)",
    limit: 100_000,
    period: "day",
    unit: "requests",
    advice: "Shared by every Worker on the account. Past the limit Cloudflare answers with error 1027 until midnight UTC. Workers Paid lifts it."
  },
  {
    metric: "workers_cpu_p99",
    label: "Magpie p99 CPU time per request",
    limit: 10,
    period: "total",
    unit: "ms",
    advice: "Requests over 10 ms of CPU get cut off on the free plan. Look at the slowest routes in Workers Logs."
  },
  {
    metric: "workers_cpu_exceeded",
    label: "Magpie requests cut off for CPU",
    limit: 1,
    period: "total",
    unit: "requests",
    advice: "These users saw an error. Look at the slowest routes in Workers Logs."
  },
  {
    metric: "hyperdrive_queries",
    label: "Hyperdrive queries (whole account)",
    limit: 100_000,
    period: "day",
    unit: "queries",
    advice: "Past the limit every database query fails until midnight UTC."
  },
  {
    metric: "ai_neurons",
    label: "Workers AI neurons (whole account)",
    limit: 10_000,
    period: "day",
    unit: "neurons",
    advice: "Past the limit new titles are stored without embeddings. The 03:00 UTC job catches up the next day."
  },
  {
    metric: "prisma_operations",
    label: "Prisma Postgres operations (counted from Hyperdrive queries)",
    limit: 200_000,
    period: "month",
    unit: "operations",
    advice: "Past the limit Prisma refuses every query until the 1st. Prisma Starter is $10/month."
  },
  {
    metric: "prisma_storage",
    label: "Prisma Postgres storage",
    limit: 2048,
    period: "total",
    unit: "MB",
    advice: "Past the limit writes fail. The catalog is most of it: ml_rating is the largest table."
  }
]

export const LEVELS = [0.8, 0.95, 1] as const

export interface Assessment {
  readonly limit: Limit
  readonly used: number
  /** Where usage ends up at the current rate by the time the limit resets, when it is worth extrapolating. */
  readonly projected: number | null
  /** 0 below 80% of the limit, then 1, 2, 3 at 80%, 95% and 100%, taking the projection into account. */
  readonly level: number
}

/** `elapsed` is the share of the current period gone by, in [0, 1]. Projections start once a quarter of it has passed. */
export const assess = (limit: Limit, used: number, elapsed: number): Assessment => {
  const projected = limit.period !== "total" && elapsed >= 0.25 ? used / elapsed : null
  const worst = Math.max(used, projected ?? 0) / limit.limit
  const level = LEVELS.filter((l) => worst >= l).length
  return { limit, used, projected, level }
}

const RESEND_AFTER_MS = 3 * 24 * 60 * 60 * 1000

/** Alert when a metric climbs a level, and remind every three days while it stays above 80%. */
export const shouldAlert = (level: number, previous: { readonly level: number; readonly sentAt: Date } | null, now: Date) => {
  if (level === 0) return false
  if (previous === null || level > previous.level) return true
  return now.getTime() - previous.sentAt.getTime() >= RESEND_AFTER_MS
}

const fmt = (n: number) => (n >= 100 || Number.isInteger(n) ? Math.round(n).toLocaleString("en-US") : n.toFixed(1))

export const describe = (a: Assessment) => {
  const pct = Math.round((a.used / a.limit.limit) * 100)
  const per = a.limit.period === "total" ? "" : ` per ${a.limit.period}`
  const projection = a.projected === null ? "" : `, on pace for ${fmt(a.projected)} (${Math.round((a.projected / a.limit.limit) * 100)}%)`
  return `${a.limit.label}: ${fmt(a.used)} of ${fmt(a.limit.limit)} ${a.limit.unit}${per} (${pct}%)${projection}.\n  ${a.limit.advice}`
}
