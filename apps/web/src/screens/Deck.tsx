import { CATEGORIES, type Category, Recommendation } from "@magpie/contract"
import { Schema } from "effect"
import { motion } from "motion/react"
import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react"
import { api } from "../api"
import { Dial, describe } from "../components/Dial"
import { SwipeStack, type Decision, type Dir } from "../components/SwipeStack"
import { useSession } from "../session"
import { CATEGORY_LABEL, Icon, Sheet, Toast, imageSources, useItemColor } from "../ui"
import { readCache, writeCache } from "../cache"
import { DECIDED } from "../components/InstallPrompt"
import { sampleImageColor } from "../color"

type Lane = {
  readonly queue: ReadonlyArray<Recommendation>
  readonly loading: boolean
  readonly exhausted: boolean
  readonly error: string | null
  /** Decisions the server has taken since the cards behind the visible stack were fetched. */
  readonly staleBy: number
}

const emptyLane: Lane = { queue: [], loading: false, exhausted: false, error: null, staleBy: 0 }
// Decks load like an infinite scroll: a batch is fetched while plenty of cards remain, so the next card is always there.
const BATCH = 30
const PREFETCH_BELOW = 25
const KEEP = 60
// The server doesn't know what's queued here, so a refetch asks for the queue plus a batch and drops the repeats.
const MAX_FETCH = 100
// Posters of the cards behind the visible three load before they come into view.
const PRELOAD_POSTERS = 10
// A long queue is ranked on taste from several swipes ago. After REFRESH_AFTER decisions reach the server, a fresh
// batch is fetched once swiping pauses (or at once past STALE_LIMIT) and replaces everything behind the visible stack.
const REFRESH_AFTER = 5
const STALE_LIMIT = 15
const REFRESH_PAUSE_MS = 1500
const ON_SCREEN = 3
const SavedDeck = Schema.Struct({ filters: Schema.String, lanes: Schema.Record(Schema.String, Schema.Array(Recommendation)) })
const deckKey = (userId: string) => `magpie:deck:${userId}`
const UNDO_MS = 3000

type Pending = {
  readonly rec: Recommendation
  readonly decision: Decision
  readonly dir: Dir
  readonly category: Category
  readonly timer: ReturnType<typeof setTimeout>
}

export const userCategories = (genres: Readonly<Record<string, ReadonlyArray<string>>>): ReadonlyArray<Category> => {
  const chosen = CATEGORIES.filter((c) => c in genres)
  return chosen.length > 0 ? chosen : CATEGORIES
}

