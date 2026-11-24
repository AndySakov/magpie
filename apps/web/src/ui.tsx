import type { Category, Item, Status } from "@magpie/contract"
import { AnimatePresence, animate, motion, useMotionValue, type MotionValue } from "motion/react"
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react"
import { hueOf, knownImageColor, sampleImageColor } from "./color"

export const CATEGORY_LABEL: Record<Category, string> = {
  movie: "Films",
  tv: "TV",
  anime: "Anime",
  book: "Books"
}
export const STATUS_LABEL: Record<Status, string> = {
  want: "Want",
  in_progress: "In progress",
  finished: "Finished",
  dropped: "Dropped"
}
export const STATUSES: ReadonlyArray<Status> = ["want", "in_progress", "finished", "dropped"]

export const vibrate = (pattern: number | number[]) => {
  try {
    navigator.vibrate?.(pattern)
  } catch {
    // unsupported
  }
}

export const formatLength = (item: Item) => {
  if (item.lengthValue === null || item.lengthUnit === null) return null
  if (item.lengthUnit === "minutes") {
    const h = Math.floor(item.lengthValue / 60)
    const m = item.lengthValue % 60
    return h > 0 ? `${h}h ${m.toString().padStart(2, "0")}m` : `${m}m`
  }
  return `${item.lengthValue} ${item.lengthUnit === "episodes" ? (item.lengthValue === 1 ? "episode" : "episodes") : "pages"}`
}

export const metaLine = (item: Item) =>
  [item.year?.toString(), CATEGORY_LABEL[item.category], formatLength(item)].filter(Boolean).join(", ")

/* ---------- icons: one 24px grid, 1.75 stroke, round joins ---------- */

const Svg = ({ children, fill = "none" }: { children: ReactNode; fill?: string }) => (
  <svg
    viewBox="0 0 24 24"
    width={24}
    height={24}
    fill={fill}
    stroke="currentColor"
    strokeWidth={1.75}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    {children}
  </svg>
)

