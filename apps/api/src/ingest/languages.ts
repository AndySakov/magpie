import { Config, Effect } from "effect"
import { SqlClient } from "effect/sql"
import { existsSync } from "node:fs"
import { readdir, readFile } from "node:fs/promises"
import { toIso1 } from "../catalog.ts"
import { chunk } from "./lib.ts"

type Doc = { readonly key: string; readonly language?: ReadonlyArray<string> }

const bookLanguages = (dir: string) =>
  Effect.promise(async () => {
    const out = new Map<string, Array<string>>()
    if (!existsSync(dir)) return out
    for (const file of await readdir(dir)) {
      if (!file.endsWith(".json")) continue
      const page = JSON.parse(await readFile(`${dir}/${file}`, "utf8")) as { docs?: ReadonlyArray<Doc> }
      for (const d of page.docs ?? []) {
        const codes = [...new Set((d.language ?? []).map(toIso1).filter((c): c is string => c !== null))]
        if (codes.length > 0) out.set(d.key.replace("/works/", ""), codes)
      }
    }
    return out
  })

// "Languages you can watch or read this in": the original language for film, TV and anime,
// every edition language for books.
export const ingestLanguages = () =>
  Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    const dataDir = yield* Config.String("DATA_DIR")
    yield* sql`
      UPDATE item SET languages = ARRAY[language]
      WHERE category <> 'book' AND language IS NOT NULL AND languages IS DISTINCT FROM ARRAY[language]`
    const books = yield* bookLanguages(`${dataDir}/ol_search`)
    let updated = 0
    for (const batch of chunk([...books].map(([id, languages]) => ({ id, languages })), 2000)) {
      const rows = yield* sql<{ n: number }>`
        UPDATE item i SET languages = x.languages
        FROM jsonb_to_recordset(${JSON.stringify(batch)}::jsonb) AS x(id text, languages text[]), item_external_id e
        WHERE e.source = 'openlibrary' AND e.external_id = x.id AND i.id = e.item_id AND i.languages IS DISTINCT FROM x.languages
        RETURNING 1 AS n`
      updated += rows.length
    }
    yield* Effect.log(`languages: ${books.size} books in cache, ${updated} updated`)
  })
