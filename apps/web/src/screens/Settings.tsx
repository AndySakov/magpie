import { CATEGORIES, type CreatorHit, type Filters, type User, type UserId } from "@magpie/contract"
import { useEffect, useRef, useState, type KeyboardEvent } from "react"
import { api, passkeysSupported } from "../api"
import { useSession } from "../session"
import { hueOf } from "../color"
import { LanguagePicker } from "../components/Languages"
import { Icon, Seg } from "../ui"

type FiltersInput = Omit<Filters, never>

export function Settings() {
  const { prefs, savePrefs, signOut, user } = useSession()
  const [filters, setFilters] = useState<FiltersInput>(prefs.filters)
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "failed">("idle")
  const [genreOptions, setGenreOptions] = useState<ReadonlyArray<string>>([])
  const pendingSave = useRef<(() => void) | null>(null)
  const lastSaved = useRef(JSON.stringify(prefs.filters))

  useEffect(() => {
    Promise.all(CATEGORIES.map((c) => api.genres(c).catch(() => [])))
      .then((all) => {
        const totals = new Map<string, number>()
        for (const g of all.flat()) totals.set(g.genre, (totals.get(g.genre) ?? 0) + g.count)
        setGenreOptions([...totals].sort((a, b) => b[1] - a[1]).map(([genre]) => genre))
      })
      .catch(() => undefined)
  }, [])

  useEffect(() => {
    const json = JSON.stringify(filters)
    if (json === lastSaved.current) return
    const run = () => {
      pendingSave.current = null
      setSaveState("saving")
      savePrefs((p) => ({ ...p, filters })).then(
        () => {
          lastSaved.current = json
          setSaveState("saved")
        },
        () => setSaveState("failed")
      )
    }
    pendingSave.current = run
    const t = setTimeout(run, 500)
    return () => clearTimeout(t)
  }, [filters, savePrefs])

  useEffect(() => () => pendingSave.current?.(), [])

  const set = <K extends keyof FiltersInput>(key: K, value: FiltersInput[K]) => setFilters((f) => ({ ...f, [key]: value }))

  return (
    <section className="screen" aria-label="Settings">
      <header className="screen-head">
        <h1 className="screen-title">Settings</h1>
        <p className="save-state" aria-live="polite">
          {saveState === "saving" ? "Saving…" : saveState === "saved" ? "Saved" : saveState === "failed" ? "Not saved. Check the connection." : ""}
        </p>
      </header>
      <div className="settings">
        <div className="settings-group">
          <h2>What the deck shows</h2>
          <div className="setting-row">
            <div>
              <div>Mature content</div>
              <p>Explicit films, shows and books</p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={filters.showMature}
              aria-label="Show mature content"
              className="toggle"
              onClick={() => set("showMature", !filters.showMature)}
            >
              <span />
            </button>
          </div>
          <div className="field">
            <LanguagePicker allowAny value={filters.languages} onChange={(v) => set("languages", v)} />
            <p className="welcome-hint">Films, TV and books only come in these. Anime isn't filtered: it's usually watched subbed or dubbed.</p>
          </div>
          <LengthLimit
            id="film"
            label="Film length"
            presets={[90, 120, 150]}
            format={formatMinutes}
            value={filters.maxMinutes}
            onChange={(v) => set("maxMinutes", v)}
          />
          <LengthLimit
            id="series"
            label="Series length"
            hint="TV and anime"
            presets={[12, 26, 60]}
            format={(n) => `${n} eps`}
            value={filters.maxEpisodes}
            onChange={(v) => set("maxEpisodes", v)}
          />
          <LengthLimit
            id="book"
            label="Book length"
            presets={[250, 400, 600]}
            format={(n) => `${n} pages`}
            value={filters.maxPages}
            onChange={(v) => set("maxPages", v)}
          />
        </div>

        <div className="settings-group">
          <h2>Never show me</h2>
          <GenreChips options={genreOptions} blocked={filters.blockedGenres} onChange={(v) => set("blockedGenres", v)} />
          <CreatorBlock values={filters.blockedCreators} onChange={(v) => set("blockedCreators", v)} />
        </div>

        <div className="settings-group">
          <h2>Account</h2>
          <div className="setting-row">
            <div>
              <div>Signed in as {user.name}</div>
              <p>Your passkey is your login. Lost your device? Ask for a new passkey link.</p>
            </div>
          </div>
          {passkeysSupported() && <AddPasskey />}
          <div className="chips">
            <button type="button" className="btn" onClick={() => void savePrefs((p) => ({ ...p, onboarded: false }))}>
              Redo onboarding
            </button>
            <button type="button" className="btn btn-quiet" onClick={signOut}>
              Sign out
            </button>
          </div>
        </div>

        {user.isAdmin && <Invites me={user} />}

        <p className="tmdb-notice">This product uses the TMDB API but is not endorsed or certified by TMDB.</p>
      </div>
    </section>
  )
}

