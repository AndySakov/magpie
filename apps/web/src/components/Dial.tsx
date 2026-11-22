import { motion } from "motion/react"
import { useRef, useState, type KeyboardEvent, type PointerEvent } from "react"
import { vibrate } from "../ui"

const describe = (v: number) =>
  v < 0.15
    ? "Comfort picks"
    : v < 0.38
      ? "Mostly familiar"
      : v < 0.62
        ? "A bit of both"
        : v < 0.85
          ? "Adventurous"
          : "Surprise me"

const clamp = (v: number) => Math.min(1, Math.max(0, Math.round(v * 100) / 100))

/** 0 = more of what I love, 1 = surprise me. `onCommit` fires once per gesture. */
export function Dial({ value, onCommit }: { value: number; onCommit: (v: number) => void }) {
  const track = useRef<HTMLDivElement>(null)
  const [live, setLive] = useState<number | null>(null)
  const shown = live ?? value
  const bucket = useRef(describe(value))

  const update = (v: number) => {
    const next = clamp(v)
    const label = describe(next)
    if (label !== bucket.current) {
      bucket.current = label
      vibrate(5)
    }
    setLive(next)
    return next
  }

  const fromPointer = (e: PointerEvent) => {
    const rect = track.current!.getBoundingClientRect()
    return update((e.clientX - rect.left) / rect.width)
  }

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId)
    fromPointer(e)
  }
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) fromPointer(e)
  }
  const onPointerUp = (e: PointerEvent<HTMLDivElement>) => {
    if (!e.currentTarget.hasPointerCapture(e.pointerId)) return
    const v = fromPointer(e)
    setLive(null)
    if (v !== value) onCommit(v)
  }

  const onKeyDown = (e: KeyboardEvent) => {
    const step = e.shiftKey ? 0.25 : 0.05
    const keys: Record<string, number> = {
      ArrowLeft: value - step,
      ArrowDown: value - step,
      ArrowRight: value + step,
      ArrowUp: value + step,
      Home: 0,
      End: 1
    }
    const target = keys[e.key]
    if (target === undefined) return
    e.preventDefault()
    const v = clamp(target)
    bucket.current = describe(v)
    if (v !== value) onCommit(v)
  }

  return (
    <div className="dial">
      <div className="dial-head">
        <span id="dial-label">Discovery dial</span>
        <motion.span key={describe(shown)} className="dial-value" initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }}>
          {describe(shown)}
        </motion.span>
      </div>
      <div
        ref={track}
        className="dial-track"
        role="slider"
        tabIndex={0}
        aria-labelledby="dial-label"
        aria-valuemin={0}
        aria-valuemax={1}
        aria-valuenow={shown}
        aria-valuetext={describe(shown)}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => setLive(null)}
        onKeyDown={onKeyDown}
      >
        <div className="dial-rail" />
        <div className="dial-ticks" aria-hidden="true">
          {[0, 1, 2, 3, 4].map((i) => (
            <i key={i} />
          ))}
        </div>
        <motion.div
          className="dial-thumb"
          animate={{ left: `${shown * 100}%`, scale: live === null ? 1 : 1.18 }}
          transition={live === null ? { type: "spring", stiffness: 400, damping: 30 } : { duration: 0 }}
        />
      </div>
      <div className="dial-ends" aria-hidden="true">
        <span>More of what I love</span>
        <span>Surprise me</span>
      </div>
    </div>
  )
}