export const Icon = {
  Nope: () => (
    <Svg>
      <path d="M6 6l12 12M18 6L6 18" strokeWidth={2.4} />
    </Svg>
  ),
  Want: () => (
    <Svg>
      <path d="M7 3.5h10a1 1 0 0 1 1 1V21l-6-4.2L6 21V4.5a1 1 0 0 1 1-1z" strokeWidth={2.1} />
    </Svg>
  ),
  Eye: () => (
    <Svg>
      <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" />
      <circle cx="12" cy="12" r="3" />
    </Svg>
  ),
  Deck: () => (
    <Svg>
      <rect x="6" y="3.5" width="12" height="15" rx="2.5" />
      <path d="M4 7.5v10A3 3 0 0 0 7 20.5h8" />
    </Svg>
  ),
  Search: () => (
    <Svg>
      <circle cx="11" cy="11" r="6.5" />
      <path d="M20 20l-4.2-4.2" />
    </Svg>
  ),
  Hoard: () => (
    <Svg>
      <path d="M7 3.5h10a1 1 0 0 1 1 1V21l-6-4.2L6 21V4.5a1 1 0 0 1 1-1z" />
    </Svg>
  ),
  Import: () => (
    <Svg>
      <path d="M12 3.5v11M7.5 10l4.5 4.5 4.5-4.5" />
      <path d="M4 15.5v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" />
    </Svg>
  ),
  Sliders: () => (
    <Svg>
      <path d="M4 7h9M17 7h3M4 17h3M11 17h9" />
      <circle cx="15" cy="7" r="2" />
      <circle cx="9" cy="17" r="2" />
    </Svg>
  ),
  Spark: () => (
    <Svg>
      <path d="M12 3.5l1.9 5.6 5.6 1.9-5.6 1.9L12 18.5l-1.9-5.6L4.5 11l5.6-1.9z" />
    </Svg>
  ),
  Star: ({ on }: { on: boolean }) => (
    <Svg fill={on ? "currentColor" : "none"}>
      <path d="M12 3.6l2.6 5.3 5.8.8-4.2 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.2-4.1 5.8-.8z" />
    </Svg>
  ),
  ThumbUp: () => (
    <Svg>
      <path d="M7.5 10.5v9h-3v-9zM7.5 10.5l3.8-6.6a1.8 1.8 0 0 1 3.3 1.3l-.9 4.3h5a1.8 1.8 0 0 1 1.8 2.1l-1.2 6.4a2 2 0 0 1-2 1.5H7.5" />
    </Svg>
  ),
  ThumbDown: () => (
    <Svg>
      <path d="M7.5 13.5v-9h-3v9zM7.5 13.5l3.8 6.6a1.8 1.8 0 0 0 3.3-1.3l-.9-4.3h5a1.8 1.8 0 0 0 1.8-2.1l-1.2-6.4a2 2 0 0 0-2-1.5H7.5" />
    </Svg>
  ),
  Undo: () => (
    <Svg>
      <path d="M9 14L4.5 9.5 9 5" />
      <path d="M4.5 9.5H14a5.5 5.5 0 0 1 0 11h-3" />
    </Svg>
  ),
  Check: () => (
    <Svg>
      <path d="M5 12.5l4.5 4.5L19 7.5" strokeWidth={2.4} />
    </Svg>
  ),
  Plus: () => (
    <Svg>
      <path d="M12 5v14M5 12h14" strokeWidth={2.2} />
    </Svg>
  ),
  Minus: () => (
    <Svg>
      <path d="M5 12h14" strokeWidth={2.2} />
    </Svg>
  ),
  Close: () => (
    <Svg>
      <path d="M7 7l10 10M17 7L7 17" />
    </Svg>
  ),
  Upload: () => (
    <Svg>
      <path d="M12 15.5v-11M7.5 9L12 4.5 16.5 9" />
      <path d="M4 15.5v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" />
    </Svg>
  ),
  Key: () => (
    <Svg>
      <circle cx="8" cy="15" r="4.5" />
      <path d="M11.2 11.8L20 3M16.5 6.5l2.5 2.5M14 9l2 2" />
    </Svg>
  ),
  Link: () => (
    <Svg>
      <path d="M10 14a4.5 4.5 0 0 0 6.4 0l3.2-3.2a4.5 4.5 0 0 0-6.4-6.4L11.6 6" />
      <path d="M14 10a4.5 4.5 0 0 0-6.4 0l-3.2 3.2a4.5 4.5 0 0 0 6.4 6.4L12.4 18" />
    </Svg>
  )
}

/* ---------- artwork ---------- */

const titleSize = (title: string): CSSProperties => {
  const n = title.length
  if (n <= 6) return { fontSize: "5.2rem", fontVariationSettings: '"wdth" 118' }
  if (n <= 12) return { fontSize: "4.1rem", fontVariationSettings: '"wdth" 82' }
  if (n <= 20) return { fontSize: "3.3rem", fontVariationSettings: '"wdth" 66' }
  if (n <= 32) return { fontSize: "2.7rem", fontVariationSettings: '"wdth" 58' }
  return { fontSize: "2.15rem", fontVariationSettings: '"wdth" 52' }
}

export const typeCardVars = (title: string): CSSProperties => {
  const h = hueOf(title)
  return {
    "--tc-ground": `oklch(0.27 0.06 ${h})`,
    "--tc-a": `oklch(0.58 0.17 ${(h + 50) % 360})`,
    "--tc-b": `oklch(0.7 0.14 ${(h + 320) % 360})`
  } as CSSProperties
}

export function TypeCard({ item, bare = false }: { item: Item; bare?: boolean }) {
  if (bare) return <div className="type-card" style={typeCardVars(item.title)} />
  return (
    <div className="type-card" style={typeCardVars(item.title)}>
      <div className="type-card-year">{item.year ?? "n.d."}</div>
      <div>
        <div className="type-card-title" style={titleSize(item.title)} lang="en">
          {item.title}
        </div>
        {item.genres.length > 0 && <div className="type-card-genres">{item.genres.slice(0, 3).join(" / ")}</div>}
      </div>
    </div>
  )
}

type Source = { readonly src: string; readonly srcSet?: string }

