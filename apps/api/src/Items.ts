import { Item, type ItemId } from "@magpie/contract"

// Columns every item query selects, aliased for toItem. `rated` controls whether the public score is revealed.
export const ITEM_COLUMNS = `
  i.id::int AS id, i.category::text AS category, i.title, i.year, i.synopsis, i.genres, i.tags,
  i.image_url, i.meta->>'backdrop_url' AS backdrop_url, i.meta->>'trailer_youtube' AS trailer_youtube, i.length_value, i.length_unit, i.language, i.quality, i.popularity, i.polarization,
  COALESCE((SELECT array_agg(c.name ORDER BY ic.role) FROM (
     SELECT creator_id, role FROM item_creator WHERE item_id = i.id LIMIT 3) ic
     JOIN creator c ON c.id = ic.creator_id), '{}') AS creators`

export interface ItemRow {
  readonly id: number
  readonly category: Item["category"]
  readonly title: string
  readonly year: number | null
  readonly synopsis: string | null
  readonly genres: ReadonlyArray<string>
  readonly tags: ReadonlyArray<string>
  readonly image_url: string | null
  readonly backdrop_url: string | null
  readonly trailer_youtube: string | null
  readonly length_value: number | null
  readonly length_unit: Item["lengthUnit"]
  readonly language: string | null
  readonly quality: number | null
  readonly popularity: number
  readonly polarization: number | null
  readonly creators: ReadonlyArray<string>
}

export const toItem = (r: ItemRow, revealScore: boolean): Item =>
  new Item({
    id: r.id as ItemId,
    category: r.category,
    title: r.title,
    year: r.year,
    synopsis: r.synopsis,
    genres: r.genres,
    tags: r.tags.slice(0, 12),
    creators: r.creators,
    imageUrl: r.image_url,
    backdropUrl: r.backdrop_url,
    trailerYoutubeId: r.trailer_youtube,
    lengthValue: r.length_value,
    lengthUnit: r.length_unit,
    language: r.language,
    publicScore: revealScore && r.quality !== null ? Math.round(r.quality * 100) : null
  })
