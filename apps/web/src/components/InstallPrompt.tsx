import { useEffect, useState } from "react"
import { Icon, Sheet } from "../ui"

/** Fired by the deck on every swipe, so the prompt waits until someone is actually using the app. */
export const DECIDED = "magpie:decided"
const SWIPES_BEFORE_ASKING = 5
const DISMISSED_KEY = "magpie.install-dismissed-at"
const QUIET_DAYS = 30

interface InstallEvent extends Event {
  prompt(): Promise<void>
  readonly userChoice: Promise<{ readonly outcome: "accepted" | "dismissed" }>
}

// Chrome fires this once, early, possibly before React mounts: keep it for when the prompt is shown.
let deferred: InstallEvent | null = null
const listeners = new Set<() => void>()
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault()
  deferred = e as InstallEvent
  for (const l of listeners) l()
})
window.addEventListener("appinstalled", () => {
  deferred = null
  for (const l of listeners) l()
})

const installed = () =>
  window.matchMedia("(display-mode: standalone)").matches || (navigator as { standalone?: boolean }).standalone === true
const ios = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)

const recentlyDismissed = () => {
  try {
    const at = Number(localStorage.getItem(DISMISSED_KEY))
    return at > 0 && Date.now() - at < QUIET_DAYS * 86_400_000
  } catch {
    return false
  }
}

/** A one-time sheet offering to add Magpie to the home screen, after a few swipes. */
export function InstallPrompt() {
  const [canPrompt, setCanPrompt] = useState(deferred !== null)
  const [swipes, setSwipes] = useState(0)
  const [open, setOpen] = useState(false)
  const eligible = !installed() && !recentlyDismissed() && (canPrompt || ios())

  useEffect(() => {
    const update = () => setCanPrompt(deferred !== null)
    listeners.add(update)
    const onDecided = () => setSwipes((n) => n + 1)
    window.addEventListener(DECIDED, onDecided)
    return () => {
      listeners.delete(update)
      window.removeEventListener(DECIDED, onDecided)
    }
  }, [])

  useEffect(() => {
    if (eligible && swipes === SWIPES_BEFORE_ASKING) setOpen(true)
  }, [eligible, swipes])

  const dismiss = () => {
    setOpen(false)
    try {
      localStorage.setItem(DISMISSED_KEY, String(Date.now()))
    } catch {
      // Without storage it may ask again next session.
    }
  }

  const install = async () => {
    const e = deferred
    if (!e) return
    await e.prompt()
    const { outcome } = await e.userChoice
    deferred = null
    if (outcome === "accepted") setOpen(false)
    else dismiss()
  }

  return (
    <Sheet open={open} onClose={dismiss} label="Add Magpie to your home screen">
      <div className="install">
        <img src="/icon-192.png" alt="" width={72} height={72} />
        <h2>Keep Magpie on your home screen</h2>
        <p>It opens full screen, straight onto your deck, like any other app.</p>
        {canPrompt ? (
          <button type="button" className="btn btn-primary" onClick={() => void install()}>
            <Icon.Plus />
            Add to home screen
          </button>
        ) : (
          <ol className="install-steps">
            <li>
              Tap <ShareGlyph /> <strong>Share</strong> in the browser bar
            </li>
            <li>
              Choose <strong>Add to Home Screen</strong>
            </li>
          </ol>
        )}
        <button type="button" className="btn" onClick={dismiss}>
          Not now
        </button>
      </div>
    </Sheet>
  )
}

function ShareGlyph() {
  return (
    <svg className="share-glyph" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3v12M7 8l5-5 5 5M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7" />
    </svg>
  )
}
