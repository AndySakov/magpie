import type { ImportResult, ImportSource, Item, UnmatchedRow } from "@magpie/contract"
import { AnimatePresence, motion } from "motion/react"
import { useRef, useState, type DragEvent, type FormEvent } from "react"
import { api } from "../api"
import { readExports } from "../exports"
import { Art, Icon, STATUS_LABEL, metaLine } from "../ui"

const SOURCE_NAME: Record<ImportSource, string> = {
  letterboxd: "Letterboxd",
  imdb: "IMDb",
  goodreads: "Goodreads",
  mal: "MyAnimeList",
  anilist: "AniList"
}

const SOURCE_HUE: Record<ImportSource, number> = { letterboxd: 150, imdb: 85, goodreads: 55, mal: 260, anilist: 230 }

const GUIDES: ReadonlyArray<{ source: ImportSource; what: string; steps: ReadonlyArray<string>; url?: string }> = [
  {
    source: "letterboxd",
    what: "Films you've logged, rated and saved",
    steps: ["Open Settings, then Data.", "Choose Export your data.", "Drop the .zip here as it is."],
    url: "https://letterboxd.com/settings/data/"
  },
  {
    source: "imdb",
    what: "Your film and TV ratings",
    steps: ["Open Your Ratings.", "Choose Export.", "Download the CSV from your Exports page and drop it here."],
    url: "https://www.imdb.com/list/ratings"
  },
  {
    source: "goodreads",
    what: "Books you've read, rated and shelved",
    steps: ["Open Import and export.", "Choose Export Library and wait for the link.", "Download the CSV and drop it here."],
    url: "https://www.goodreads.com/review/import"
  },
  {
    source: "mal",
    what: "Your anime list",
    steps: ["Open the export page.", "Pick Anime List and choose Export.", "Drop the .xml.gz here as it is."],
    url: "https://myanimelist.net/panel.php?go=export"
  },
  {
    source: "anilist",
    what: "Your anime list, by username",
    steps: ["Make sure your profile is public.", "Type your username above. There's no file to download."]
  }
]

type RunState =
  | { readonly tag: "queued" }
  | { readonly tag: "running" }
  | { readonly tag: "failed"; readonly message: string }
  | { readonly tag: "done"; readonly result: ImportResult; readonly resolved: ReadonlyMap<number, string | null> }

type Job = { readonly id: number; readonly source: ImportSource | null; readonly label: string; readonly state: RunState }

const Badge = ({ source }: { source: ImportSource }) => (
  <span className="source-badge" style={{ ["--hue" as string]: SOURCE_HUE[source] }}>
    {SOURCE_NAME[source]}
  </span>
)

