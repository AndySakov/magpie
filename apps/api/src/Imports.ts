import {
  type Category,
  ImportFailed,
  ImportResult,
  type ImportSource,
  type ItemId,
  type Status,
  UnmatchedRow,
  type UserId,
  type UserNotFound
} from "@magpie/contract"
import { Context, Effect, Layer, Schema } from "effect"
import { SqlClient } from "effect/sql"
import { ITEM_COLUMNS, type ItemRow, toItem } from "./Items.ts"
import { type Entry, Library } from "./Library.ts"

export const parseCsv = (text: string): Array<Record<string, string>> => {
  const rows: Array<Array<string>> = []
  let row: Array<string> = []
  let field = ""
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!
    if (quoted) {
      if (ch === "\"" && text[i + 1] === "\"") { field += "\""; i++ }
      else if (ch === "\"") quoted = false
      else field += ch
    } else if (ch === "\"") quoted = true
    else if (ch === ",") { row.push(field); field = "" }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++
      row.push(field); field = ""
      if (row.some((f) => f.length > 0)) rows.push(row)
      row = []
    } else field += ch
  }
  row.push(field)
  if (row.some((f) => f.length > 0)) rows.push(row)
  const [header, ...body] = rows
  if (!header) return []
  const keys = header.map((h) => h.trim().replace(/^﻿/, ""))
  return body.map((r) => Object.fromEntries(keys.map((k, i) => [k, (r[i] ?? "").trim()])))
}

export interface ImportRow {
  readonly key: string
  readonly category: Category
  readonly title: string
  readonly year: number | null
  readonly author?: string
  // Exact external ID when the source has one.
  readonly ref?: { readonly source: string; readonly id: string }
  readonly rating: number | null
  readonly status: Status | null
  readonly progress?: number | null
  readonly at: Date | null
}

const num = (s: string | undefined) => (s && s.length && !Number.isNaN(Number(s)) ? Number(s) : null)
const date = (s: string | undefined) => {
  if (!s) return null
  const d = new Date(s.replaceAll("/", "-"))
  return Number.isNaN(d.getTime()) ? null : d
}
const stars = (value: number | null, scale: number) =>
  value === null || value <= 0 ? null : Math.round((value / scale) * 5 * 2) / 2

export const parseLetterboxd = (text: string, filename = ""): Array<ImportRow> =>
  parseCsv(text).map((r) => {
    const watchlist = /watchlist/i.test(filename)
    return {
      key: r["Letterboxd URI"] || `${r["Name"]}:${r["Year"]}`,
      category: "movie",
      title: r["Name"] ?? "",
      year: num(r["Year"]),
      rating: num(r["Rating"]),
      status: watchlist ? "want" : "finished",
      at: date(r["Watched Date"] || r["Date"])
    }
  })

export const parseImdb = (text: string): Array<ImportRow> =>
  parseCsv(text).map((r) => ({
    key: r["Const"] ?? "",
    category: /tv ?(mini ?)?series/i.test(r["Title Type"] ?? "") ? "tv" : "movie",
    title: r["Title"] ?? "",
    year: num(r["Year"]),
    ref: { source: "imdb", id: r["Const"] ?? "" },
    rating: stars(num(r["Your Rating"]), 10),
    status: "finished",
    at: date(r["Date Rated"])
  }))

