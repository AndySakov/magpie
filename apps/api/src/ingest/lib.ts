import { Config, Effect } from "effect"
import { SqlClient } from "effect/sql"
import { createReadStream } from "node:fs"
import { join } from "node:path"
import { createInterface } from "node:readline"
import { createGunzip } from "node:zlib"

export const dataDir = Config.String("DATA_DIR")

export const dataPath = (file: string) => Effect.map(dataDir, (dir: string) => join(dir, file))

export async function* lines(path: string): AsyncGenerator<string> {
  const input = createReadStream(path)
  const stream = path.endsWith(".gz") ? input.pipe(createGunzip()) : input
  yield* createInterface({ input: stream, crlfDelay: Infinity })
}

export const chunk = <A>(xs: ReadonlyArray<A>, size: number): Array<Array<A>> => {
  const out: Array<Array<A>> = []
  for (let i = 0; i < xs.length; i += size) out.push(xs.slice(i, i + size))
  return out
}

export interface ItemRow {
  readonly ext_id: string
  readonly category: "movie" | "tv" | "anime" | "book"
  readonly title: string
  readonly original_title?: string | null
  readonly year?: number | null
  readonly synopsis?: string | null
  readonly genres?: ReadonlyArray<string>
  readonly tags?: ReadonlyArray<string>
  readonly length_value?: number | null
  readonly length_unit?: "minutes" | "episodes" | "pages" | null
  readonly is_adult?: boolean
  readonly language?: string | null
  readonly image_url?: string | null
  // Raw popularity signal (votes, readers, members). Normalised to a percentile in finalize.
  readonly pop_raw?: number | null
  // Raw rating normalised to 0..1 and its vote count. Shrunk and ranked in finalize.
  readonly rating_raw?: number | null
  readonly votes?: number | null
  readonly polarization_raw?: number | null
  readonly meta?: Record<string, unknown>
}

const ITEM_COLUMNS = `ext_id text, category category, title text, original_title text, year int, synopsis text,
  genres text[], tags text[], length_value int, length_unit text, is_adult boolean, language text, image_url text,
  pop_raw float8, rating_raw float8, votes int, polarization_raw float8, meta jsonb`

// Upserts items keyed by (source, ext_id). Idempotent: reruns update in place.
export const upsertItems = Effect.fn("upsertItems")(function*(source: string, rows: ReadonlyArray<ItemRow>) {
  const sql = yield* SqlClient.SqlClient
  for (const batch of chunk(rows, 2000)) {
    const payload = JSON.stringify(batch)
    yield* sql.unsafe(
      `WITH input AS (SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(${ITEM_COLUMNS})),
       existing AS (
         SELECT e.item_id, i.* FROM input i
         JOIN item_external_id e ON e.source = $2 AND e.external_id = i.ext_id
       ),
       upd AS (
         UPDATE item t SET
           title = x.title, original_title = x.original_title, year = x.year,
           synopsis = COALESCE(x.synopsis, t.synopsis),
           genres = COALESCE(x.genres, '{}'), tags = COALESCE(x.tags, '{}'),
           length_value = x.length_value, length_unit = x.length_unit,
           is_adult = COALESCE(x.is_adult, false), language = x.language,
           image_url = COALESCE(x.image_url, t.image_url),
           quality_votes = COALESCE(x.votes, 0),
           meta = t.meta || COALESCE(x.meta, '{}') || jsonb_strip_nulls(jsonb_build_object(
             'pop_raw', x.pop_raw, 'rating_raw', x.rating_raw, 'polarization_raw', x.polarization_raw)),
           updated_at = now()
         FROM existing x WHERE t.id = x.item_id
         RETURNING t.id
       ),
       ins AS (
         INSERT INTO item (category, title, original_title, year, synopsis, genres, tags, length_value, length_unit,
                           is_adult, language, image_url, quality_votes, meta)
         SELECT i.category, i.title, i.original_title, i.year, i.synopsis, COALESCE(i.genres, '{}'), COALESCE(i.tags, '{}'),
                i.length_value, i.length_unit, COALESCE(i.is_adult, false), i.language, i.image_url, COALESCE(i.votes, 0),
                COALESCE(i.meta, '{}') || jsonb_strip_nulls(jsonb_build_object(
                  '_ext', i.ext_id, 'pop_raw', i.pop_raw, 'rating_raw', i.rating_raw, 'polarization_raw', i.polarization_raw))
         FROM input i
         WHERE NOT EXISTS (SELECT 1 FROM item_external_id e WHERE e.source = $2 AND e.external_id = i.ext_id)
         RETURNING id, meta->>'_ext' AS ext_id
       )
       INSERT INTO item_external_id (source, external_id, item_id)
       SELECT $2, ext_id, id FROM ins
       ON CONFLICT DO NOTHING`,
      [payload, source]
    )
  }
  yield* Effect.log(`${source}: upserted ${rows.length} items`)
})

