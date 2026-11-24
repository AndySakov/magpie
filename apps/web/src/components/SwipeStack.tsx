import type { Recommendation } from "@magpie/contract"
import {
  animate,
  motion,
  useMotionValue,
  useReducedMotion,
  useTransform,
  type MotionValue,
  type PanInfo
} from "motion/react"
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react"
import { OnServices, WhereToWatch } from "./WhereToWatch"
import { Art, Icon, Sheet, Stars, TypeCard, hasArt, metaLine, vibrate } from "../ui"

export type Dir = "left" | "right" | "up"
export type Decision = { kind: "interested" } | { kind: "not_interested" } | { kind: "seen"; rating: number }

const SWIPE_DISTANCE = 110
const SWIPE_VELOCITY = 650

export function SwipeStack({
  cards,
  loading,
  empty,
  onDecide,
  active,
  returning,
  between,
  undoable = false
}: {
  cards: ReadonlyArray<Recommendation>
  loading: boolean
  empty: ReactNode
  onDecide: (rec: Recommendation, decision: Decision, dir: Dir) => void
  active: boolean
  returning: { id: number; dir: Dir } | null
  between?: ReactNode
  undoable?: boolean
}) {
  const x = useMotionValue(0)
  const fly = useRef<((dir: Dir) => void) | null>(null)
  const seenRating = useRef<number>(0)
  const [detail, setDetail] = useState<Recommendation | null>(null)
  const [rating, setRating] = useState<Recommendation | null>(null)
  const top = cards[0]

  const onFly = useCallback(
    (rec: Recommendation, dir: Dir) => {
      const decision: Decision =
        dir === "right"
          ? { kind: "interested" }
          : dir === "left"
            ? { kind: "not_interested" }
            : { kind: "seen", rating: seenRating.current }
      onDecide(rec, decision, dir)
    },
    [onDecide]
  )

  const swipe = useCallback((dir: Exclude<Dir, "up">) => fly.current?.(dir), [])
  const openRating = useCallback(() => top && setRating(top), [top])

  useEffect(() => {
    if (!active || detail || rating) return
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.getAttribute("role") === "slider")) return
      if (e.metaKey || e.ctrlKey || e.altKey) return
      if (e.key === "ArrowRight") swipe("right")
      else if (e.key === "ArrowLeft") swipe("left")
      else if (e.key === "ArrowDown" || e.key === "s") openRating()
      else return
      e.preventDefault()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [active, detail, rating, swipe, openRating])

  const rate = (value: number) => {
    seenRating.current = value
    setRating(null)
    setTimeout(() => fly.current?.("up"), 180)
  }

  const decideFromDetail = (dir: Dir | "rate") => {
    setDetail(null)
    if (dir === "rate") setTimeout(openRating, 320)
    else setTimeout(() => fly.current?.(dir), 320)
  }

  return (
    <>
      <div className="stack">
        {cards.length === 0 && loading && (
          <div className="skeleton" aria-label="Loading picks">
            <i />
            <i style={{ width: "45%" }} />
            <i style={{ width: "80%" }} />
          </div>
        )}
        {cards.length === 0 && !loading && empty}
        {cards[2] && <BackCard key={cards[2].item.id} rec={cards[2]} x={x} depth={2} />}
        {cards[1] && <BackCard key={cards[1].item.id} rec={cards[1]} x={x} depth={1} />}
        {top && (
          <TopCard
            key={top.item.id}
            rec={top}
            x={x}
            register={(f) => (fly.current = f)}
            onFly={(dir) => onFly(top, dir)}
            onOpen={() => setDetail(top)}
            enterFrom={returning?.id === top.item.id ? returning.dir : null}
            artHidden={detail?.item.id === top.item.id}
          />
        )}
      </div>
      {between}
      <div className="deck-actions">
        <motion.button
          type="button"
          className="round-btn nope"
          aria-label="Not interested"
          onClick={() => swipe("left")}
          disabled={!top}
          whileTap={{ scale: 0.88 }}
        >
          <Icon.Nope />
        </motion.button>
        <motion.button type="button" className="seen-btn" onClick={openRating} disabled={!top} whileTap={{ scale: 0.94 }}>
          <Icon.Eye />
          Seen it
        </motion.button>
        <motion.button
          type="button"
          className="round-btn want"
          aria-label="Want it"
          onClick={() => swipe("right")}
          disabled={!top}
          whileTap={{ scale: 0.88 }}
        >
          <Icon.Want />
        </motion.button>
      </div>
      <p className="kbd-hint">Arrow keys to swipe, down arrow for Seen it{undoable ? ", Ctrl+Z to undo" : ""}</p>

      <DetailSheet rec={detail} onClose={() => setDetail(null)} onDecide={decideFromDetail} />
      <RatingSheet rec={rating} onClose={() => setRating(null)} onRate={rate} />
    </>
  )
}

