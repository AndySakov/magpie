import type { User } from "@magpie/contract"
import { motion } from "motion/react"
import { useEffect, useState, type FormEvent, type ReactNode } from "react"
import { api, ApiError, passkeysSupported } from "../api"
import { Icon } from "../ui"

const Shell = ({ title, lede, children }: { title: string; lede: string; children: ReactNode }) => (
  <main className="profiles">
    <div className="brand">
      <img src="/icon.svg" alt="" />
      <span className="brand-name">Magpie</span>
    </div>
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ type: "spring", stiffness: 380, damping: 34 }}
      style={{ display: "grid", gap: 24 }}
    >
      <div>
        <h1 className="welcome-title">{title}</h1>
        <p className="lede">{lede}</p>
      </div>
      {children}
    </motion.div>
  </main>
)

const Unsupported = () => (
  <p className="error-note">This browser can't use passkeys. Open Magpie in Safari, Chrome or Firefox.</p>
)

export function SignIn({ notice, onSignedIn }: { notice: string | null; onSignedIn: (user: User) => void }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(notice)

  const signIn = async () => {
    setBusy(true)
    setError(null)
    try {
      onSignedIn(await api.signIn())
    } catch (e) {
      setError((e as Error).message)
      setBusy(false)
    }
  }

  return (
    <Shell title="Welcome back" lede="Films, shows, anime and books, picked from what you and your friends love.">
      {passkeysSupported() ? (
        <button type="button" className="btn btn-primary passkey-cta" onClick={() => void signIn()} disabled={busy}>
          <Icon.Key />
          {busy ? "Waiting for your passkey…" : "Sign in with a passkey"}
        </button>
      ) : (
        <Unsupported />
      )}
      {error && <p className="error-note" role="alert">{error}</p>}
      <p className="welcome-hint">Magpie is invite-only. New here? Ask whoever runs it for an invite link.</p>
    </Shell>
  )
}

type InviteState = { tag: "checking" } | { tag: "open"; forName: string | null } | { tag: "invalid"; message: string }

export function Join({ token, onSignedIn, onUseSignIn }: { token: string; onSignedIn: (user: User) => void; onUseSignIn: () => void }) {
  const [invite, setInvite] = useState<InviteState>({ tag: "checking" })
  const [name, setName] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    api.inviteInfo(token).then(
      (info) => setInvite({ tag: "open", forName: info.forName }),
      (e: Error) => setInvite({ tag: "invalid", message: e.message })
    )
  }, [token])

  const join = async (e: FormEvent) => {
    e.preventDefault()
    if (invite.tag !== "open") return
    setBusy(true)
    setError(null)
    try {
      onSignedIn(await api.join(token, invite.forName === null ? name.trim() : undefined))
    } catch (err) {
      if (err instanceof ApiError && err.kind === "InviteInvalid") setInvite({ tag: "invalid", message: err.message })
      else setError((err as Error).message)
      setBusy(false)
    }
  }

  if (invite.tag === "checking") return <Shell title="Checking your invite…" lede="One moment." children={null} />

  if (invite.tag === "invalid")
    return (
      <Shell title="This link has expired" lede={invite.message}>
        <button type="button" className="btn passkey-cta" onClick={onUseSignIn}>
          I already have a passkey
        </button>
      </Shell>
    )

  const returning = invite.forName !== null
  return (
    <Shell
      title={returning ? `Welcome back, ${invite.forName}` : "You're invited"}
      lede={
        returning
          ? "This link saves a new passkey on this device, so you can get back into your account."
          : "Pick a name your friends will recognise, then save a passkey. Your face, fingerprint or device PIN is your login, so there's no password."
      }
    >
      {passkeysSupported() ? (
        <form onSubmit={join} className="field" style={{ gap: 14 }}>
          {!returning && (
            <>
              <label className="field-label" htmlFor="join-name">Your name</label>
              <input
                id="join-name"
                className="input"
                placeholder="Your name"
                value={name}
                maxLength={40}
                autoComplete="given-name"
                autoFocus
                onChange={(e) => setName(e.target.value)}
              />
            </>
          )}
          <button type="submit" className="btn btn-primary passkey-cta" disabled={busy || (!returning && !name.trim())}>
            <Icon.Key />
            {busy ? "Waiting for your passkey…" : returning ? "Save a passkey" : "Join with a passkey"}
          </button>
        </form>
      ) : (
        <Unsupported />
      )}
      {error && <p className="error-note" role="alert">{error}</p>}
      <p className="welcome-hint">Opened this from WhatsApp or Instagram? Open it in Safari or Chrome first. Their built-in browsers can't save passkeys reliably.</p>
    </Shell>
  )
}