export const parseGoodreads = (text: string): Array<ImportRow> =>
  parseCsv(text).map((r) => {
    const shelf = r["Exclusive Shelf"] ?? "read"
    return {
      key: r["Book Id"] ?? `${r["Title"]}`,
      category: "book",
      title: (r["Title"] ?? "").replace(/\s*\([^)]*#\d+[^)]*\)\s*$/, ""),
      year: num(r["Original Publication Year"]) ?? num(r["Year Published"]),
      author: r["Author"] ?? "",
      rating: stars(num(r["My Rating"]), 5),
      status: shelf === "to-read" ? "want" : shelf === "currently-reading" ? "in_progress" : "finished",
      at: date(r["Date Read"] || r["Date Added"])
    }
  })

const MAL_STATUS: Record<string, Status> = {
  "Completed": "finished", "Watching": "in_progress", "Plan to Watch": "want", "Dropped": "dropped", "On-Hold": "in_progress"
}

export const parseMal = (xml: string): Array<ImportRow> =>
  [...xml.matchAll(/<anime>([\s\S]*?)<\/anime>/g)].map(([, body]) => {
    const tag = (name: string) => body!.match(new RegExp(`<${name}>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?</${name}>`))?.[1]?.trim()
    const id = tag("series_animedb_id") ?? ""
    return {
      key: id,
      category: "anime",
      title: tag("series_title") ?? "",
      year: null,
      ref: { source: "mal", id },
      rating: stars(num(tag("my_score")), 10),
      status: MAL_STATUS[tag("my_status") ?? ""] ?? null,
      progress: num(tag("my_watched_episodes")),
      at: date(tag("my_finish_date"))
    }
  })

const AniListLists = Schema.Struct({
  data: Schema.Struct({
    MediaListCollection: Schema.NullOr(Schema.Struct({
      lists: Schema.Array(Schema.Struct({
        entries: Schema.Array(Schema.Struct({
          mediaId: Schema.Number,
          score: Schema.Number,
          status: Schema.String,
          progress: Schema.NullOr(Schema.Number),
          updatedAt: Schema.NullOr(Schema.Number),
          media: Schema.Struct({
            title: Schema.Struct({ english: Schema.NullOr(Schema.String), romaji: Schema.NullOr(Schema.String) }),
            seasonYear: Schema.NullOr(Schema.Number)
          })
        }))
      }))
    }))
  })
})

const ANILIST_STATUS: Record<string, Status> = {
  COMPLETED: "finished", CURRENT: "in_progress", PLANNING: "want", DROPPED: "dropped", PAUSED: "in_progress", REPEATING: "finished"
}

const fetchAniList = (username: string) =>
  Effect.tryPromise({
    try: () =>
      fetch("https://graphql.anilist.co", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({
          query: `query ($u: String) { MediaListCollection(userName: $u, type: ANIME) { lists { entries {
            mediaId score(format: POINT_10_DECIMAL) status progress updatedAt
            media { title { english romaji } seasonYear } } } } }`,
          variables: { u: username.trim() }
        })
      }).then((r) => r.json()),
    catch: () => new ImportFailed({ message: "Could not reach AniList" })
  }).pipe(
    Effect.flatMap((json) =>
      Schema.decodeUnknownEffect(AniListLists)(json).pipe(
        Effect.mapError(() => new ImportFailed({ message: `AniList user "${username}" not found or list is private` }))
      )
    ),
    Effect.map((res): Array<ImportRow> =>
      (res.data.MediaListCollection?.lists ?? []).flatMap((l) =>
        l.entries.map((e) => ({
          key: String(e.mediaId),
          category: "anime" as const,
          title: e.media.title.english ?? e.media.title.romaji ?? "",
          year: e.media.seasonYear,
          ref: { source: "anilist", id: String(e.mediaId) },
          rating: stars(e.score, 10),
          status: ANILIST_STATUS[e.status] ?? null,
          progress: e.progress,
          at: e.updatedAt ? new Date(e.updatedAt * 1000) : null
        }))
      )
    )
  )