const TMDB = /^(https:\/\/image\.tmdb\.org\/t\/p\/)w(\d+)(\/.+)$/
const OPEN_LIBRARY = /^(https:\/\/covers\.openlibrary\.org\/b\/id\/\d+)-[SML]\.jpg$/
const MAL = /^(https:\/\/cdn\.myanimelist\.net\/images\/anime\/\d+\/\d+)\.jpg$/

/** The sharpest version of an image URL first, then the original as a fallback. */
export const imageSources = (url: string): ReadonlyArray<Source> => {
  const tmdb = TMDB.exec(url)
  if (tmdb) {
    const [, base, size, path] = tmdb
    const widths = Number(size) > 780 ? [300, 780, 1280] : [185, 342, 500, 780]
    return [
      {
        src: url,
        srcSet: widths.map((w) => `${base}w${w}${path} ${w}w`).join(", ")
      }
    ]
  }
  const openLibrary = OPEN_LIBRARY.exec(url)
  if (openLibrary)
    return [
      {
        src: url,
        srcSet: `${openLibrary[1]}-M.jpg 180w, ${openLibrary[1]}-L.jpg 500w`
      }
    ]
  const mal = MAL.exec(url)
  if (mal) return [{ src: `${mal[1]}l.jpg`, srcSet: `${url} 225w, ${mal[1]}l.jpg 425w` }, { src: url }]
  if (url.includes("/cover/medium/")) {
    const large = url.replace("/cover/medium/", "/cover/large/")
    return [{ src: large, srcSet: `${url} 230w, ${large} 460w` }, { src: url }]
  }
  return [{ src: url }]
}

const FIT_TOLERANCE = 0.1
const FILL_TOLERANCE = 0.3

