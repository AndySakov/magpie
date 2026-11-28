declare const __BUILD_ID__: string

const CHECK_EVERY_MS = 10 * 60_000
const RECHECK_AFTER_MS = 60_000
const IDLE_MS = 30_000
const SW_WAIT_MS = 15_000
const ATTEMPT_KEY = "magpie:reload-for"

let lastCheck = 0
let pendingReload = false
let lastInput = Date.now()

const deployed = async (): Promise<string | null> => {
  try {
    const r = await fetch("/version.json", { cache: "no-store" })
    if (!r.ok) return null
    const body = (await r.json()) as { build?: unknown }
    return typeof body.build === "string" ? body.build : null
  } catch {
    return null
  }
}

// Reloading under the old service worker would serve the old precached bundle again, so wait for the new one first.
const takeNewWorker = async () => {
  if (!("serviceWorker" in navigator)) return
  const reg = await navigator.serviceWorker.getRegistration()
  if (!reg) return
  const changed = new Promise<void>((resolve) => navigator.serviceWorker.addEventListener("controllerchange", () => resolve(), { once: true }))
  await reg.update().catch(() => {})
  if (!reg.installing && !reg.waiting) return
  await Promise.race([changed, new Promise((resolve) => setTimeout(resolve, SW_WAIT_MS))])
}

const typing = () => {
  const el = document.activeElement
  return el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement
}

const reloadSoon = () => {
  if (pendingReload) return
  pendingReload = true
  const go = () => {
    if (document.visibilityState === "visible" && (Date.now() - lastInput < IDLE_MS || typing())) return
    window.location.reload()
  }
  document.addEventListener("visibilitychange", go)
  setInterval(go, 5_000)
  go()
}

const check = async () => {
  if (pendingReload || Date.now() - lastCheck < RECHECK_AFTER_MS) return
  lastCheck = Date.now()
  const build = await deployed()
  if (build === null || build === __BUILD_ID__) return
  // One reload per deployed build: if it still serves the old bundle, don't loop.
  try {
    if (sessionStorage.getItem(ATTEMPT_KEY) === build) return
    sessionStorage.setItem(ATTEMPT_KEY, build)
  } catch {
    // Without session storage there's no loop guard, so skip the reload.
    return
  }
  await takeNewWorker()
  reloadSoon()
}

/** Reloads a running client onto a newer deploy, when the reload won't interrupt anything. */
export const watchForDeploys = () => {
  if (__BUILD_ID__.length === 0 || import.meta.env.DEV) return
  for (const e of ["pointerdown", "keydown", "touchstart"]) window.addEventListener(e, () => (lastInput = Date.now()), { passive: true })
  document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && void check())
  setInterval(() => document.visibilityState === "visible" && void check(), CHECK_EVERY_MS)
  setTimeout(() => void check(), 5_000)
}

/** This bundle's build, as "<commit>, <build date>" when the id has the default shape. */
export const buildLabel = () => {
  const [commit, stamp] = __BUILD_ID__.split("-")
  const at = stamp ? new Date(parseInt(stamp, 36)) : null
  return commit && at && !Number.isNaN(at.getTime())
    ? `${commit}, ${at.toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}`
    : __BUILD_ID__
}

/** Drops the service worker and its caches, then reloads, so the next load comes from the network. Local data and the session are kept. */
export const forceUpdate = async () => {
  try {
    const regs = (await navigator.serviceWorker?.getRegistrations()) ?? []
    await Promise.all(regs.map((r) => r.unregister()))
  } catch {
    // Without service worker access there's nothing to drop; the reload still fetches index.html.
  }
  try {
    await Promise.all((await caches.keys()).map((k) => caches.delete(k)))
  } catch {
    // Same as above.
  }
  window.location.reload()
}