export class Imports extends Context.Service<Imports, {
  run(userId: UserId, source: ImportSource, content: string, filename?: string): Effect.Effect<ImportResult, UserNotFound | ImportFailed>
  /** Matches already-parsed rows to the catalog and applies them to the user's library. */
  seed(userId: UserId, source: string, rows: ReadonlyArray<ImportRow>): Effect.Effect<ImportResult, UserNotFound>
}>()("magpie/Imports") {
  static readonly layer = Layer.effect(
    Imports,
    Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient
      const library = yield* Library

      const byRef = (rows: ReadonlyArray<ImportRow>) => {
        const refs = rows.flatMap((r) => (r.ref ? [{ source: r.ref.source, id: r.ref.id }] : []))
        if (refs.length === 0) return Effect.succeed(new Map<string, number>())
        return sql.unsafe<{ source: string; external_id: string; item_id: number }>(
          `SELECT e.source, e.external_id, e.item_id::int AS item_id
           FROM jsonb_to_recordset($1::jsonb) AS x(source text, id text)
           JOIN item_external_id e ON e.source = x.source AND e.external_id = x.id`,
          [JSON.stringify(refs)]
        ).pipe(Effect.map((found) => new Map(found.map((f) => [`${f.source}:${f.external_id}`, f.item_id]))), Effect.orDie)
      }

      // Title (+ year, + author) match. Returns the best item when it is unambiguous, plus candidates.
      const byTitle = Effect.fn(function*(row: ImportRow) {
        const candidates = yield* sql.unsafe<ItemRow & { score: number; author_hit: boolean }>(
          `SELECT ${ITEM_COLUMNS},
                  similarity(lower(unaccent(i.title)), lower(unaccent($1))) AS score,
                  ($4::text IS NOT NULL AND EXISTS (
                    SELECT 1 FROM item_creator ic JOIN creator c ON c.id = ic.creator_id
                    WHERE ic.item_id = i.id AND similarity(lower(c.name), lower($4)) > 0.5)) AS author_hit
           FROM item i
           WHERE i.category = $2::category AND lower(i.title) % lower($1)
           ORDER BY (lower(i.title) = lower($1)) DESC,
                    ($3::int IS NOT NULL AND abs(COALESCE(i.year, 0) - $3::int) <= 1) DESC,
                    similarity(lower(i.title), lower($1)) DESC, i.popularity DESC
           LIMIT 5`,
          [row.title, row.category, row.year, row.author ?? null]
        ).pipe(Effect.orDie)
        const top = candidates[0]
        const exactTitle = top && top.title.toLowerCase() === row.title.toLowerCase()
        const yearOk = top && (row.year === null || top.year === null || Math.abs(top.year - row.year) <= 1)
        const authorOk = row.category !== "book" || !row.author || top?.author_hit
        const match = top && exactTitle && yearOk && authorOk ? top.id : top && top.score > 0.85 && yearOk && authorOk ? top.id : null
        return { match, candidates }
      })

      const run = Effect.fn("Imports.run")(function*(userId: UserId, source: ImportSource, content: string, filename?: string) {
        const rows: Array<ImportRow> = source === "anilist"
          ? yield* fetchAniList(content)
          : yield* Effect.try({
            try: () =>
              source === "letterboxd" ? parseLetterboxd(content, filename)
              : source === "imdb" ? parseImdb(content)
              : source === "goodreads" ? parseGoodreads(content)
              : parseMal(content),
            catch: () => new ImportFailed({ message: `Could not parse the ${source} file` })
          })
        const usable = rows.filter((r) => r.title || r.ref)
        if (usable.length === 0) return yield* new ImportFailed({ message: `No entries found in the ${source} file` })
        return yield* seed(userId, source, usable)
      })

      const seed = Effect.fn("Imports.seed")(function*(userId: UserId, source: string, usable: ReadonlyArray<ImportRow>) {
        const refs = yield* byRef(usable)
        const entries: Array<Entry> = []
        const unmatched: Array<UnmatchedRow> = []
        for (const row of usable) {
          let itemId = row.ref ? refs.get(`${row.ref.source}:${row.ref.id}`) ?? null : null
          let candidates: ReadonlyArray<ItemRow> = []
          if (itemId === null && row.title) {
            const found = yield* byTitle(row)
            itemId = found.match
            candidates = found.candidates
          }
          if (itemId === null) {
            if (unmatched.length < 200) {
              unmatched.push(new UnmatchedRow({
                title: row.title,
                year: row.year,
                rating: row.rating,
                status: row.status,
                candidates: candidates.map((c) => toItem(c, false))
              }))
            }
            continue
          }
          entries.push({
            itemId: itemId as ItemId,
            change: {
              ...(row.status ? { status: row.status } : {}),
              ...(row.rating !== null ? { rating: row.rating } : {}),
              ...(row.progress != null ? { progress: row.progress } : {})
            },
            origin: { source, sourceEventId: `${source}:${row.key}`, ...(row.at ? { occurredAt: row.at } : {}) }
          })
        }
        const matched = yield* library.applyAll(userId, entries)
        return new ImportResult({ total: usable.length, matched, unmatched })
      })

      return Imports.of({ run, seed })
    })
  )
}