export function Imports({ embedded = false }: { embedded?: boolean }) {
  const [jobs, setJobs] = useState<ReadonlyArray<Job>>([])
  const [over, setOver] = useState(false)
  const [reading, setReading] = useState(false)
  const [username, setUsername] = useState("")
  const nextId = useRef(0)
  const queue = useRef<Promise<void>>(Promise.resolve())

  const patch = (id: number, state: RunState) => setJobs((js) => js.map((j) => (j.id === id ? { ...j, state } : j)))

  const enqueue = (source: ImportSource, label: string, content: string, filename?: string) => {
    const id = nextId.current++
    setJobs((js) => [...js, { id, source, label, state: { tag: "queued" } }])
    queue.current = queue.current.then(async () => {
      patch(id, { tag: "running" })
      try {
        const result = await api.importHistory(source, content, filename)
        patch(id, { tag: "done", result, resolved: new Map() })
      } catch (e) {
        patch(id, { tag: "failed", message: (e as Error).message })
      }
    })
  }

  const addFiles = async (files: ReadonlyArray<File>) => {
    if (files.length === 0) return
    setReading(true)
    const found = await readExports(files)
    setReading(false)
    for (const f of found) {
      if (f.tag === "ok") enqueue(f.source, f.name, f.content, f.name)
      else {
        const id = nextId.current++
        setJobs((js) => [...js, { id, source: null, label: f.name, state: { tag: "failed", message: f.message } }])
      }
    }
  }

  const onDrop = (e: DragEvent) => {
    e.preventDefault()
    setOver(false)
    void addFiles([...e.dataTransfer.files])
  }

  const onSubmitUser = (e: FormEvent) => {
    e.preventDefault()
    const name = username.trim()
    if (!name) return
    enqueue("anilist", `@${name}`, name)
    setUsername("")
  }

  const resolve = (id: number, index: number, title: string | null) =>
    setJobs((js) =>
      js.map((j) =>
        j.id === id && j.state.tag === "done" ? { ...j, state: { ...j.state, resolved: new Map(j.state.resolved).set(index, title) } } : j
      )
    )

  return (
    <section className={embedded ? "import-sheet-body" : "screen"} aria-label="Imports">
      <header className="screen-head">
        <h1 className="screen-title" style={embedded ? { fontSize: "2rem" } : undefined}>
          Bring your history
        </h1>
      </header>
      <p className="lede" style={{ marginBottom: 20 }}>
        Everything you've already rated teaches the deck faster than swiping.
      </p>

      <label
        className={`drop drop-hero ${over ? "over" : ""}`}
        onDragOver={(e) => {
          e.preventDefault()
          setOver(true)
        }}
        onDragLeave={() => setOver(false)}
        onDrop={onDrop}
      >
        <input
          type="file"
          multiple
          accept=".csv,.xml,.gz,.zip,text/csv,text/xml,application/xml,application/zip,application/gzip"
          onChange={(e) => {
            void addFiles([...(e.target.files ?? [])])
            e.target.value = ""
          }}
        />
        <span className="drop-icon">
          <Icon.Upload />
        </span>
        <strong>{reading ? "Opening your files…" : over ? "Let go to import" : "Drop your exports here"}</strong>
        <span>or tap to choose files</span>
        <small>Letterboxd, IMDb, Goodreads or MyAnimeList. Magpie works out which is which.</small>
      </label>

      <form className="anilist-row" onSubmit={onSubmitUser}>
        <Badge source="anilist" />
        <input
          className="input"
          placeholder="AniList username"
          aria-label="AniList username"
          value={username}
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          onChange={(e) => setUsername(e.target.value)}
        />
        <button type="submit" className="btn" disabled={!username.trim()}>
          Import
        </button>
      </form>

      {jobs.length > 0 && (
        <div className="jobs">
          <AnimatePresence initial={false}>
            {jobs.map((job) => (
              <motion.div
                key={job.id}
                className="source"
                layout
                initial={{ opacity: 0, y: -8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ type: "spring", stiffness: 420, damping: 36 }}
              >
                <div className="job-head">
                  {job.source && <Badge source={job.source} />}
                  <span className="job-label">{job.label}</span>
                  <span className={`job-status ${job.state.tag}`}>
                    {job.state.tag === "queued" && "Waiting"}
                    {job.state.tag === "running" && "Matching…"}
                    {job.state.tag === "done" && <Icon.Check />}
                  </span>
                </div>
                {job.state.tag === "failed" && <p className="error-note">{job.state.message}</p>}
                {job.state.tag === "done" && (
                  <ResultView
                    result={job.state.result}
                    resolved={job.state.resolved}
                    onResolved={(i, title) => resolve(job.id, i, title)}
                  />
                )}
              </motion.div>
            ))}
          </AnimatePresence>
        </div>
      )}

      <div className="guides">
        <h2 className="guides-title">Where to find your export</h2>
        {GUIDES.map((g) => (
          <details key={g.source} className="guide">
            <summary>
              <Badge source={g.source} />
              <span className="guide-what">{g.what}</span>
              <Icon.Plus />
            </summary>
            <ol>
              {g.steps.map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ol>
            {g.url && (
              <a className="guide-link" href={g.url} target="_blank" rel="noreferrer">
                Open {SOURCE_NAME[g.source]}
                <Icon.Link />
              </a>
            )}
          </details>
        ))}
      </div>
    </section>
  )
}

function ResultView({
  result,
  resolved,
  onResolved
}: {
  result: ImportResult
  resolved: ReadonlyMap<number, string | null>
  onResolved: (index: number, title: string | null) => void
}) {
  const open = result.unmatched.filter((_, i) => !resolved.has(i)).length
  const confirmed = [...resolved.values()].filter((v) => v !== null).length
  return (
    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} style={{ display: "grid", gap: 12 }}>
      <div className="result-line">
        <span className="result-num">{result.matched + confirmed}</span>
        <span>of {result.total} titles matched</span>
      </div>
      {result.unmatched.length > 0 && (
        <div className="unmatched">
          <p className="source-hint">
            {open > 0 ? `${open} need you. Pick the right one, or skip it.` : "All confirmed. Your deck already knows."}
          </p>
          <AnimatePresence initial={false}>
            {result.unmatched.map((row, i) =>
              resolved.has(i) ? (
                <motion.p key={`done-${i}`} className="done-note" initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
                  <Icon.Check />
                  {resolved.get(i) === null ? `Skipped “${row.title}”` : `“${row.title}” is ${resolved.get(i)}`}
                </motion.p>
              ) : (
                <motion.div key={`row-${i}`} exit={{ opacity: 0, height: 0 }}>
                  <Unmatched row={row} onPicked={(title) => onResolved(i, title)} />
                </motion.div>
              )
            )}
          </AnimatePresence>
        </div>
      )}
    </motion.div>
  )
}

function Unmatched({ row, onPicked }: { row: UnmatchedRow; onPicked: (title: string | null) => void }) {
  const [busy, setBusy] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)

  const pick = async (item: Item) => {
    setBusy(item.id)
    setError(null)
    try {
      await api.updateItem(item.id, {
        status: row.status ?? "finished",
        ...(row.rating !== null ? { rating: row.rating } : {})
      })
      onPicked(item.title)
    } catch (e) {
      setError((e as Error).message)
      setBusy(null)
    }
  }

  const detail = [
    row.year?.toString(),
    row.rating !== null ? `you rated ${row.rating}/5` : null,
    row.status ? STATUS_LABEL[row.status].toLowerCase() : null
  ]
    .filter(Boolean)
    .join(", ")

  return (
    <div className="unmatched-row">
      <div>
        <div className="unmatched-title">“{row.title}”</div>
        {detail && <div className="wl-meta">{detail}</div>}
      </div>
      {row.candidates.length === 0 ? (
        <p className="source-hint">No likely matches in the catalogue.</p>
      ) : (
        <div className="candidates">
          {row.candidates.map((c) => (
            <button key={c.id} type="button" className="candidate" onClick={() => void pick(c)} disabled={busy !== null}>
              <div className="wl-thumb">
                <Art item={c} />
              </div>
              <div>
                <div className="wl-title" style={{ fontSize: "0.95rem" }}>
                  {c.title}
                </div>
                <div className="wl-meta">{metaLine(c)}</div>
              </div>
              <span className="candidate-pick">{busy === c.id ? "Saving…" : "This one"}</span>
            </button>
          ))}
        </div>
      )}
      <button type="button" className="btn btn-quiet" style={{ justifySelf: "start", minHeight: 36 }} onClick={() => onPicked(null)}>
        Skip
      </button>
      {error && <p className="error-note">{error}</p>}
    </div>
  )
}
