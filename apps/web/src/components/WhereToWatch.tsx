import type { Item, Provider, Region, WatchOptions } from "@magpie/contract"
import { useEffect, useState } from "react"
import { api } from "../api"
import { useSession } from "../session"
import { Icon } from "../ui"

const SHORTLIST = 12

const regionNames = (() => {
  try {
    return new Intl.DisplayNames(["en"], { type: "region" })
  } catch {
    return null
  }
})()
const regionName = (code: string) => regionNames?.of(code) ?? code

const watchable = (item: Item) => item.category === "movie" || item.category === "tv"

function Logo({ provider }: { provider: Provider }) {
  return provider.logoUrl ? <img className="provider-logo" src={provider.logoUrl} alt="" loading="lazy" /> : null
}

/** Region, services and the "only my services" switch, for Settings. */
export function WatchSettings() {
  const { prefs, savePrefs } = useSession()
  const watch = prefs.watch
  const [regions, setRegions] = useState<ReadonlyArray<Region>>([])
  const [providers, setProviders] = useState<ReadonlyArray<Provider> | null>(null)
  const [showAll, setShowAll] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    api.regions().then(setRegions, (e: Error) => setError(e.message))
  }, [])

  useEffect(() => {
    setProviders(null)
    setShowAll(false)
    if (watch.region === null) return
    let live = true
    api.providers(watch.region).then(
      (ps) => live && setProviders(ps),
      (e: Error) => live && setError(e.message)
    )
    return () => {
      live = false
    }
  }, [watch.region])

  const save = (patch: Partial<typeof watch>) =>
    savePrefs((p) => ({ ...p, watch: { ...p.watch, ...patch } })).catch((e: Error) => setError(e.message))

  const toggle = (id: Provider["id"]) => {
    const services = watch.services.includes(id) ? watch.services.filter((s) => s !== id) : [...watch.services, id]
    void save({ services, onlyMine: services.length > 0 && watch.onlyMine })
  }

  const shown = providers === null
    ? []
    : showAll
      ? providers
      : [...providers.filter((p) => watch.services.includes(p.id)), ...providers.filter((p) => !watch.services.includes(p.id))]
        .slice(0, Math.max(SHORTLIST, watch.services.length))

  return (
    <div className="settings-group">
      <h2>Where you watch</h2>
      <label className="field">
        <span className="field-label">Country</span>
        <select
          className="input select"
          value={watch.region ?? ""}
          onChange={(e) => void save({ region: e.target.value === "" ? null : e.target.value, services: [], onlyMine: false })}
        >
          <option value="">Not set</option>
          {(regions.length > 0 ? regions : watch.region ? [{ code: watch.region, name: regionName(watch.region) }] : []).map((r) => (
            <option key={r.code} value={r.code}>
              {r.name}
            </option>
          ))}
        </select>
      </label>
      {watch.region !== null && (
        <div className="field">
          <span className="field-label">Your services</span>
          {providers === null ? (
            <p className="welcome-hint">Loading services…</p>
          ) : (
            <div className="chips">
              {shown.map((p) => (
                <button key={p.id} type="button" className="chip" aria-pressed={watch.services.includes(p.id)} onClick={() => toggle(p.id)}>
                  <Logo provider={p} />
                  {p.name}
                </button>
              ))}
              {!showAll && providers.length > shown.length && (
                <button type="button" className="chip chip-more" onClick={() => setShowAll(true)}>
                  All {providers.length}
                </button>
              )}
            </div>
          )}
        </div>
      )}
      <div className="setting-row">
        <div>
          <div>Only what's on my services</div>
          <p>Films and TV in the deck must stream on one of them. New services take a day or so to fill in.</p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={watch.onlyMine}
          aria-label="Only show what's on my services"
          className="toggle"
          disabled={watch.region === null || watch.services.length === 0}
          onClick={() => void save({ onlyMine: !watch.onlyMine })}
        >
          <span />
        </button>
      </div>
      {error && <p className="welcome-hint" role="alert">{error}</p>}
    </div>
  )
}

/** Card line naming the user's services that carry the title. */
export function OnServices({ providers }: { providers: ReadonlyArray<Provider> }) {
  if (providers.length === 0) return null
  return (
    <p className="reason on-services">
      <Icon.Check />
      On {providers.map((p) => p.name).join(", ")}
    </p>
  )
}

type Loaded = { readonly tag: "loading" } | { readonly tag: "done"; readonly options: WatchOptions | null } | { readonly tag: "error"; readonly message: string }

/** Live offers for one title in the user's region, for the detail sheet. */
export function WhereToWatch({ item }: { item: Item }) {
  const { prefs } = useSession()
  const region = prefs.watch.region
  const [state, setState] = useState<Loaded>({ tag: "loading" })

  useEffect(() => {
    if (!watchable(item) || region === null) return
    let live = true
    setState({ tag: "loading" })
    api.watchOptions(item.id).then(
      (options) => live && setState({ tag: "done", options }),
      (e: Error) => live && setState({ tag: "error", message: e.message })
    )
    return () => {
      live = false
    }
  }, [item, region])

  if (!watchable(item)) return null
  if (region === null) {
    return (
      <div className="where">
        <h3>Where to watch</h3>
        <p className="welcome-hint">Set your country in Settings to see where this streams.</p>
      </div>
    )
  }
  const options = state.tag === "done" ? state.options : null
  const groups = options
    ? ([["Stream", options.stream], ["Free", options.free], ["Rent", options.rent], ["Buy", options.buy]] as const).filter(([, ps]) => ps.length > 0)
    : []
  return (
    <div className="where">
      <h3>Where to watch in {regionName(region)}</h3>
      {state.tag === "loading" && <p className="welcome-hint">Checking…</p>}
      {state.tag === "error" && <p className="welcome-hint">{state.message}</p>}
      {state.tag === "done" && groups.length === 0 && <p className="welcome-hint">Not available to stream, rent or buy here right now.</p>}
      {groups.map(([label, ps]) => (
        <div key={label} className="where-row">
          <span className="field-label">{label}</span>
          <div className="chips">
            {ps.map((p) => (
              <span key={p.id} className={label === "Stream" && prefs.watch.services.includes(p.id) ? "chip mine" : "chip"}>
                <Logo provider={p} />
                {p.name}
              </span>
            ))}
          </div>
        </div>
      ))}
      {options?.link && (
        <p className="where-credit">
          <a href={options.link} target="_blank" rel="noreferrer">
            All options on TMDB
          </a>{" "}
          · Availability from JustWatch
        </p>
      )}
    </div>
  )
}
