import { CATEGORIES, type Category, type GenreCount, type Recommendation } from "@magpie/contract"
import { AnimatePresence, motion } from "motion/react"
import { useEffect, useState, type CSSProperties } from "react"
import { api } from "../api"
import { browserLanguages, LanguagePicker } from "../components/Languages"
import { SwipeStack, type Decision } from "../components/SwipeStack"
import { useSession } from "../session"
import { CATEGORY_LABEL, Icon, Sheet, Toast, useItemColor } from "../ui"
import { Imports } from "./Imports"

type Step = { tag: "categories" } | { tag: "genres" } | { tag: "calibrate"; index: number }

const TILE: Record<Category, { color: string; sub: string }> = {
  movie: { color: "var(--gold)", sub: "Features, docs, shorts" },
  tv: { color: "var(--cobalt)", sub: "Series and miniseries" },
  anime: { color: "var(--teal)", sub: "Series and films" },
  book: { color: "var(--violet)", sub: "Fiction and non-fiction" }
}

export function Onboarding() {
  const { prefs, savePrefs } = useSession()
  const [step, setStep] = useState<Step>({ tag: "categories" })
  const [chosen, setChosen] = useState<ReadonlyArray<Category>>(() => CATEGORIES.filter((c) => c in prefs.genres))
  const [genres, setGenres] = useState<Readonly<Record<string, ReadonlyArray<string>>>>(prefs.genres)
  const [languages, setLanguages] = useState<ReadonlyArray<string>>(() => {
    if (prefs.filters.languages.length > 0) return prefs.filters.languages
    const fromBrowser = browserLanguages()
    return fromBrowser.length > 0 ? fromBrowser : ["en"]
  })
  const [importsOpen, setImportsOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const totalSteps = 2 + chosen.length
  const position = step.tag === "categories" ? 0 : step.tag === "genres" ? 1 : 2 + step.index

  const saveGenres = async () => {
    setError(null)
    const picked = Object.fromEntries(chosen.map((c) => [c, genres[c] ?? []]))
    try {
      await savePrefs((p) => ({ ...p, genres: picked, filters: { ...p.filters, languages } }))
      setStep({ tag: "calibrate", index: 0 })
    } catch (e) {
      setError((e as Error).message)
    }
  }

  const finish = async () => {
    setError(null)
    try {
      await savePrefs((p) => ({ ...p, onboarded: true }))
    } catch (e) {
      setError((e as Error).message)
    }
  }

  const nextCalibration = () => {
    if (step.tag !== "calibrate") return
    if (step.index + 1 < chosen.length) setStep({ tag: "calibrate", index: step.index + 1 })
    else void finish()
  }

  return (
    <main className="screen onboarding">
      <div>
        <div className="ob-progress" aria-label={`Step ${position + 1} of ${totalSteps}`}>
          {Array.from({ length: totalSteps }, (_, i) => (
            <i key={i} className={i <= position ? "on" : ""} />
          ))}
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <button type="button" className="btn btn-quiet" onClick={() => setImportsOpen(true)}>
            <Icon.Import />
            Import history
          </button>
        </div>
      </div>

      <AnimatePresence mode="wait">
        <motion.div
          key={step.tag === "calibrate" ? `cal-${step.index}` : step.tag}
          initial={{ opacity: 0, x: 24 }}
          animate={{ opacity: 1, x: 0 }}
          exit={{ opacity: 0, x: -24 }}
          transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
        >
          {step.tag === "categories" && (
            <>
              <h1 className="ob-title">What are you into?</h1>
              <p className="lede">Pick everything you'd like suggestions for. You can change this later.</p>
              <div className="cat-grid">
                {CATEGORIES.map((c) => {
                  const on = chosen.includes(c)
                  return (
                    <motion.button
                      key={c}
                      type="button"
                      className="cat-tile"
                      aria-pressed={on}
                      style={{ "--tile": TILE[c].color } as Record<string, string>}
                      whileTap={{ scale: 0.96 }}
                      onClick={() => setChosen((cs) => (on ? cs.filter((x) => x !== c) : CATEGORIES.filter((x) => x === c || cs.includes(x))))}
                    >
                      <span className="cat-tile-wash" />
                      <AnimatePresence>
                        {on && (
                          <motion.span className="cat-tile-check" initial={{ scale: 0 }} animate={{ scale: 1 }} exit={{ scale: 0 }}>
                            <Icon.Check />
                          </motion.span>
                        )}
                      </AnimatePresence>
                      <span className="cat-tile-word">{CATEGORY_LABEL[c]}</span>
                      <span className="cat-tile-sub">{TILE[c].sub}</span>
                    </motion.button>
                  )
                })}
              </div>
              <div className="ob-languages">
                <p className="lede">Which languages should suggestions be in? Anime isn't filtered.</p>
                <LanguagePicker value={languages} onChange={setLanguages} />
              </div>
            </>
          )}
          {step.tag === "genres" && (
            <>
              <h1 className="ob-title">Which genres pull you in?</h1>
              <p className="lede">A few per kind is plenty. Skip any you're unsure about.</p>
              {chosen.map((c) => (
                <GenrePicker
                  key={c}
                  category={c}
                  selected={genres[c] ?? []}
                  onChange={(g) => setGenres((all) => ({ ...all, [c]: g }))}
                />
              ))}
            </>
          )}
          {step.tag === "calibrate" && chosen[step.index] && (
            <Calibration key={chosen[step.index]} category={chosen[step.index]!} onDone={nextCalibration} />
          )}
        </motion.div>
      </AnimatePresence>

      {step.tag !== "calibrate" && (
        <div className="ob-foot">
          {step.tag === "genres" ? (
            <button type="button" className="btn btn-quiet" onClick={() => setStep({ tag: "categories" })}>
              Back
            </button>
          ) : (
            <span />
          )}
          {error && <p className="error-note">{error}</p>}
          <button
            type="button"
            className="btn btn-primary"
            disabled={chosen.length === 0}
            onClick={() => (step.tag === "categories" ? setStep({ tag: "genres" }) : void saveGenres())}
          >
            Continue
          </button>
        </div>
      )}
      {step.tag === "calibrate" && error && <p className="error-note">{error}</p>}

      <Sheet open={importsOpen} onClose={() => setImportsOpen(false)} label="Import history">
        <Imports embedded />
      </Sheet>
    </main>
  )
}

function GenrePicker({
  category,
  selected,
  onChange
}: {
  category: Category
  selected: ReadonlyArray<string>
  onChange: (g: ReadonlyArray<string>) => void
}) {
  const [options, setOptions] = useState<ReadonlyArray<GenreCount> | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    api.genres(category).then(setOptions, (e: Error) => setError(e.message))
  }, [category])
  return (
    <div className="ob-section">
      <h2>{CATEGORY_LABEL[category]}</h2>
      {error && <p className="error-note">{error}</p>}
      {!options && !error && <p className="source-hint">Loading genres…</p>}
      {options && (
        <div className="chips">
          {options.map((g) => {
            const on = selected.includes(g.genre)
            return (
              <motion.button
                key={g.genre}
                type="button"
                className="chip"
                aria-pressed={on}
                whileTap={{ scale: 0.94 }}
                onClick={() => onChange(on ? selected.filter((x) => x !== g.genre) : [...selected, g.genre])}
              >
                {g.genre}
                <small>{g.count.toLocaleString()}</small>
              </motion.button>
            )
          })}
        </div>
      )}
    </div>
  )
}