function BackCard({ rec, x, depth }: { rec: Recommendation; x: MotionValue<number>; depth: 1 | 2 }) {
  const near = depth === 1
  const scale = useTransform(x, [-220, 0, 220], near ? [1, 0.94, 1] : [0.94, 0.88, 0.94])
  const y = useTransform(x, [-220, 0, 220], near ? [0, 16, 0] : [16, 30, 16])
  const brightness = useTransform(x, [-220, 0, 220], near ? [1, 0.7, 1] : [0.7, 0.5, 0.7])
  const filter = useTransform(brightness, (b) => `brightness(${b})`)
  return (
    <motion.div
      className={`card ${hasArt(rec.item) ? "" : "has-type"}`}
      style={{ scale, y, filter, zIndex: 3 - depth, cursor: "default" }}
      aria-hidden="true"
    >
      <div className="card-art">
        <Art item={rec.item} eager={near} />
      </div>
    </motion.div>
  )
}

function TopCard({
  rec,
  x,
  register,
  onFly,
  onOpen,
  enterFrom,
  artHidden
}: {
  rec: Recommendation
  x: MotionValue<number>
  register: (fly: ((dir: Dir) => void) | null) => void
  onFly: (dir: Dir) => void
  onOpen: () => void
  enterFrom: Dir | null
  artHidden: boolean
}) {
  const reduced = useReducedMotion()
  const y = useMotionValue(0)
  const rotate = useTransform(x, [-300, 0, 300], reduced ? [0, 0, 0] : [-14, 0, 14])
  const wantOpacity = useTransform(x, [24, SWIPE_DISTANCE], [0, 1])
  const nopeOpacity = useTransform(x, [-SWIPE_DISTANCE, -24], [1, 0])
  const seenOpacity = useTransform(y, [-160, -20], [1, 0])
  const sheenX = useTransform(x, [-320, 320], ["-40%", "40%"])
  const sheenOpacity = useTransform(x, (v) => Math.min(Math.abs(v) / 180, 1) * 0.8)
  const armed = useRef(false)
  const flying = useRef(false)
  const item = rec.item

  useLayoutEffect(() => {
    y.set(0)
    if (!enterFrom) {
      x.set(0)
      return
    }
    const w = window.innerWidth
    if (enterFrom === "up") {
      x.set(0)
      y.set(-window.innerHeight * 0.8)
    } else x.set(enterFrom === "right" ? w : -w)
    const spring = { type: "spring", stiffness: 260, damping: 26 } as const
    animate(x, 0, spring)
    animate(y, 0, spring)
  }, [])

  const fly = useCallback(
    async (dir: Dir) => {
      if (flying.current) return
      flying.current = true
      vibrate(14)
      const duration = reduced ? 0.12 : 0.34
      if (dir === "up") await animate(y, -window.innerHeight, { duration, ease: [0.5, 0, 0.75, 0] })
      else await animate(x, (dir === "right" ? 1 : -1) * (window.innerWidth + 240), { duration, ease: [0.4, 0, 0.9, 0.6] })
      onFly(dir)
    },
    [onFly, reduced, x, y]
  )

  useEffect(() => {
    register(fly)
    return () => register(null)
  }, [fly, register])

  const onDrag = (_: unknown, info: PanInfo) => {
    const past = Math.abs(info.offset.x) > SWIPE_DISTANCE
    if (past !== armed.current) {
      armed.current = past
      if (past) vibrate(6)
    }
  }

  const onDragEnd = (_: unknown, info: PanInfo) => {
    const { offset, velocity } = info
    if (offset.x > SWIPE_DISTANCE || velocity.x > SWIPE_VELOCITY) return void fly("right")
    if (offset.x < -SWIPE_DISTANCE || velocity.x < -SWIPE_VELOCITY) return void fly("left")
    const spring = { type: "spring", stiffness: 520, damping: 30 } as const
    animate(x, 0, spring)
    animate(y, 0, spring)
  }

  return (
    <motion.div
      className={`card ${hasArt(item) ? "" : "has-type"}`}
      style={{ x, y, rotate, zIndex: 5 }}
      drag
      dragMomentum={false}
      dragElastic={1}
      onDrag={onDrag}
      onDragEnd={onDragEnd}
      onTap={() => !flying.current && Math.abs(x.get()) < 8 && onOpen()}
      tabIndex={0}
      role="group"
      aria-roledescription="card"
      aria-label={`${item.title}. ${metaLine(item)}. ${rec.reasons.join(". ")}. Press Enter for details.`}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault()
          onOpen()
        }
      }}
    >
      {!artHidden && (
        <motion.div className="card-art" layoutId={`art-${item.id}`}>
          <Art item={item} eager />
        </motion.div>
      )}
      <motion.div className="sheen" style={{ x: sheenX, opacity: sheenOpacity }} />
      <div className="card-scrim" />
      <div className="card-foot">
        <h2 className="card-title">{item.title}</h2>
        <p className="card-meta">{metaLine(item)}</p>
        <Reasons reasons={rec.reasons} />
        <OnServices providers={rec.availableOn} />
      </div>
      <motion.div className="stamp want" style={{ opacity: wantOpacity }}>
        WANT
      </motion.div>
      <motion.div className="stamp nope" style={{ opacity: nopeOpacity }}>
        NOPE
      </motion.div>
      <motion.div className="stamp seen" style={{ opacity: seenOpacity }}>
        SEEN
      </motion.div>
    </motion.div>
  )
}

