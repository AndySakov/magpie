import { CATEGORIES, type Category, type ItemId, type Status, type UserItem } from "@magpie/contract"
import { AnimatePresence, motion } from "motion/react"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { api } from "../api"
import { AddToLibrary } from "../components/AddToLibrary"
import { WhereToWatch } from "../components/WhereToWatch"
import { Art, CATEGORY_LABEL, Icon, Seg, STATUSES, Stars, Toast, metaLine } from "../ui"

type Patch = { status?: Status | null; rating?: number | null; progress?: number | null }
type Notice = { text: string; undo?: () => void }

const TABS: ReadonlyArray<{ status: Status; label: string }> = [
  { status: "in_progress", label: "On it" },
  { status: "want", label: "Want" },
  { status: "finished", label: "Finished" },
  { status: "dropped", label: "Dropped" }
]
const SHORT: Record<Status, string> = { want: "Want", in_progress: "On it", finished: "Finished", dropped: "Dropped" }

const statusColor = (s: Status) => `var(--st-${s})`
const unitOf = (row: UserItem) =>
  row.item.lengthUnit === "episodes" ? "ep" : row.item.lengthUnit === "pages" ? "pp" : null
const previous = (row: UserItem, patch: Patch): Patch =>
  Object.fromEntries(Object.keys(patch).map((k) => [k, row[k as keyof Patch]]))