const formatMinutes = (n: number) => (n % 60 === 0 ? `${n / 60} h` : n % 30 === 0 ? `${Math.floor(n / 60)}½ h` : `${n} min`)

function LengthLimit({
  id,
  label,
  hint,
  presets,
  format,
  value,
  onChange
}: {
  id: string
  label: string
  hint?: string
  presets: ReadonlyArray<number>
  format: (n: number) => string
  value: number | null
  onChange: (v: number | null) => void
}) {
  const values = value === null || presets.includes(value) ? presets : [...presets, value].sort((a, b) => a - b)
  return (
    <div className="length-limit">
      <div className="length-head">
        <span>{label}</span>
        <small>{value === null ? (hint ? `Any length · ${hint}` : "Any length") : `Up to ${format(value)}${hint ? ` · ${hint}` : ""}`}</small>
      </div>
      <Seg
        id={`len-${id}`}
        value={value === null ? "any" : String(value)}
        onChange={(v) => onChange(v === "any" ? null : Number(v))}
        options={[{ value: "any", label: "Any" }, ...values.map((n) => ({ value: String(n), label: format(n) }))]}
      />
    </div>
  )
}

const GENRES_SHOWN = 15

function GenreChips({
  options,
  blocked,
  onChange
}: {
  options: ReadonlyArray<string>
  blocked: ReadonlyArray<string>
  onChange: (v: ReadonlyArray<string>) => void
}) {
  const [all, setAll] = useState(false)
  const isBlocked = (g: string) => blocked.some((b) => b.toLowerCase() === g.toLowerCase())
  const top = options.slice(0, GENRES_SHOWN)
  const shown = all ? options : [...top, ...blocked.filter((b) => !top.some((g) => g.toLowerCase() === b.toLowerCase()))]
  const toggle = (g: string) => onChange(isBlocked(g) ? blocked.filter((b) => b.toLowerCase() !== g.toLowerCase()) : [...blocked, g])
  return (
    <div className="field">
      <span className="field-label">Genres{blocked.length > 0 ? ` · ${blocked.length} hidden` : ""}</span>
      <div className="chips">
        {shown.map((g) => (
          <button
            key={g}
            type="button"
            className={`chip genre-chip ${isBlocked(g) ? "blocked" : ""}`}
            aria-pressed={isBlocked(g)}
            aria-label={isBlocked(g) ? `Show ${g} again` : `Hide ${g}`}
            onClick={() => toggle(g)}
          >
            {isBlocked(g) && <Icon.Close />}
            {g}
          </button>
        ))}
        {options.length > GENRES_SHOWN && (
          <button type="button" className="chip chip-more" onClick={() => setAll((a) => !a)}>
            {all ? "Fewer" : `All ${options.length}`}
          </button>
        )}
      </div>
    </div>
  )
}

const ROLE_LABEL: Record<string, string> = { director: "Director", writer: "Writer", author: "Author", studio: "Studio" }

