import { describe as group, expect, it } from "vitest"
import { assess, describe, LIMITS, shouldAlert } from "../src/Usage.ts"

const requests = LIMITS.find((l) => l.metric === "workers_requests")!
const storage = LIMITS.find((l) => l.metric === "prisma_storage")!

group("usage assessment", () => {
  it("stays quiet below 80% when the pace is fine", () => {
    expect(assess(requests, 30_000, 0.5).level).toBe(0)
  })

  it("warns early in the day only on actual usage, not a noisy projection", () => {
    expect(assess(requests, 20_000, 0.1)).toMatchObject({ projected: null, level: 0 })
  })

  it("warns when the current pace would cross the limit before it resets", () => {
    expect(assess(requests, 60_000, 0.5)).toMatchObject({ projected: 120_000, level: 3 })
  })

  it("never projects totals like storage", () => {
    expect(assess(storage, 1_700, 0.9)).toMatchObject({ projected: null, level: 1 })
    expect(assess(storage, 1_960, 0.9).level).toBe(2)
  })

  it("explains the numbers in the message", () => {
    expect(describe(assess(requests, 60_000, 0.5)).split("\n")[0]).toBe(
      "Cloudflare Workers requests (whole account): 60,000 of 100,000 requests per day (60%), on pace for 120,000 (120%)."
    )
  })
})

group("alert de-duplication", () => {
  const now = new Date("2026-11-22T12:00:00Z")
  it("alerts the first time and when a metric climbs a level", () => {
    expect(shouldAlert(1, null, now)).toBe(true)
    expect(shouldAlert(2, { level: 1, sentAt: now }, now)).toBe(true)
  })
  it("does not repeat itself within three days at the same level", () => {
    expect(shouldAlert(1, { level: 1, sentAt: new Date("2026-11-20T12:00:00Z") }, now)).toBe(false)
    expect(shouldAlert(1, { level: 1, sentAt: new Date("2026-11-19T12:00:00Z") }, now)).toBe(true)
  })
  it("never alerts below 80%", () => {
    expect(shouldAlert(0, null, now)).toBe(false)
  })
})
