import type { ImportSource } from "@magpie/contract"
import { unzipSync } from "fflate"

export type ExportFile =
  | { readonly tag: "ok"; readonly source: ImportSource; readonly name: string; readonly content: string }
  | { readonly tag: "unknown"; readonly name: string; readonly message: string }

const LETTERBOXD_FILES = ["watchlist.csv", "watched.csv", "ratings.csv"]

export const detectSource = (text: string): ImportSource | null => {
  if (/<myanimelist[\s>]/i.test(text.slice(0, 2000))) return "mal"
  const header = text.slice(0, text.indexOf("\n") === -1 ? undefined : text.indexOf("\n"))
  if (header.includes("Letterboxd URI")) return "letterboxd"
  if (header.includes("Const") && header.includes("Your Rating")) return "imdb"
  if (header.includes("Book Id") && header.includes("Exclusive Shelf")) return "goodreads"
  return null
}

const unknown = (name: string): ExportFile => ({
  tag: "unknown",
  name,
  message: "Magpie doesn't recognise this file. It takes Letterboxd, IMDb, Goodreads and MyAnimeList exports."
})

const fromText = (name: string, content: string): ExportFile => {
  const source = detectSource(content)
  return source ? { tag: "ok", source, name, content } : unknown(name)
}

const gunzip = async (file: File) =>
  new Response(file.stream().pipeThrough(new DecompressionStream("gzip"))).text()

export const readExports = async (files: ReadonlyArray<File>): Promise<ReadonlyArray<ExportFile>> => {
  const out: Array<ExportFile> = []
  for (const file of files) {
    const name = file.name
    try {
      if (/\.zip$/i.test(name)) {
        const entries = unzipSync(new Uint8Array(await file.arrayBuffer()), {
          filter: (f) => LETTERBOXD_FILES.includes(f.name.toLowerCase())
        })
        const picked = LETTERBOXD_FILES.flatMap((wanted) =>
          Object.entries(entries).filter(([entry]) => entry.toLowerCase() === wanted)
        )
        if (picked.length === 0) out.push(unknown(name))
        for (const [entry, bytes] of picked) out.push(fromText(entry, new TextDecoder().decode(bytes)))
      } else if (/\.gz$/i.test(name)) {
        out.push(fromText(name.replace(/\.gz$/i, ""), await gunzip(file)))
      } else {
        out.push(fromText(name, await file.text()))
      }
    } catch {
      out.push({ tag: "unknown", name, message: "Magpie couldn't open this file. Try exporting it again." })
    }
  }
  return out
}
