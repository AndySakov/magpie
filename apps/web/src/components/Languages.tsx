const CODES = [
  "en", "fr", "es", "pt", "de", "it", "ja", "ko", "zh", "cn", "hi", "ta", "te", "ml", "kn", "bn", "ur", "ar", "fa", "he",
  "tr", "ru", "uk", "pl", "nl", "sv", "da", "no", "fi", "el", "ro", "hu", "cs", "id", "ms", "th", "vi", "tl", "yo", "ig",
  "ha", "sw"
] as const

const displayNames = (() => {
  try {
    return new Intl.DisplayNames(["en"], { type: "language" })
  } catch {
    return null
  }
})()

export const languageName = (code: string) => (code === "cn" ? "Cantonese" : displayNames?.of(code) ?? code)

const OPTIONS = [...CODES].sort((a, b) => languageName(a).localeCompare(languageName(b)))

export const browserLanguages = (): ReadonlyArray<string> => {
  const seen: Array<string> = []
  for (const tag of navigator.languages ?? [navigator.language]) {
    const code = tag.split("-")[0]!.toLowerCase()
    if ((CODES as ReadonlyArray<string>).includes(code) && !seen.includes(code)) seen.push(code)
  }
  return seen.slice(0, 2)
}

export function LanguagePicker({
  value,
  onChange,
  allowAny = false
}: {
  value: ReadonlyArray<string>
  onChange: (v: ReadonlyArray<string>) => void
  allowAny?: boolean
}) {
  const [first = "", second = ""] = value
  const setFirst = (code: string) => onChange(code === "" ? [] : second && second !== code ? [code, second] : [code])
  const setSecond = (code: string) => onChange(code === "" ? [first] : [first, code])
  return (
    <div className="lang-picker">
      <label className="lang-field">
        <span className="field-label">Main language</span>
        <select className="input select" value={first} onChange={(e) => setFirst(e.target.value)}>
          {allowAny && <option value="">Any language</option>}
          {OPTIONS.map((c) => (
            <option key={c} value={c}>
              {languageName(c)}
            </option>
          ))}
        </select>
      </label>
      <label className="lang-field">
        <span className="field-label">Second language</span>
        <select className="input select" value={second} disabled={first === ""} onChange={(e) => setSecond(e.target.value)}>
          <option value="">None</option>
          {OPTIONS.filter((c) => c !== first).map((c) => (
            <option key={c} value={c}>
              {languageName(c)}
            </option>
          ))}
        </select>
      </label>
    </div>
  )
}
