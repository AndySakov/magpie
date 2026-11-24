export const hueOf = (text: string): number => {
  let h = 2166136261
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return Math.abs(h) % 360
}

const cache = new Map<string, Promise<string | null>>()

/** Most vivid average colour of a poster, or null when the image can't be read (CORS, 404). */
export const sampleImageColor = (url: string): Promise<string | null> => {
  const hit = cache.get(url)
  if (hit) return hit
  const p = new Promise<string | null>((resolve) => {
    const img = new Image()
    img.crossOrigin = "anonymous"
    img.decoding = "async"
    img.onerror = () => resolve(null)
    img.onload = () => {
      try {
        const size = 24
        const canvas = document.createElement("canvas")
        canvas.width = size
        canvas.height = size
        const ctx = canvas.getContext("2d", { willReadFrequently: true })
        if (!ctx) return resolve(null)
        ctx.drawImage(img, 0, 0, size, size)
        const { data } = ctx.getImageData(0, 0, size, size)
        let r = 0
        let g = 0
        let b = 0
        let weight = 0
        for (let i = 0; i < data.length; i += 4) {
          const pr = data[i]!
          const pg = data[i + 1]!
          const pb = data[i + 2]!
          const max = Math.max(pr, pg, pb)
          const min = Math.min(pr, pg, pb)
          const sat = max === 0 ? 0 : (max - min) / max
          const lum = (max + min) / 510
          const w = 0.08 + sat * sat * (1 - Math.abs(lum - 0.5) * 1.6)
          r += pr * w
          g += pg * w
          b += pb * w
          weight += w
        }
        resolve(boost(r / weight, g / weight, b / weight))
      } catch {
        resolve(null)
      }
    }
    img.src = url
  })
  cache.set(url, p)
  return p
}

const boost = (r: number, g: number, b: number): string => {
  const max = Math.max(r, g, b) / 255
  const min = Math.min(r, g, b) / 255
  const l = (max + min) / 2
  const d = max - min
  let h = 0
  if (d !== 0) {
    if (max === r / 255) h = ((g - b) / 255 / d) % 6
    else if (max === g / 255) h = (b - r) / 255 / d + 2
    else h = (r - g) / 255 / d + 4
  }
  h = Math.round((h * 60 + 360) % 360)
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1))
  const sat = Math.round(Math.min(85, Math.max(50, s * 100 * 1.5)))
  const light = Math.round(Math.min(62, Math.max(46, l * 100)))
  return `hsl(${h}, ${sat}%, ${light}%)`
}
