import { Effect, Schema } from "effect"
import { existsSync, mkdirSync } from "node:fs"
import { readFile, writeFile } from "node:fs/promises"
import { BOOK_GENRES } from "../catalog.ts"
import { type CreatorRow, dataPath, type ItemRow, lines, linkCreators, sleep, upsertItems } from "./lib.ts"


const QUERY_SUBJECTS: Record<string, string> = {
  fantasy: "fantasy", "science fiction": "science_fiction", mystery: "mystery", thriller: "thriller", horror: "horror",
  romance: "romance", "historical fiction": "historical_fiction", "young adult": "young_adult_fiction",
  "graphic novels": "graphic_novels", biography: "biography", history: "history", philosophy: "philosophy",
  psychology: "psychology", "self-help": "self-help", business: "business", science: "science", poetry: "poetry",
  humor: "humor", "true crime": "true_crime", classics: "classics"
}

const Doc = Schema.Struct({
  key: Schema.String,
  title: Schema.String,
  author_name: Schema.optional(Schema.Array(Schema.String)),
  author_key: Schema.optional(Schema.Array(Schema.String)),
  first_publish_year: Schema.optional(Schema.Number),
  subject: Schema.optional(Schema.Array(Schema.String)),
  cover_i: Schema.optional(Schema.Number),
  ratings_average: Schema.optional(Schema.Number),
  ratings_count: Schema.optional(Schema.Number),
  readinglog_count: Schema.optional(Schema.Number),
  number_of_pages_median: Schema.optional(Schema.Number),
  language: Schema.optional(Schema.Array(Schema.String)),
  first_sentence: Schema.optional(Schema.Array(Schema.String))
})
type Doc = typeof Doc.Type
const Response = Schema.Struct({ docs: Schema.Array(Doc) })

const FIELDS = "key,title,author_name,author_key,first_publish_year,subject,cover_i,ratings_average,ratings_count,readinglog_count,number_of_pages_median,language,first_sentence"

const search = Effect.fn("olSearch")(function*(name: string, q: string, page: number) {
  const dir = yield* dataPath("ol_search")
  mkdirSync(dir, { recursive: true })
  const cache = `${dir}/${name}-${page}.json`
  if (existsSync(cache)) {
    return Schema.decodeUnknownSync(Response)(JSON.parse(yield* Effect.promise(() => readFile(cache, "utf8"))))
  }
  const url = `https://openlibrary.org/search.json?q=${encodeURIComponent(q)}&sort=readinglog&fields=${FIELDS}&limit=1000&page=${page}`
  const text = yield* Effect.tryPromise(() =>
    fetch(url, { headers: { "user-agent": "magpie-research/0.1" } }).then((r) => {
      if (!r.ok) throw new Error(`Open Library ${r.status}`)
      return r.text()
    })
  ).pipe(Effect.tapError(() => sleep(10_000)), Effect.retry({ times: 4 }))
  yield* Effect.promise(() => writeFile(cache, text))
  yield* sleep(1_100)
  return Schema.decodeUnknownSync(Response)(JSON.parse(text))
})

const ratingSpread = Effect.fn("ratingSpread")(function*() {
  const path = yield* dataPath("ol_ratings.txt.gz")
  const acc = new Map<string, { n: number; sum: number; sq: number }>()
  yield* Effect.promise(async () => {
    for await (const l of lines(path)) {
      const [work, , rating] = l.split("\t")
      if (!work || !rating) continue
      const r = Number(rating)
      const s = acc.get(work) ?? { n: 0, sum: 0, sq: 0 }
      s.n++; s.sum += r; s.sq += r * r
      acc.set(work, s)
    }
  })
  const out = new Map<string, number>()
  for (const [work, s] of acc) if (s.n >= 10) out.set(work, Math.sqrt(s.sq / s.n - (s.sum / s.n) ** 2) / 5)
  return out
})

export const ingestBooks = Effect.fn("ingestBooks")(function*() {
  const docs = new Map<string, Doc>()
  for (let page = 1; page <= 30; page++) {
    for (const d of (yield* search("top", "*:*", page)).docs) docs.set(d.key, d)
    if (page % 10 === 0) yield* Effect.log(`books: ${docs.size} works`)
  }
  for (const [genre, subject] of Object.entries(QUERY_SUBJECTS)) {
    for (let page = 1; page <= 2; page++) {
      for (const d of (yield* search(subject, `subject:${subject}`, page)).docs) docs.set(d.key, d)
    }
    yield* Effect.log(`books: ${docs.size} works after ${genre}`)
  }
  const spread = yield* ratingSpread()

  const items: Array<ItemRow> = []
  const creators: Array<CreatorRow> = []
  for (const d of docs.values()) {
    if (!d.readinglog_count || d.readinglog_count < 5) continue
    const id = d.key.replace("/works/", "")
    const subjects = d.subject ?? []
    const genres = BOOK_GENRES.filter(([, re]) => subjects.some((s) => re.test(s))).map(([g]) => g)
    items.push({
      ext_id: id,
      category: "book",
      title: d.title,
      year: d.first_publish_year ?? null,
      synopsis: d.first_sentence?.[0] ?? null,
      genres,
      tags: subjects.slice(0, 20).map((s) => s.toLowerCase()),
      length_value: d.number_of_pages_median ?? null,
      length_unit: d.number_of_pages_median ? "pages" : null,
      language: d.language?.[0] ?? null,
      image_url: d.cover_i ? `https://covers.openlibrary.org/b/id/${d.cover_i}-L.jpg` : null,
      pop_raw: d.readinglog_count,
      rating_raw: d.ratings_average ? d.ratings_average / 5 : null,
      votes: d.ratings_count ?? 0,
      polarization_raw: spread.get(d.key) ?? null
    })
    const authors = d.author_key ?? []
    authors.slice(0, 3).forEach((key, i) => {
      const name = d.author_name?.[i]
      if (name) creators.push({ ext_id: id, creator_source: "openlibrary", creator_id: key, name, role: "author" })
    })
  }

  yield* upsertItems("openlibrary", items)
  yield* linkCreators("openlibrary", creators)
  yield* Effect.log(`books: ${items.length} items`)
})