export interface ExternalIdRow {
  readonly ext_id: string
  readonly source: string
  readonly external_id: string
}

// Adds alternate IDs (e.g. MAL, AniList, IMDb, MovieLens) to items found by their primary (source, ext_id).
export const addExternalIds = Effect.fn("addExternalIds")(function*(primary: string, rows: ReadonlyArray<ExternalIdRow>) {
  const sql = yield* SqlClient.SqlClient
  for (const batch of chunk(rows, 5000)) {
    yield* sql.unsafe(
      `INSERT INTO item_external_id (source, external_id, item_id)
       SELECT x.source, x.external_id, e.item_id
       FROM jsonb_to_recordset($1::jsonb) AS x(ext_id text, source text, external_id text)
       JOIN item_external_id e ON e.source = $2 AND e.external_id = x.ext_id
       ON CONFLICT DO NOTHING`,
      [JSON.stringify(batch), primary]
    )
  }
})

export interface CreatorRow {
  readonly ext_id: string
  readonly creator_source: string
  readonly creator_id: string
  readonly name: string
  readonly role: string
}

export const linkCreators = Effect.fn("linkCreators")(function*(primary: string, rows: ReadonlyArray<CreatorRow>) {
  const sql = yield* SqlClient.SqlClient
  for (const batch of chunk(rows, 5000)) {
    const payload = JSON.stringify(batch)
    yield* sql.unsafe(
      `INSERT INTO creator (source, external_id, name)
       SELECT DISTINCT ON (creator_source, creator_id) creator_source, creator_id, name
       FROM jsonb_to_recordset($1::jsonb) AS x(creator_source text, creator_id text, name text)
       ON CONFLICT (source, external_id) DO UPDATE SET name = EXCLUDED.name`,
      [payload]
    )
    yield* sql.unsafe(
      `INSERT INTO item_creator (item_id, creator_id, role)
       SELECT e.item_id, c.id, x.role
       FROM jsonb_to_recordset($1::jsonb) AS x(ext_id text, creator_source text, creator_id text, role text)
       JOIN item_external_id e ON e.source = $2 AND e.external_id = x.ext_id
       JOIN creator c ON c.source = x.creator_source AND c.external_id = x.creator_id
       ON CONFLICT DO NOTHING`,
      [payload, primary]
    )
  }
})

export interface RelationRow {
  readonly from_source: string
  readonly from_id: string
  readonly to_source: string
  readonly to_id: string
  readonly kind: "part_of" | "expansion_of" | "adaptation_of" | "in_franchise" | "sequel_of" | "related"
}

export const linkRelations = Effect.fn("linkRelations")(function*(rows: ReadonlyArray<RelationRow>) {
  const sql = yield* SqlClient.SqlClient
  for (const batch of chunk(rows, 5000)) {
    yield* sql.unsafe(
      `INSERT INTO item_relation (from_item, to_item, kind)
       SELECT a.item_id, b.item_id, x.kind::relation_kind
       FROM jsonb_to_recordset($1::jsonb) AS x(from_source text, from_id text, to_source text, to_id text, kind text)
       JOIN item_external_id a ON a.source = x.from_source AND a.external_id = x.from_id
       JOIN item_external_id b ON b.source = x.to_source AND b.external_id = x.to_id
       WHERE a.item_id <> b.item_id
       ON CONFLICT DO NOTHING`,
      [JSON.stringify(batch)]
    )
  }
})

export const sleep = (ms: number) => Effect.sleep(`${ms} millis`)