function CreatorBlock({ values, onChange }: { values: ReadonlyArray<string>; onChange: (v: ReadonlyArray<string>) => void }) {
  const [q, setQ] = useState("")
  const [hits, setHits] = useState<ReadonlyArray<CreatorHit> | null>(null)
  const [active, setActive] = useState(0)
  const [focused, setFocused] = useState(false)

  useEffect(() => {
    const query = q.trim()
    if (query.length < 3) {
      setHits(null)
      return
    }
    let live = true
    const t = setTimeout(() => {
      api.creators(query).then(
        (found) => {
          if (!live) return
          setHits(found.filter((h) => !values.some((v) => v.toLowerCase() === h.name.toLowerCase())))
          setActive(0)
        },
        () => live && setHits([])
      )
    }, 180)
    return () => {
      live = false
      clearTimeout(t)
    }
  }, [q, values])

  const add = (name: string) => {
    onChange([...values, name])
    setQ("")
    setHits(null)
  }

  const onKey = (e: KeyboardEvent) => {
    if (!hits || hits.length === 0) return
    if (e.key === "ArrowDown") setActive((a) => (a + 1) % hits.length)
    else if (e.key === "ArrowUp") setActive((a) => (a - 1 + hits.length) % hits.length)
    else if (e.key === "Enter") add(hits[active]!.name)
    else if (e.key === "Escape") setHits(null)
    else return
    e.preventDefault()
  }

  const open = focused && hits !== null
  return (
    <div className="field">
      <label className="field-label" htmlFor="creator-search">
        Directors, authors and studios
      </label>
      <div className="combo">
        <input
          id="creator-search"
          className="input"
          placeholder="Search by name"
          role="combobox"
          aria-expanded={open}
          aria-controls="creator-hits"
          aria-activedescendant={open && hits.length > 0 ? `creator-hit-${active}` : undefined}
          autoComplete="off"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={onKey}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
        />
        {open && (
          <ul id="creator-hits" role="listbox" className="combo-list">
            {hits.length === 0 ? (
              <li className="combo-empty">No one by that name in the catalogue.</li>
            ) : (
              hits.map((h, i) => (
                <li
                  key={h.name}
                  id={`creator-hit-${i}`}
                  role="option"
                  aria-selected={i === active}
                  onMouseDown={(e) => {
                    e.preventDefault()
                    add(h.name)
                  }}
                  onMouseEnter={() => setActive(i)}
                >
                  <span className="combo-name">{h.name}</span>
                  <span className="combo-meta">
                    {ROLE_LABEL[h.role] ?? h.role} · {h.knownFor}
                  </span>
                </li>
              ))
            )}
          </ul>
        )}
      </div>
      {values.length > 0 && (
        <div className="chips">
          {values.map((v) => (
            <button
              key={v}
              type="button"
              className="chip genre-chip blocked"
              aria-label={`Show ${v} again`}
              onClick={() => onChange(values.filter((x) => x !== v))}
            >
              <Icon.Close />
              {v}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

type Link = { url: string; forName: string | null; expiresAt: string }

function Invites({ me }: { me: User }) {
  const [members, setMembers] = useState<ReadonlyArray<User>>([])
  const [link, setLink] = useState<Link | null>(null)
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    api.members().then(setMembers, (e: Error) => setError(e.message))
  }, [])

  const create = async (forUserId?: UserId) => {
    setBusy(true)
    setError(null)
    setCopied(false)
    try {
      const invite = await api.createInvite(forUserId)
      setLink({ url: `${location.origin}/#join=${invite.token}`, forName: invite.forName, expiresAt: invite.expiresAt })
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const copy = async () => {
    if (!link) return
    try {
      await navigator.clipboard.writeText(link.url)
      setCopied(true)
    } catch {
      setError("Couldn't copy. Select the link and copy it yourself.")
    }
  }

  const expires = link ? new Date(link.expiresAt).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" }) : ""

  return (
    <div className="settings-group">
      <h2>Invite friends</h2>
      <p className="welcome-hint">Each link works once and expires after a week. Send it privately.</p>
      <button type="button" className="btn btn-primary" onClick={() => void create()} disabled={busy}>
        <Icon.Link />
        Create invite link
      </button>
      {link && (
        <div className="invite-link">
          <span className="field-label">
            {link.forName ? `New passkey link for ${link.forName}` : "Invite link"} · expires {expires}
          </span>
          <input className="input" readOnly value={link.url} onFocus={(e) => e.currentTarget.select()} aria-label="Invite link" />
          <button type="button" className="btn" onClick={() => void copy()}>
            {copied ? <Icon.Check /> : null}
            {copied ? "Copied" : "Copy link"}
          </button>
        </div>
      )}
      {error && <p className="error-note">{error}</p>}
      {members.filter((m) => m.id !== me.id).length > 0 && (
        <div className="field">
          <span className="field-label">Members</span>
          {members
            .filter((m) => m.id !== me.id)
            .map((m) => (
              <div key={m.id} className="member-row">
                <span>
                  <span className="avatar" style={{ background: `oklch(0.78 0.13 ${hueOf(m.name)})` }}>
                    {m.name.slice(0, 1).toUpperCase()}
                  </span>
                  {m.name}
                </span>
                <button type="button" className="btn btn-quiet" onClick={() => void create(m.id)} disabled={busy}>
                  New passkey link
                </button>
              </div>
            ))}
        </div>
      )}
    </div>
  )
}

function AddPasskey() {
  const [state, setState] = useState<{ tag: "idle" | "busy" | "saved" } | { tag: "failed"; message: string }>({ tag: "idle" })
  const add = async () => {
    setState({ tag: "busy" })
    try {
      await api.addPasskey()
      setState({ tag: "saved" })
    } catch (e) {
      setState({ tag: "failed", message: (e as Error).message })
    }
  }
  return (
    <div className="setting-row">
      <div>
        <div>Passkey on this device</div>
        <p>
          {state.tag === "saved"
            ? "Saved. Next time, sign in here with your face, fingerprint or PIN."
            : "Signed in with your phone? Save a passkey here so you don't need it next time."}
        </p>
        {state.tag === "failed" && <p className="error-note">{state.message}</p>}
      </div>
      <button type="button" className="btn" onClick={() => void add()} disabled={state.tag === "busy" || state.tag === "saved"}>
        {state.tag === "saved" ? <Icon.Check /> : <Icon.Key />}
        {state.tag === "busy" ? "Waiting…" : state.tag === "saved" ? "Saved" : "Add"}
      </button>
    </div>
  )
}
