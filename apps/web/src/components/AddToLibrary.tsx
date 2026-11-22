import { CATEGORIES, type Category, type Item, type ItemId, type Status, type UserItem } from "@magpie/contract"
import { AnimatePresence, motion } from "motion/react"
import { useEffect, useRef, useState } from "react"
import { api } from "../api"
import { Art, CATEGORY_LABEL, Icon, Seg, Sheet, Stars, metaLine } from "../ui"

const CHOICES: ReadonlyArray<{ value: Status; label: string }> = [
  { value: "want", label: "Want" },
  { value: "in_progress", label: "On it" },
  { value: "finished", label: "Finished" }
]
const SHORT: Record<Status, string> = { want: "Want", in_progress: "On it", finished: "Finished", dropped: "Dropped" }

type Results = { tag: "idle" } | { tag: "loading" } | { tag: "ok"; items: ReadonlyArray<Item> } | { tag: "failed"; message: string }
type Further = { tag: "idle" } | { tag: "loading" } | { tag: "done"; items: ReadonlyArray<Item> } | { tag: "failed" }

const THIN = 5

export function AddToLibrary({
  open,
  onClose,
  library,
  onSaved
}: {
  open: boolean
  onClose: () => void
  library: ReadonlyMap<ItemId, UserItem>
  onSaved: (row: UserItem, previous: UserItem | undefined) => void
}) {
  const [query, setQuery] = useState("")
  const [category, setCategory] = useState<Category | null>(null)
  const [results, setResults] = useState<Results>({ tag: "idle" })
  const [further, setFurther] = useState<Further>({ tag: "idle" })
  const [expanded, setExpanded] = useState<ItemId | null>(null)
  const [saving, setSaving] = useState<ItemId | null>(null)
  const [error, setError] = useState<string | null>(null)
  const input = useRef<HTMLInputElement>(null)
  const latest = useRef(0)

  useEffect(() => {
    if (open) setTimeout(() => input.current?.focus(), 250)
  }, [open])

  useEffect(() => {
    const q = query.trim()
    setFurther({ tag: "idle" })
    if (q === "") return setResults({ tag: "idle" })
    const ticket = ++latest.current
    setResults((r) => (r.tag === "ok" ? r : { tag: "loading" }))
    const timer = setTimeout(() => {
      api.search(q, category).then(
        (items) => {
          if (ticket !== latest.current) return
          setResults({ tag: "ok", items })
          if (items.length < THIN && q.length >= 3) lookFurther(q, ticket)
        },
        (e: Error) => ticket === latest.current && setResults({ tag: "failed", message: e.message })
      )
    }, 220)
    return () => clearTimeout(timer)
  }, [query, category])

  const lookFurther = (q: string, ticket: number) => {
    setFurther({ tag: "loading" })
    api.searchFurther(q, category).then(
      (items) => ticket === latest.current && setFurther({ tag: "done", items }),
      () => ticket === latest.current && setFurther({ tag: "failed" })
    )
  }

  const known = new Set(results.tag === "ok" ? results.items.map((i) => i.id) : [])
  const extra = further.tag === "done" ? further.items.filter((i) => !known.has(i.id)) : []

  const save = async (item: Item, patch: { status: Status; rating?: number | null }) => {
    setSaving(item.id)
    setError(null)
    try {
      const saved = await api.updateItem(item.id, patch)
      onSaved(saved, library.get(item.id))
      if (patch.status !== "finished" || patch.rating !== undefined) setExpanded(null)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setSaving(null)
    }
  }

  return (
    <Sheet open={open} onClose={onClose} label="Add to your library" className="add-sheet">
      <h2 className="add-title">Add to your library</h2>
      <label className="wl-search add-search">
        <Icon.Search />
        <input
          ref={input}
          className="input"
          type="search"
          placeholder="Films, TV, anime or books"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          enterKeyHint="search"
          autoComplete="off"
        />
      </label>
      <div className="filter-row" role="group" aria-label="Kind">
        <button type="button" className="chip" aria-pressed={category === null} onClick={() => setCategory(null)}>
          All
        </button>
        {CATEGORIES.map((c) => (
          <button key={c} type="button" className="chip" aria-pressed={category === c} onClick={() => setCategory(c)}>
            {CATEGORY_LABEL[c]}
          </button>
        ))}
      </div>
      {error && <p className="error-note">{error}</p>}

      {results.tag === "idle" && <p className="add-hint">Search by title. Original titles work too, like Shingeki no Kyojin.</p>}
      {results.tag === "loading" && (
        <div aria-label="Searching">
          {[0, 1, 2].map((i) => (
            <div key={i} className="row-skel" />
          ))}
        </div>
      )}
      {results.tag === "failed" && <p className="error-note">{results.message}</p>}
      {results.tag === "ok" && results.items.length === 0 && further.tag === "done" && further.items.length === 0 && (
        <p className="add-hint">Nothing by that name here or in TMDB, AniList and Open Library. Try fewer words or another spelling.</p>
      )}
      {results.tag === "ok" && (
        <ul className="wl-list add-results">
          {[...results.items, ...extra].map((item, index) => {
            const row = library.get(item.id)
            const isOpen = expanded === item.id
            return (
              <li key={item.id} className="wl-row" data-open={isOpen} data-first-extra={index === results.items.length && index > 0}>
                <button type="button" className="wl-head" aria-expanded={isOpen} onClick={() => setExpanded(isOpen ? null : item.id)}>
                  <span className="wl-thumb">
                    <Art item={item} />
                  </span>
                  <span className="wl-main">
                    <span className="wl-title">{item.title}</span>
                    <span className="wl-meta">{metaLine(item)}</span>
                  </span>
                </button>
                <div className="wl-quick">
                  {row?.status ? (
                    <span className="add-status" style={{ color: `var(--st-${row.status})` }}>
                      <Icon.Check />
                      {SHORT[row.status]}
                    </span>
                  ) : (
                    <button
                      type="button"
                      className="wl-plus add-plus"
                      aria-label={`Add ${item.title} to Want`}
                      disabled={saving === item.id}
                      onClick={() => void save(item, { status: "want" })}
                    >
                      <Icon.Plus />
                    </button>
                  )}
                </div>
                <AnimatePresence initial={false}>
                  {isOpen && (
                    <motion.div
                      className="wl-detail"
                      initial={{ height: 0, opacity: 0 }}
                      animate={{ height: "auto", opacity: 1 }}
                      exit={{ height: 0, opacity: 0 }}
                      transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
                    >
                      <div className="wl-detail-inner">
                        <Seg
                          id={`add-${item.id}`}
                          className="status-seg"
                          value={row?.status ?? null}
                          onChange={(s) => void save(item, { status: s })}
                          colorOf={(s) => `var(--st-${s})`}
                          options={CHOICES}
                        />
                        {row?.status === "finished" && (
                          <div className="wl-detail-row">
                            <span className="field-label">Your rating</span>
                            <Stars
                              value={row.rating}
                              onChange={(v) => void save(item, { status: "finished", rating: v })}
                              label={`Rate ${item.title}`}
                            />
                          </div>
                        )}
                        {item.synopsis && <p className="add-synopsis">{item.synopsis}</p>}
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </li>
            )
          })}
        </ul>
      )}
      {results.tag === "ok" && (
        <div className="add-further" aria-live="polite">
          {further.tag === "loading" && (
            <p className="add-hint">
              <span className="spinner" aria-hidden="true" /> Looking in TMDB, AniList and Open Library…
            </p>
          )}
          {further.tag === "done" && extra.length > 0 && <p className="add-hint">Found {extra.length} more in TMDB, AniList and Open Library.</p>}
          {further.tag === "done" && extra.length === 0 && results.items.length > 0 && <p className="add-hint">Nothing more turned up elsewhere.</p>}
          {further.tag === "failed" && (
            <button type="button" className="btn btn-quiet" onClick={() => lookFurther(query.trim(), latest.current)}>
              The other catalogues didn't answer. Try again
            </button>
          )}
          {further.tag === "idle" && query.trim().length >= 3 && (
            <button type="button" className="btn btn-quiet" onClick={() => lookFurther(query.trim(), latest.current)}>
              Not here? Search further
            </button>
          )}
        </div>
      )}
    </Sheet>
  )
}