function Reasons({ reasons }: { reasons: ReadonlyArray<string> }) {
  if (reasons.length === 0) return null
  return (
    <div className="reasons">
      {reasons.slice(0, 2).map((r) => (
        <p key={r} className="reason">
          <Icon.Spark />
          {r}
        </p>
      ))}
    </div>
  )
}

function Trailer({ videoId, title }: { videoId: string; title: string }) {
  const [playing, setPlaying] = useState(false)
  return (
    <div className="trailer">
      {playing ? (
        <iframe
          src={`https://www.youtube-nocookie.com/embed/${videoId}?autoplay=1&playsinline=1&rel=0`}
          title={`${title} trailer`}
          allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
          allowFullScreen
        />
      ) : (
        <button type="button" onClick={() => setPlaying(true)} aria-label={`Play ${title} trailer`}>
          <img src={`https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`} alt="" loading="lazy" />
          <span className="trailer-play">Play trailer</span>
        </button>
      )}
    </div>
  )
}

function DetailSheet({
  rec,
  onClose,
  onDecide
}: {
  rec: Recommendation | null
  onClose: () => void
  onDecide: (dir: Dir | "rate") => void
}) {
  const item = rec?.item
  return (
    <Sheet
      open={rec !== null}
      onClose={onClose}
      label={item ? `${item.title} details` : "Details"}
      hero={(grip) =>
        item && (
          <div className={`detail-hero ${item.backdropUrl ? "wide" : ""}`}>
            {grip}
            <motion.div className="card-art" layoutId={`art-${item.id}`}>
              {hasArt(item) || item.backdropUrl ? <Art item={item} src={item.backdropUrl} eager /> : <TypeCard item={item} />}
            </motion.div>
          </div>
        )
      }
    >
      {item && rec && (
        <div className="detail-body">
          <div>
            <h2 className="detail-title">{item.title}</h2>
            <p className="detail-meta">{metaLine(item)}</p>
            <Reasons reasons={rec.reasons} />
          </div>
          {item.synopsis && <p className="synopsis">{item.synopsis}</p>}
          {item.trailerYoutubeId && <Trailer key={item.id} videoId={item.trailerYoutubeId} title={item.title} />}
          <WhereToWatch item={item} />
          {item.genres.length > 0 && (
            <div>
              <h3>Genres</h3>
              <div className="chips">
                {item.genres.map((g) => (
                  <span key={g} className="chip">
                    {g}
                  </span>
                ))}
              </div>
            </div>
          )}
          {item.creators.length > 0 && (
            <div>
              <h3>{item.category === "book" ? "Written by" : "Made by"}</h3>
              <p>{item.creators.join(", ")}</p>
            </div>
          )}
          <div className="deck-actions">
            <button type="button" className="round-btn nope" aria-label="Not interested" onClick={() => onDecide("left")}>
              <Icon.Nope />
            </button>
            <button type="button" className="seen-btn" onClick={() => onDecide("rate")}>
              <Icon.Eye />
              Seen it
            </button>
            <button type="button" className="round-btn want" aria-label="Want it" onClick={() => onDecide("right")}>
              <Icon.Want />
            </button>
          </div>
        </div>
      )}
    </Sheet>
  )
}

function RatingSheet({
  rec,
  onClose,
  onRate
}: {
  rec: Recommendation | null
  onClose: () => void
  onRate: (rating: number) => void
}) {
  const [stars, setStars] = useState<number | null>(null)
  useEffect(() => setStars(null), [rec?.item.id])
  const pickStars = (v: number | null) => {
    setStars(v)
    if (v !== null) setTimeout(() => onRate(v), 380)
  }
  return (
    <Sheet open={rec !== null} onClose={onClose} label="Rate what you've seen" className="patch">
      {rec && (
        <>
          <h2 className="rate-title">How was {rec.item.title}?</h2>
          <p className="rate-sub">A quick thumb is enough. Stars if you want to be precise.</p>
          <div className="thumbs">
            <motion.button type="button" className="thumb-btn" onClick={() => onRate(2)} whileTap={{ scale: 0.94 }}>
              <Icon.ThumbDown />
              Not for me
            </motion.button>
            <motion.button type="button" className="thumb-btn" onClick={() => onRate(4)} whileTap={{ scale: 0.94 }}>
              <Icon.ThumbUp />
              Liked it
            </motion.button>
          </div>
          <div className="or-rule">or give it stars</div>
          <Stars value={stars} onChange={pickStars} size="big" label="Star rating" />
        </>
      )}
    </Sheet>
  )
}
