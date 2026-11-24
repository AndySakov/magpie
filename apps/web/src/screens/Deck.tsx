import { CATEGORIES, type Category, type Recommendation } from "@magpie/contract"
import { motion } from "motion/react"
import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react"
import { api } from "../api"
import { Dial } from "../components/Dial"
import { SwipeStack, type Decision, type Dir } from "../components/SwipeStack"
import { useSession } from "../session"
import { CATEGORY_LABEL, Toast, useItemColor } from "../ui"

type Lane = {
  readonly queue: ReadonlyArray<Recommendation>
  readonly loading: boolean
  readonly exhausted: boolean
  readonly error: string | null
}

const emptyLane: Lane = { queue: [], loading: false, exhausted: false, error: null }
const BATCH = 10
const PREFETCH_BELOW = 5
const UNDO_MS = 5000

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
  const { prefs, savePrefs, pulseHoard } = useSession()
  const categories = userCategories(prefs.genres)
  const [category, setCategory] = useState<Category>(categories[0]!)
  const [lanes, setLanes] = useState<Partial<Record<Category, Lane>>>({})
  const [toast, setToast] = useState<{ text: string; undo: boolean } | null>(null)
  const [returning, setReturning] = useState<{ id: number; dir: Dir } | null>(null)
  const swiped = useRef(new Set<number>())
  const pending = useRef<Pending | null>(null)
  const inflight = useRef(new Set<Category>())
  const toastTimer = useRef<ReturnType<typeof setTimeout>>(undefined)

  const lane = lanes[category] ?? emptyLane
  const patchLane = useCallback(
    (c: Category, f: (l: Lane) => Lane) => setLanes((all) => ({ ...all, [c]: f(all[c] ?? emptyLane) })),
    []
  )

  const showToast = useCallback((text: string, undo: boolean) => {
    clearTimeout(toastTimer.current)
    setToast({ text, undo })
    toastTimer.current = setTimeout(() => setToast(null), undo ? UNDO_MS : 3500)
  }, [])

  const load = useCallback(
    async (c: Category) => {
      if (inflight.current.has(c)) return
      inflight.current.add(c)
      patchLane(c, (l) => ({ ...l, loading: true, error: null }))
      try {
        const batch = await api.deck(c, BATCH)
        patchLane(c, (l) => {
          const have = new Set(l.queue.map((r) => r.item.id as number))
          const fresh = batch.filter((r) => !swiped.current.has(r.item.id) && !have.has(r.item.id))
          return {
            queue: [...l.queue, ...fresh],
            loading: false,
            error: null,
            exhausted: batch.length === 0 || (fresh.length === 0 && l.queue.length === 0)
          }
        })
      } catch (e) {
        patchLane(c, (l) => ({ ...l, loading: false, error: (e as Error).message }))
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
    api.feedback(p.rec.item.id, p.decision.kind, rating).catch((e: Error) => showToast(e.message, false))
  }, [showToast])

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

  const filtersKey = JSON.stringify([prefs.filters, prefs.watch])
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
        between={<Dial key={category} value={prefs.dial[category] ?? 0.5} onCommit={setDial} />}
      />
      <Toast text={toast?.text ?? null} action={toast?.undo ? "Undo" : undefined} onAction={undo} />
    </section>
  )
}