export function Library({ onGoToDeck }: { onGoToDeck: () => void }) {
  const [rows, setRows] = useState<ReadonlyArray<UserItem> | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [tab, setTab] = useState<Status | null>(null)
  const [category, setCategory] = useState<Category | null>(null)
  const [query, setQuery] = useState("")
  const [open, setOpen] = useState<ItemId | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [adding, setAdding] = useState(false)
  const noticeTimer = useRef<ReturnType<typeof setTimeout>>(undefined)

  const load = useCallback(() => {
    setError(null)
    setRows(null)
    api
      .idle()
      .then(() => api.watchlist({}))
      .then(setRows, (e: Error) => setError(e.message))
  }, [])

  useEffect(load, [load])

  const counts = useMemo(() => {
    const c: Record<Status, number> = { want: 0, in_progress: 0, finished: 0, dropped: 0 }
    for (const r of rows ?? []) if (r.status) c[r.status]++
    return c
  }, [rows])

  const active: Status = tab ?? (counts.in_progress > 0 ? "in_progress" : "want")
  const inTab = useMemo(() => (rows ?? []).filter((r) => r.status === active), [rows, active])
  const categories = CATEGORIES.filter((c) => inTab.some((r) => r.item.category === c))
  const shownCategory = category && categories.includes(category) ? category : null
  const needle = query.trim().toLowerCase()
  const visible = inTab.filter(
    (r) => (shownCategory === null || r.item.category === shownCategory) && (needle === "" || r.item.title.toLowerCase().includes(needle))
  )

  const notify = (n: Notice) => {
    clearTimeout(noticeTimer.current)
    setNotice(n)
    noticeTimer.current = setTimeout(() => setNotice(null), 4500)
  }

  const update = async (row: UserItem, patch: Patch, moved?: string) => {
    const replace = (next: UserItem) => setRows((all) => all?.map((r) => (r.item.id === row.item.id ? next : r)) ?? all)
    replace({ ...row, ...patch } as UserItem)
    if (moved) notify({ text: moved, undo: () => void update({ ...row, ...patch } as UserItem, previous(row, patch)) })
    try {
      replace(await api.updateItem(row.item.id, patch))
    } catch (e) {
      replace(row)
      notify({ text: (e as Error).message })
    }
  }

  const patchRow = (row: UserItem, patch: Patch) => {
    const unit = unitOf(row)
    const max = row.item.lengthValue
    if (patch.progress !== undefined && patch.progress !== null && unit && max !== null && patch.progress >= max && row.status === "in_progress") {
      return void update(row, { ...patch, status: "finished" }, `Finished ${row.item.title}`)
    }
    if (patch.status === null) return void update(row, patch, `Removed ${row.item.title}`)
    if (patch.status && patch.status !== row.status) return void update(row, patch, `Moved to ${SHORT[patch.status]}`)
    void update(row, patch)
  }

  const total = rows?.filter((r) => r.status).length ?? 0
  const byId = useMemo(() => new Map((rows ?? []).map((r) => [r.item.id, r])), [rows])
  const saved = useCallback((row: UserItem, previous: UserItem | undefined) => {
    setRows((all) => (previous ? all?.map((r) => (r.item.id === row.item.id ? row : r)) : [row, ...(all ?? [])]) ?? all)
    if (row.status) setTab(row.status)
    setCategory(null)
    setQuery("")
  }, [])

  return (
    <section className="screen" aria-label="Library">
      <header className="screen-head">
        <h1 className="screen-title">Library</h1>
      </header>

      {rows !== null && total > 0 && (
        <>
          <div className="wl-tabs" role="tablist" aria-label="Status">
            {TABS.map((t) => (
              <button
                key={t.status}
                type="button"
                role="tab"
                aria-selected={active === t.status}
                className="wl-tab"
                onClick={() => (setTab(t.status), setOpen(null))}
              >
                {active === t.status && (
                  <motion.span
                    layoutId="wl-tab"
                    className="wl-tab-thumb"
                    style={{ background: statusColor(t.status) }}
                    transition={{ type: "spring", stiffness: 500, damping: 38 }}
                  />
                )}
                <span className="wl-tab-label">{t.label}</span>
                <span className="wl-tab-count">{counts[t.status]}</span>
              </button>
            ))}
          </div>
          {(categories.length > 1 || inTab.length > 8) && (
            <div className="wl-tools">
              {categories.length > 1 && (
                <div className="filter-row" role="group" aria-label="Filter by kind">
                  <button type="button" className="chip" aria-pressed={shownCategory === null} onClick={() => setCategory(null)}>
                    All
                  </button>
                  {categories.map((c) => (
                    <button key={c} type="button" className="chip" aria-pressed={shownCategory === c} onClick={() => setCategory(c)}>
                      {CATEGORY_LABEL[c]}
                      <span className="chip-count">{inTab.filter((r) => r.item.category === c).length}</span>
                    </button>
                  ))}
                </div>
              )}
              {inTab.length > 8 && (
                <label className="wl-search">
                  <Icon.Search />
                  <input
                    className="input"
                    type="search"
                    placeholder="Find in this list"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                  />
                </label>
              )}
            </div>
          )}
        </>
      )}

      {error && (
        <div className="list-empty">
          <h2>Your list didn't load</h2>
          <p>{error}</p>
          <button type="button" className="btn btn-primary" onClick={load}>
            Try again
          </button>
        </div>
      )}
      {!error && rows === null && (
        <div aria-label="Loading your list">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="row-skel" />
          ))}
        </div>
      )}
      {rows !== null && total === 0 && (
        <div className="list-empty">
          <h2>Nothing saved yet</h2>
          <p>Swipe right on anything you want to watch or read, or search for something you already know.</p>
          <div className="chips">
            <button type="button" className="btn btn-primary" onClick={onGoToDeck}>
              Open the deck
            </button>
            <button type="button" className="btn btn-quiet" onClick={() => setAdding(true)}>
              Search to add
            </button>
          </div>
        </div>
      )}
      {rows !== null && total > 0 && visible.length === 0 && (
        <div className="list-empty">
          <h2>{inTab.length === 0 ? EMPTY_TAB[active] : "Nothing matches"}</h2>
          <p>{inTab.length === 0 ? EMPTY_HINT[active] : "Try another name or kind."}</p>
        </div>
      )}
      {visible.length > 0 && (
        <ul className="wl-list">
          <AnimatePresence initial={false}>
            {visible.map((row) => (
              <motion.li
                key={row.item.id}
                layout
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0, x: -40, transition: { duration: 0.2 } }}
                className="wl-row"
                data-open={open === row.item.id}
              >
                <Row
                  row={row}
                  open={open === row.item.id}
                  onToggle={() => setOpen((o) => (o === row.item.id ? null : row.item.id))}
                  onPatch={(p) => patchRow(row, p)}
                />
              </motion.li>
            ))}
          </AnimatePresence>
        </ul>
      )}
      <AnimatePresence>
        {!adding && (
          <motion.button
            type="button"
            className="fab"
            aria-label="Add to library"
            onClick={() => setAdding(true)}
            initial={{ scale: 0.6, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 0.6, opacity: 0 }}
            whileTap={{ scale: 0.92 }}
            transition={{ type: "spring", stiffness: 500, damping: 30 }}
          >
            <Icon.Plus />
          </motion.button>
        )}
      </AnimatePresence>
      <AddToLibrary open={adding} onClose={() => setAdding(false)} library={byId} onSaved={saved} />
      <Toast text={notice?.text ?? null} action={notice?.undo ? "Undo" : undefined} onAction={() => (notice?.undo?.(), setNotice(null))} />
    </section>
  )
}

const EMPTY_TAB: Record<Status, string> = {
  in_progress: "Nothing on the go",
  want: "Nothing waiting",
  finished: "Nothing finished yet",
  dropped: "Nothing dropped"
}
const EMPTY_HINT: Record<Status, string> = {
  in_progress: "Start something from Want and track where you are here.",
  want: "Swipe right in the deck to save things for later.",
  finished: "Finish something and rate it here. Ratings sharpen your deck.",
  dropped: "Anything you give up on goes here, and the deck learns from it."
}