/** Poster when there is one and it loads; the typographic card otherwise. Odd-shaped images sit whole over a blurred copy. */
/** `fill` crops harder before framing: on a swipe card the picture should fill the card, as on a dating app. */
export function Art({ item, eager = false, src, fill = false }: { item: Item; eager?: boolean; src?: string | null; fill?: boolean }) {
  const url = src ?? item.imageUrl
  const sources = useMemo(() => [...new Set([src, item.imageUrl])].flatMap((u) => (u ? imageSources(u) : [])), [src, item.imageUrl])
  const [attempt, setAttempt] = useState(0)
  const [fit, setFit] = useState<"loading" | "cover" | "framed">("loading")
  const [width, setWidth] = useState(0)
  const box = useRef<HTMLDivElement>(null)
  const ratio = useRef(0)
  const [shown, setShown] = useState<string | null>(null)

  useEffect(() => {
    setAttempt(0)
    setFit("loading")
    ratio.current = 0
  }, [url])

  const decide = useCallback(() => {
    const el = box.current
    if (!el || !ratio.current || !el.clientHeight) return
    const boxRatio = el.clientWidth / el.clientHeight
    setFit(Math.abs(Math.log(ratio.current / boxRatio)) <= (fill ? FILL_TOLERANCE : FIT_TOLERANCE) ? "cover" : "framed")
  }, [fill])

  useEffect(() => {
    const el = box.current
    if (!el) return
    const observer = new ResizeObserver(() => {
      setWidth(el.clientWidth)
      decide()
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [decide, attempt, url])

  const source = sources[attempt]
  if (!source) return <TypeCard item={item} />
  return (
    <div ref={box} className={`art art-${fit}`}>
      {fit === "loading" && <TypeCard item={item} bare />}
      {fit === "framed" && shown && <img className="art-fill" src={shown} alt="" aria-hidden="true" draggable={false} />}
      {width > 0 && (
        <img
          key={source.src}
          className="art-img"
          src={source.src}
          srcSet={source.srcSet}
          sizes={source.srcSet ? `${Math.ceil(width)}px` : undefined}
          alt=""
          crossOrigin="anonymous"
          loading={eager ? "eager" : "lazy"}
          decoding="async"
          draggable={false}
          onLoad={(e) => {
            const img = e.currentTarget
            ratio.current = img.naturalWidth / img.naturalHeight
            setShown(img.currentSrc || img.src)
            decide()
          }}
          onError={() => setAttempt((n) => n + 1)}
        />
      )}
    </div>
  )
}

export const hasArt = (item: Item) => item.imageUrl !== null

/** Ambient colour for an item: sampled from its poster, or derived from its title. */
/**
 * The colour of an item's art. While a new item's colour is being sampled the previous colour stays, so the
 * background changes once, to the right colour, instead of flashing a placeholder first.
 */
export function useItemColor(item: Item | undefined): string {
  const fallback = item ? `hsl(${hueOf(item.title)}, 62%, 52%)` : "hsl(228, 80%, 62%)"
  const now = item?.imageUrl ? knownImageColor(item.imageUrl) : null
  const [color, setColor] = useState(now ?? fallback)
  useEffect(() => {
    if (!item?.imageUrl) return setColor(fallback)
    let live = true
    sampleImageColor(item.imageUrl).then((c) => live && setColor(c ?? fallback))
    return () => {
      live = false
    }
  }, [item?.id, item?.imageUrl, fallback])
  return now ?? color
}

/* ---------- stars ---------- */

export function Stars({
  value,
  onChange,
  size = "small",
  label = "Rating"
}: {
  value: number | null
  onChange: (v: number | null) => void
  size?: "small" | "big"
  label?: string
}) {
  const [hover, setHover] = useState<number | null>(null)
  const shown = hover ?? value ?? 0
  return (
    <div className={`stars ${size}`} role="radiogroup" aria-label={label} onPointerLeave={() => setHover(null)}>
      {[1, 2, 3, 4, 5].map((n) => (
        <motion.button
          key={n}
          type="button"
          role="radio"
          aria-checked={value === n}
          aria-label={`${n} star${n > 1 ? "s" : ""}`}
          className={`star ${n <= shown ? "on" : ""}`}
          onPointerEnter={(e) => e.pointerType === "mouse" && setHover(n)}
          onClick={() => {
            vibrate(8)
            onChange(value === n ? null : n)
          }}
          animate={n <= (value ?? 0) ? { scale: [1, 1.35, 1] } : { scale: 1 }}
          transition={{
            duration: 0.35,
            delay: n <= (value ?? 0) ? n * 0.04 : 0
          }}
          whileTap={{ scale: 0.85 }}
        >
          <Icon.Star on={n <= shown} />
        </motion.button>
      ))}
    </div>
  )
}

/* ---------- sheet ---------- */

/**
 * Dragging down anywhere on a sheet scrolled to its top pulls it down, and far or fast enough closes it. Touch uses
 * touch events because a pointer drag is cancelled once the browser claims the gesture for scrolling.
 */
function pullToClose(el: HTMLElement, y: MotionValue<number>, onClose: () => void) {
  let from: { x: number; y: number } | null = null
  let dragging = false
  let dragged = false
  let last = { y: 0, t: 0 }
  let speed = 0
  const begin = (px: number, py: number) => {
    from = el.scrollTop <= 0 ? { x: px, y: py } : null
    dragging = false
    dragged = false
    last = { y: py, t: performance.now() }
    speed = 0
  }
  const move = (px: number, py: number, threshold: number) => {
    if (!from) return false
    const dy = py - from.y
    if (!dragging) {
      if (Math.abs(dy) <= threshold && Math.abs(px - from.x) <= threshold) return false
      if (dy <= 0 || Math.abs(px - from.x) > dy) {
        from = null
        return false
      }
      dragging = true
    }
    const now = performance.now()
    speed = (py - last.y) / Math.max(1, now - last.t)
    last = { y: py, t: now }
    y.set(Math.max(0, dy))
    return true
  }
  const end = () => {
    if (dragging) {
      dragged = true
      if (y.get() > 110 || speed > 0.5) onClose()
      else animate(y, 0, { type: "spring", stiffness: 500, damping: 40 })
    }
    from = null
    dragging = false
  }
  const onTouchStart = (e: TouchEvent) => e.touches.length === 1 && begin(e.touches[0]!.clientX, e.touches[0]!.clientY)
  const onTouchMove = (e: TouchEvent) => {
    const t = e.touches[0]
    if (t && move(t.clientX, t.clientY, 3) && e.cancelable) e.preventDefault()
  }
  const onPointerDown = (e: PointerEvent) => e.pointerType === "mouse" && e.button === 0 && begin(e.clientX, e.clientY)
  const onPointerMove = (e: PointerEvent) => e.pointerType === "mouse" && move(e.clientX, e.clientY, 4)
  const onPointerUp = (e: PointerEvent) => e.pointerType === "mouse" && end()
  const onClick = (e: MouseEvent) => {
    if (!dragged) return
    dragged = false
    e.stopPropagation()
    e.preventDefault()
  }
  el.addEventListener("touchstart", onTouchStart, { passive: true })
  el.addEventListener("touchmove", onTouchMove, { passive: false })
  el.addEventListener("touchend", end)
  el.addEventListener("touchcancel", end)
  el.addEventListener("pointerdown", onPointerDown)
  window.addEventListener("pointermove", onPointerMove)
  window.addEventListener("pointerup", onPointerUp)
  el.addEventListener("click", onClick, true)
  return () => {
    el.removeEventListener("touchstart", onTouchStart)
    el.removeEventListener("touchmove", onTouchMove)
    el.removeEventListener("touchend", end)
    el.removeEventListener("touchcancel", end)
    el.removeEventListener("pointerdown", onPointerDown)
    window.removeEventListener("pointermove", onPointerMove)
    window.removeEventListener("pointerup", onPointerUp)
    el.removeEventListener("click", onClick, true)
  }
}

export function Sheet({
  open,
  onClose,
  children,
  className = "",
  label,
  hero
}: {
  open: boolean
  onClose: () => void
  children: ReactNode
  className?: string
  label: string
  hero?: (grip: ReactNode) => ReactNode
}) {
  const y = useMotionValue(0)
  const ref = useRef<HTMLDivElement>(null)
  const close = useRef(onClose)
  close.current = onClose
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose()
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [open, onClose])
  useEffect(() => {
    const el = ref.current
    if (!open || !el) return
    return pullToClose(el, y, () => close.current())
  }, [open, y])
  const grip = <div className="sheet-grip" aria-hidden="true" />
  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            key="backdrop"
            className="sheet-backdrop"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
          />
          <motion.div
            key="sheet"
            ref={ref}
            role="dialog"
            aria-modal="true"
            aria-label={label}
            className={`sheet ${className}`}
            style={{ y }}
            initial={{ y: window.innerHeight }}
            animate={{ y: 0 }}
            exit={{ y: window.innerHeight }}
            transition={{ type: "spring", stiffness: 380, damping: 38 }}
          >
            {hero ? hero(grip) : grip}
            {children}
          </motion.div>
        </>
      )}
    </AnimatePresence>
  )
}