export function Deck({ active }: { active: boolean }) {
  const { user, prefs, savePrefs, pulseHoard } = useSession()
  const categories = userCategories(prefs.genres)
  const [category, setCategory] = useState<Category>(categories[0]!)
  const filtersKey = JSON.stringify([prefs.filters, prefs.watch])
  // Opening the app shows the cards that were waiting last time; fresh ones load behind them.
  const [lanes, setLanes] = useState<Partial<Record<Category, Lane>>>(() => {
    const saved = readCache(deckKey(user.id), SavedDeck)
    if (!saved || saved.filters !== filtersKey) return {}
    return Object.fromEntries(Object.entries(saved.lanes).filter(([, q]) => q.length > 0).map(([c, queue]) => [c, { ...emptyLane, queue, staleBy: REFRESH_AFTER }]))
  })
  const [toast, setToast] = useState<{ text: string; undo: boolean } | null>(null)
  const [returning, setReturning] = useState<{ id: number; dir: Dir } | null>(null)
  const [dialOpen, setDialOpen] = useState(false)
  const swiped = useRef(new Set<number>())
  const pending = useRef<Pending | null>(null)
  const inflight = useRef(new Set<Category>())
  const toastTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const lanesRef = useRef(lanes)
  lanesRef.current = lanes

  const lane = lanes[category] ?? emptyLane
  const patchLane = useCallback(
    (c: Category, f: (l: Lane) => Lane) => setLanes((all) => ({ ...all, [c]: f(all[c] ?? emptyLane) })),
    []
  )

  const showToast = useCallback((text: string, undo: boolean) => {
    clearTimeout(toastTimer.current)
    setToast({ text, undo })
    toastTimer.current = setTimeout(() => setToast(null), undo ? UNDO_MS : 2500)
  }, [])

  const load = useCallback(
    async (c: Category, refresh = false) => {
      if (inflight.current.has(c)) return
      inflight.current.add(c)
      patchLane(c, (l) => ({ ...l, loading: true, error: null }))
      try {
        const before = lanesRef.current[c]
        const held = before?.queue.length ?? 0
        const staleAtRequest = before?.staleBy ?? 0
        const batch = await api.deck(c, Math.min(MAX_FETCH, held + BATCH + 1))
        patchLane(c, (l) => {
          const keep = refresh ? l.queue.slice(0, ON_SCREEN) : l.queue
          const have = new Set(keep.map((r) => r.item.id as number))
          const fresh = batch.filter((r) => !swiped.current.has(r.item.id) && !have.has(r.item.id))
          return {
            queue: [...keep, ...fresh],
            loading: false,
            error: null,
            exhausted: fresh.length === 0,
            staleBy: refresh ? l.staleBy - staleAtRequest : l.staleBy
          }
        })
      } catch (e) {
        // The cards already queued are still good, so a failed refresh waits for the next REFRESH_AFTER decisions.
        patchLane(c, (l) => (refresh ? { ...l, loading: false, staleBy: 0 } : { ...l, loading: false, error: (e as Error).message }))
      } finally {
        inflight.current.delete(c)
      }
    },
    [patchLane]
  )

  const flush = useCallback(() => {
    const p = pending.current
    if (!p) return
    clearTimeout(p.timer)
    pending.current = null
    const rating = p.decision.kind === "seen" ? p.decision.rating : undefined
    api.feedback(p.rec.item.id, p.decision.kind, rating).then(
      () => patchLane(p.category, (l) => ({ ...l, staleBy: l.staleBy + 1 })),
      (e: Error) => showToast(e.message, false)
    )
  }, [patchLane, showToast])

  useEffect(() => {
    const onHide = () => document.visibilityState === "hidden" && flush()
    document.addEventListener("visibilitychange", onHide)
    return () => {
      document.removeEventListener("visibilitychange", onHide)
      flush()
    }
  }, [flush])

  useEffect(() => {
    if (!active) flush()
  }, [active, flush])

  useEffect(() => {
    if (!categories.includes(category)) setCategory(categories[0]!)
  }, [categories, category])

  const needsMore = lane.queue.length < PREFETCH_BELOW && !lane.exhausted && !lane.loading && lane.error === null
  useEffect(() => {
    if (needsMore) void load(category)
  }, [needsMore, category, load, lane.queue.length])

  const stale = lane.staleBy >= REFRESH_AFTER && lane.queue.length > ON_SCREEN && !lane.loading
  useEffect(() => {
    if (!active || !stale) return
    const t = setTimeout(() => void load(category, true), lane.staleBy >= STALE_LIMIT ? 0 : REFRESH_PAUSE_MS)
    return () => clearTimeout(t)
    // Each new decision restarts the pause, so a refresh waits for swiping to stop.
  }, [active, stale, category, load, lane.staleBy])

  const firstFilters = useRef(filtersKey)
  useEffect(() => {
    if (firstFilters.current === filtersKey) return
    firstFilters.current = filtersKey
    setLanes({})
  }, [filtersKey])

  const decide = useCallback(
    (rec: Recommendation, decision: Decision, dir: Dir) => {
      flush()
      swiped.current.add(rec.item.id)
      window.dispatchEvent(new Event(DECIDED))
      setReturning(null)
      patchLane(category, (l) => ({ ...l, queue: l.queue.filter((r) => r.item.id !== rec.item.id) }))
      pending.current = { rec, decision, dir, category, timer: setTimeout(flush, UNDO_MS) }
      if (decision.kind === "interested") pulseHoard()
      const text =
        decision.kind === "interested"
          ? `Added ${rec.item.title} to Want`
          : decision.kind === "seen"
            ? `Rated ${rec.item.title}`
            : `Skipped ${rec.item.title}`
      showToast(text, true)
    },
    [category, flush, patchLane, pulseHoard, showToast]
  )

  const undo = useCallback(() => {
    const p = pending.current
    if (!p) return
    clearTimeout(p.timer)
    pending.current = null
    swiped.current.delete(p.rec.item.id)
    setCategory(p.category)
    setReturning({ id: p.rec.item.id, dir: p.dir })
    patchLane(p.category, (l) => ({ ...l, queue: [p.rec, ...l.queue] }))
    setToast(null)
  }, [patchLane])

  useEffect(() => {
    if (!active) return
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
        e.preventDefault()
        undo()
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [active, undo])

  const setDial = (v: number) => {
    void savePrefs((p) => ({ ...p, dial: { ...p.dial, [category]: v } }))
    patchLane(category, (l) => ({ ...emptyLane, queue: l.queue.slice(0, 1) }))
  }

  const color = useItemColor(lane.queue[0]?.item)
  const upNext = lane.queue.slice(1, 3 + PRELOAD_POSTERS).map((r) => r.item.imageUrl ?? "").join(" ")
  useEffect(() => {
    const urls = upNext.split(" ")
    for (const url of urls) if (url) void sampleImageColor(url)
    const width = Math.ceil(document.querySelector(".card")?.clientWidth ?? 340)
    for (const url of urls.slice(2)) {
      const source = url ? imageSources(url)[0] : undefined
      if (!source) continue
      const img = new Image()
      img.decoding = "async"
      if (source.srcSet) {
        img.sizes = `${width}px`
        img.srcset = source.srcSet
      }
      img.src = source.src
    }
  }, [upNext])

  const saved = JSON.stringify(Object.fromEntries(Object.entries(lanes).map(([c, l]) => [c, l.queue.slice(0, KEEP).map((r) => r.item.id)])))
  useEffect(() => {
    const queues = Object.fromEntries(Object.entries(lanes).map(([c, l]) => [c, l.queue.slice(0, KEEP)]))
    writeCache(deckKey(user.id), { filters: filtersKey, lanes: queues })
    // `saved` changes exactly when a queue's cards do, so lane flags flipping doesn't rewrite storage.
  }, [saved, filtersKey, user.id])

  // Once the open category has cards, the others fill in the background so switching tabs is instant.
  const cold = categories.find((c) => c !== category && lanes[c] === undefined)
  const settled = lane.queue.length >= PREFETCH_BELOW
  useEffect(() => {
    if (!active || !settled || !cold) return
    const t = setTimeout(() => void load(cold), 800)
    return () => clearTimeout(t)
  }, [active, settled, cold, load])

  return (
    <section className="screen deck-screen" style={{ "--amb": color } as CSSProperties} aria-label="Deck">
      <div className="ambient" aria-hidden="true">
        <div className="ambient-blob a" style={{ background: "var(--amb)" }} />
        <div className="ambient-blob b" style={{ background: "color-mix(in oklab, var(--amb) 55%, var(--violet))" }} />
      </div>
      <div className="deck-top">
        <div className="cat-tabs" role="tablist" aria-label="Category">
          {categories.map((c) => (
            <button
              key={c}
              type="button"
              role="tab"
              aria-selected={c === category}
              className="cat-tab"
              onClick={() => {
                flush()
                setCategory(c)
              }}
            >
              {CATEGORY_LABEL[c]}
              {c === category && (
                <motion.span layoutId="cat-line" className="cat-tab-line" transition={{ type: "spring", stiffness: 500, damping: 40 }} />
              )}
            </button>
          ))}
        </div>
        <button type="button" className="dial-chip" onClick={() => setDialOpen(true)} aria-label={`Discovery dial: ${describe(prefs.dial[category] ?? 0.5)}`}>
          <Icon.Spark />
          <span>{describe(prefs.dial[category] ?? 0.5)}</span>
        </button>
      </div>
      <SwipeStack
        cards={lane.queue}
        loading={lane.loading || (!lane.exhausted && lane.error === null)}
        active={active}
        returning={returning}
        undoable
        onDecide={decide}
        empty={
          <div className="empty">
            {lane.error ? (
              <>
                <h2>Picks didn't load</h2>
                <p>{lane.error}</p>
                <button type="button" className="btn btn-primary" onClick={() => void load(category)}>
                  Try again
                </button>
              </>
            ) : (
              <>
                <h2>That's the whole deck</h2>
                <p>
                  Turn the dial toward surprise, or loosen your filters in Settings, for more {CATEGORY_LABEL[category].toLowerCase()}.
                  {prefs.watch.onlyMine && (category === "movie" || category === "tv") && " You're only seeing what's on your services."}
                </p>
                <button
                  type="button"
                  className="btn"
                  onClick={() => {
                    patchLane(category, () => emptyLane)
                  }}
                >
                  Check again
                </button>
              </>
            )}
          </div>
        }
      />
      <Sheet open={dialOpen} onClose={() => setDialOpen(false)} label="Discovery dial">
        <Dial key={category} value={prefs.dial[category] ?? 0.5} onCommit={setDial} />
      </Sheet>
      <Toast text={toast?.text ?? null} action={toast?.undo ? "Undo" : undefined} onAction={undo} />
    </section>
  )
}