function Row({
  row,
  open,
  onToggle,
  onPatch
}: {
  row: UserItem
  open: boolean
  onToggle: () => void
  onPatch: (p: Patch) => void
}) {
  const { item } = row
  const unit = unitOf(row)
  return (
    <>
      <button type="button" className="wl-head" aria-expanded={open} onClick={onToggle}>
        <span className="wl-thumb">
          <Art item={item} />
        </span>
        <span className="wl-main">
          <span className="wl-title">{item.title}</span>
          <span className="wl-meta">{metaLine(item)}</span>
          {row.status === "in_progress" && unit && item.lengthValue !== null && (
            <span className="wl-bar" aria-hidden="true">
              <i style={{ width: `${Math.min(100, ((row.progress ?? 0) / item.lengthValue) * 100)}%` }} />
            </span>
          )}
        </span>
      </button>
      <div className="wl-quick">
        <Quick row={row} onPatch={onPatch} />
      </div>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            className="wl-detail"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
          >
            <div className="wl-detail-inner">
              <Seg
                id={`status-${item.id}`}
                className="status-seg"
                value={row.status}
                onChange={(s) => onPatch({ status: s })}
                colorOf={statusColor}
                options={STATUSES.map((s) => ({ value: s, label: SHORT[s] }))}
              />
              <div className="wl-detail-row">
                <span className="field-label">Your rating</span>
                <Stars value={row.rating} onChange={(v) => onPatch({ rating: v })} label={`Rate ${item.title}`} />
              </div>
              {unit && row.status !== "want" && (
                <div className="wl-detail-row">
                  <span className="field-label">{unit === "ep" ? "Episodes watched" : "Pages read"}</span>
                  <Progress
                    value={row.progress}
                    max={item.lengthValue}
                    unit={unit}
                    label={unit === "ep" ? "Episodes watched" : "Pages read"}
                    onChange={(v) => onPatch({ progress: v })}
                  />
                </div>
              )}
              {(row.status === "want" || row.status === "in_progress") && <WhereToWatch item={item} />}
              {item.publicScore !== null && (
                <p className="wl-score">
                  Rated higher than {item.publicScore}% of {CATEGORY_LABEL[item.category].toLowerCase()} in the catalogue
                </p>
              )}
              {row.status === "want" && row.rating === null && (
                <button type="button" className="btn btn-quiet wl-remove" onClick={() => onPatch({ status: null })}>
                  Remove from list
                </button>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  )
}

function Quick({ row, onPatch }: { row: UserItem; onPatch: (p: Patch) => void }) {
  const unit = unitOf(row)
  const max = row.item.lengthValue
  switch (row.status) {
    case "want":
      return (
        <button type="button" className="btn btn-quiet wl-action" onClick={() => onPatch({ status: "in_progress" })}>
          Start
        </button>
      )
    case "in_progress":
      return unit ? (
        <div className="wl-step">
          <span className="wl-step-count">
            {row.progress ?? 0}
            {max !== null && <small>/{max}</small>}
          </span>
          <button
            type="button"
            className="wl-plus"
            aria-label={unit === "ep" ? "Watched one more episode" : "Read one more page"}
            onClick={() => onPatch({ progress: Math.min(max ?? Infinity, (row.progress ?? 0) + 1) })}
          >
            <Icon.Plus />
          </button>
        </div>
      ) : (
        <button type="button" className="btn btn-quiet wl-action" onClick={() => onPatch({ status: "finished" })}>
          Done
        </button>
      )
    case "finished":
    case "dropped":
      return row.rating === null ? (
        <Stars value={null} onChange={(v) => onPatch({ rating: v })} label={`Rate ${row.item.title}`} />
      ) : (
        <span className="wl-rated" aria-label={`Rated ${row.rating} of 5`}>
          <Icon.Star on />
          {row.rating}
        </span>
      )
    default:
      return null
  }
}

function Progress({
  value,
  max,
  unit,
  label,
  onChange
}: {
  value: number | null
  max: number | null
  unit: string
  label: string
  onChange: (v: number | null) => void
}) {
  const [draft, setDraft] = useState(value?.toString() ?? "")
  useEffect(() => setDraft(value?.toString() ?? ""), [value])
  const clamp = (n: number) => Math.max(0, max === null ? n : Math.min(max, n))
  const commit = () => {
    const n = draft.trim() === "" ? null : clamp(Math.round(Number(draft)))
    if (n !== null && Number.isNaN(n)) return setDraft(value?.toString() ?? "")
    if (n !== value) onChange(n)
  }
  return (
    <div className="stepper" role="group" aria-label={label}>
      <button type="button" aria-label="One less" onClick={() => onChange(clamp((value ?? 0) - 1))} disabled={!value}>
        <Icon.Minus />
      </button>
      <input
        inputMode="numeric"
        aria-label={label}
        value={draft}
        placeholder="0"
        onChange={(e) => setDraft(e.target.value.replace(/[^0-9]/g, ""))}
        onBlur={commit}
        onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
      />
      <span className="stepper-unit">
        {max !== null ? `/ ${max} ` : ""}
        {unit}
      </span>
      <button
        type="button"
        aria-label="One more"
        onClick={() => onChange(clamp((value ?? 0) + 1))}
        disabled={max !== null && (value ?? 0) >= max}
      >
        <Icon.Plus />
      </button>
    </div>
  )
}
