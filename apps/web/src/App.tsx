import type { User } from "@magpie/contract"
import { motion, MotionConfig } from "motion/react"
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { api, ApiError, SIGNED_OUT, type PreferencesInput } from "./api"
import { Deck } from "./screens/Deck"
import { Imports } from "./screens/Imports"
import { Onboarding } from "./screens/Onboarding"
import { Settings } from "./screens/Settings"
import { Library } from "./screens/Library"
import { Join, SignIn } from "./screens/Welcome"
import { SessionContext, type Session } from "./session"
import { Icon } from "./ui"

type Tab = "deck" | "library" | "imports" | "settings"
const TABS: ReadonlyArray<{ id: Tab; label: string; icon: () => ReactNode }> = [
  { id: "deck", label: "Deck", icon: Icon.Deck },
  { id: "library", label: "Library", icon: Icon.Hoard },
  { id: "imports", label: "Imports", icon: Icon.Import },
  { id: "settings", label: "Settings", icon: Icon.Sliders }
]

const readTab = (): Tab => {
  const t = location.hash.replace(/^#\/?/, "")
  return TABS.some((x) => x.id === t) ? (t as Tab) : "deck"
}

const useTab = () => {
  const [tab, setTab] = useState<Tab>(readTab)
  useEffect(() => {
    const on = () => setTab(readTab())
    window.addEventListener("hashchange", on)
    return () => window.removeEventListener("hashchange", on)
  }, [])
  return [tab, (t: Tab) => (location.hash = `/${t}`)] as const
}

type Boot =
  | { tag: "loading" }
  | { tag: "signedOut"; notice: string | null }
  | { tag: "join"; token: string }
  | { tag: "failed"; message: string }
  | { tag: "ready"; user: User; prefs: PreferencesInput }

const readInvite = () => /^#join=([\w-]+)$/.exec(location.hash)?.[1] ?? null
const clearHash = () => history.replaceState(null, "", location.pathname + location.search)

export function App() {
  const [boot, setBoot] = useState<Boot>(() => {
    const token = readInvite()
    return token ? { tag: "join", token } : { tag: "loading" }
  })
  const [hoardPulse, setHoardPulse] = useState(0)

  const load = useCallback(async (known?: User) => {
    setBoot({ tag: "loading" })
    try {
      const [user, prefs] = await Promise.all([known ?? api.me(), api.preferences()])
      setBoot({ tag: "ready", user, prefs })
    } catch (e) {
      if (e instanceof ApiError && e.kind === "Unauthenticated") setBoot({ tag: "signedOut", notice: null })
      else setBoot({ tag: "failed", message: (e as Error).message })
    }
  }, [])

  useEffect(() => {
    if (boot.tag === "loading") void load()
    const onSignedOut = () =>
      setBoot((b) => (b.tag === "ready" ? { tag: "signedOut", notice: "Your session ended. Sign in again." } : b))
    window.addEventListener(SIGNED_OUT, onSignedOut)
    return () => window.removeEventListener(SIGNED_OUT, onSignedOut)
  }, [])

  const signedIn = useCallback((user: User) => {
    clearHash()
    void load(user)
  }, [load])

  const signOut = useCallback(() => {
    void api.signOut().catch(() => undefined)
    clearHash()
    setBoot({ tag: "signedOut", notice: null })
  }, [])

  const ready = boot.tag === "ready"
  const prefsRef = useRef<PreferencesInput | null>(null)
  prefsRef.current = boot.tag === "ready" ? boot.prefs : null
  const savePrefs = useCallback(
    async (update: (prev: PreferencesInput) => PreferencesInput) => {
      const prev = prefsRef.current
      if (!ready || prev === null) return
      const next = update(prev)
      prefsRef.current = next
      setBoot((b) => (b.tag === "ready" ? { ...b, prefs: next } : b))
      try {
        const saved = await api.setPreferences(next)
        setBoot((b) => (b.tag === "ready" && b.prefs === next ? { ...b, prefs: saved } : b))
      } catch (e) {
        setBoot((b) => (b.tag === "ready" && b.prefs === next ? { ...b, prefs: prev } : b))
        throw e
      }
    },
    [ready]
  )

  const session = useMemo<Session | null>(
    () =>
      boot.tag === "ready"
        ? { user: boot.user, prefs: boot.prefs, savePrefs, signOut, pulseHoard: () => setHoardPulse((n) => n + 1) }
        : null,
    [boot, savePrefs, signOut]
  )

  return (
    <MotionConfig reducedMotion="user">
      {boot.tag === "signedOut" && <SignIn notice={boot.notice} onSignedIn={signedIn} />}
      {boot.tag === "join" && (
        <Join token={boot.token} onSignedIn={signedIn} onUseSignIn={() => (clearHash(), setBoot({ tag: "signedOut", notice: null }))} />
      )}
      {boot.tag === "loading" && (
        <main className="profiles" aria-busy="true">
          <div className="brand">
            <img src="/icon.svg" alt="" />
            <span className="brand-name">Magpie</span>
          </div>
        </main>
      )}
      {boot.tag === "failed" && (
        <main className="profiles">
          <h1 style={{ fontSize: "2rem" }}>Magpie can't reach its server</h1>
          <p className="lede">{boot.message}</p>
          <div className="chips">
            <button type="button" className="btn btn-primary" onClick={() => void load()}>
              Try again
            </button>
          </div>
        </main>
      )}
      {session && (
        <SessionContext.Provider value={session}>
          {session.prefs.onboarded ? <Main hoardPulse={hoardPulse} /> : <Onboarding />}
        </SessionContext.Provider>
      )}
    </MotionConfig>
  )
}

function Main({ hoardPulse }: { hoardPulse: number }) {
  const [tab, setTab] = useTab()
  return (
    <div className="app">
      <div hidden={tab !== "deck"}>
        <Deck active={tab === "deck"} />
      </div>
      {tab === "library" && <Library onGoToDeck={() => setTab("deck")} />}
      {tab === "imports" && <Imports />}
      {tab === "settings" && <Settings />}
      <nav className="tabbar" aria-label="Main">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            className="tab"
            aria-current={tab === t.id ? "page" : undefined}
            onClick={() => setTab(t.id)}
          >
            {tab === t.id && <motion.span layoutId="tab-pip" className="tab-pip" transition={{ type: "spring", stiffness: 500, damping: 40 }} />}
            {t.id === "library" && hoardPulse > 0 && (
              <motion.span
                key={hoardPulse}
                className="hoard-glint"
                initial={{ scale: 0.4, opacity: 1 }}
                animate={{ scale: 2.2, opacity: 0 }}
                transition={{ duration: 0.7, ease: [0.16, 1, 0.3, 1] }}
              />
            )}
            <motion.span
              key={t.id === "library" ? `w-${hoardPulse}` : t.id}
              animate={t.id === "library" && hoardPulse > 0 ? { scale: [1, 1.3, 1], color: ["#f0b44c", "#f0b44c", "currentColor"] } : {}}
              transition={{ duration: 0.6 }}
              style={{ display: "grid" }}
            >
              <t.icon />
            </motion.span>
            {t.label}
          </button>
        ))}
      </nav>
    </div>
  )
}