/* ---------- segmented control ---------- */

export function Seg<T extends string>({
  options,
  value,
  onChange,
  id,
  className = "",
  colorOf
}: {
  options: ReadonlyArray<{ value: T; label: string }>
  value: T | null
  onChange: (v: T) => void
  id: string
  className?: string
  colorOf?: (v: T) => string
}) {
  return (
    <div className={`seg ${className}`}>
      {options.map((o) => (
        <button key={o.value} type="button" aria-pressed={value === o.value} onClick={() => onChange(o.value)}>
          {value === o.value && (
            <motion.span
              layoutId={`seg-${id}`}
              className="seg-thumb"
              style={colorOf ? { background: colorOf(o.value) } : {}}
              transition={{ type: "spring", stiffness: 500, damping: 38 }}
            />
          )}
          {o.label}
        </button>
      ))}
    </div>
  )
}

export function Toast({
  text,
  action,
  onAction
}: {
  text: string | null
  action?: string | undefined
  onAction?: (() => void) | undefined
}) {
  return (
    <AnimatePresence>
      {text && (
        <motion.div
          key={text}
          className="toast"
          role="status"
          initial={{ opacity: 0, y: 16, x: "-50%", scale: 0.96 }}
          animate={{ opacity: 1, y: 0, x: "-50%", scale: 1 }}
          exit={{ opacity: 0, y: 10, x: "-50%", scale: 0.98 }}
          transition={{ type: "spring", stiffness: 500, damping: 34 }}
        >
          <span>{text}</span>
          {action && onAction && (
            <button type="button" onClick={onAction}>
              <Icon.Undo />
              {action}
            </button>
          )}
        </motion.div>
      )}
    </AnimatePresence>
  )
}