function Calibration({ category, onDone }: { category: Category; onDone: () => void }) {
  const { pulseHoard } = useSession()
  const [cards, setCards] = useState<ReadonlyArray<Recommendation> | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)

  const load = () => {
    setError(null)
    api.calibration(category, 12).then(setCards, (e: Error) => setError(e.message))
  }
  useEffect(load, [category])

  const decide = (rec: Recommendation, d: Decision) => {
    setCards((cs) => cs?.filter((r) => r.item.id !== rec.item.id) ?? cs)
    if (d.kind === "interested") pulseHoard()
    api.feedback(rec.item.id, d.kind, d.kind === "seen" ? d.rating : undefined).catch((e: Error) => {
      setToast(e.message)
      setTimeout(() => setToast(null), 3500)
    })
  }

  const color = useItemColor(cards?.[0]?.item)

  return (
    <div className="calib deck-screen" style={{ "--amb": color, minHeight: 0, padding: 0 } as CSSProperties}>
      <div className="ambient" aria-hidden="true">
        <div className="ambient-blob a" />
      </div>
      <div style={{ marginBottom: 14 }}>
        <h1 className="ob-title" style={{ fontSize: "1.9rem" }}>
          Calibrate {CATEGORY_LABEL[category].toLowerCase()}
        </h1>
        <p className="lede">Seen it? Rate it. Otherwise swipe: right if it appeals, left if not.</p>
      </div>
      <SwipeStack
        cards={cards ?? []}
        loading={cards === null && error === null}
        active
        returning={null}
        onDecide={decide}
        empty={
          <div className="empty">
            {error ? (
              <>
                <h2>Calibration didn't load</h2>
                <p>{error}</p>
                <button type="button" className="btn btn-primary" onClick={load}>
                  Try again
                </button>
              </>
            ) : (
              <>
                <h2>{CATEGORY_LABEL[category]} calibrated</h2>
                <button type="button" className="btn btn-primary" onClick={onDone}>
                  Continue
                </button>
              </>
            )}
          </div>
        }
      />
      <div style={{ display: "flex", justifyContent: "center", marginTop: 8 }}>
        {cards && cards.length > 0 && (
          <button type="button" className="btn btn-quiet" onClick={onDone}>
            Skip the rest
          </button>
        )}
      </div>
      <Toast text={toast} />
    </div>
  )
}
