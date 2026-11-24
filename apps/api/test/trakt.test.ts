import { describe, expect, it } from "vitest"
import { traktRows } from "../src/Trakt.ts"

const breakingBad = { title: "Breaking Bad", year: 2008, ids: { trakt: 1, imdb: "tt0903747", tmdb: 1396 }, aired_episodes: 62 }
const tron = { title: "TRON: Legacy", year: 2010, ids: { trakt: 12601, imdb: "tt1104001", tmdb: 20526 } }
const noImdb = { title: "Obscure Film", year: 2021, ids: { trakt: 99, imdb: null, tmdb: 777 } }

const episodes = (season: number, count: number, at = "2024-01-01T00:00:00.000Z") => ({
  number: season,
  episodes: Array.from({ length: count }, (_, i) => ({ number: i + 1, plays: 1, last_watched_at: at }))
})

describe("trakt rows", () => {
  it("maps each list to library rows, watchlist first so a later watch overrides it", () => {
    const rows = traktRows({
      watchlistMovies: [{ listed_at: "2024-01-01T00:00:00.000Z", movie: tron }],
      watchedMovies: [{ last_watched_at: "2024-02-01T00:00:00.000Z", movie: tron }],
      movieRatings: [{ rated_at: "2024-02-02T00:00:00.000Z", rating: 7, movie: tron }]
    })
    expect(rows.map((r) => [r.key, r.status, r.rating, r.ref])).toEqual([
      ["watchlist:movie:12601:2024-01-01T00:00:00.000Z", "want", null, { source: "imdb", id: "tt1104001" }],
      ["watched:movie:12601:2024-02-01T00:00:00.000Z", "finished", null, { source: "imdb", id: "tt1104001" }],
      ["rating:movie:12601:2024-02-02T00:00:00.000Z", "finished", 3.5, { source: "imdb", id: "tt1104001" }]
    ])
  })

  it("counts watched episodes, ignoring specials, and finishes a show once every aired episode is watched", () => {
    const [partial] = traktRows({
      watchedShows: [{ last_watched_at: "2024-03-01T00:00:00.000Z", show: breakingBad, seasons: [episodes(0, 3), episodes(1, 7), episodes(2, 13)] }]
    })
    expect([partial!.key, partial!.status, partial!.progress, partial!.category]).toEqual(["watched:show:1:20", "in_progress", 20, "tv"])
    const [done] = traktRows({
      watchedShows: [{ last_watched_at: "2024-03-01T00:00:00.000Z", show: breakingBad, seasons: [episodes(1, 30), episodes(2, 32)] }]
    })
    expect([done!.status, done!.progress]).toEqual(["finished", 62])
  })

  it("counts only episodes watched since a rewatch started", () => {
    const [row] = traktRows({
      watchedShows: [{
        last_watched_at: "2025-01-02T00:00:00.000Z",
        reset_at: "2025-01-01T00:00:00.000Z",
        show: breakingBad,
        seasons: [episodes(1, 7, "2020-01-01T00:00:00.000Z"), { number: 2, episodes: [{ number: 1, plays: 2, last_watched_at: "2025-01-02T00:00:00.000Z" }] }]
      }]
    })
    expect([row!.progress, row!.status]).toEqual([1, "in_progress"])
  })

  it("rates shows without changing their status, and falls back to TMDB ids when IMDb has none", () => {
    const rows = traktRows({
      showRatings: [{ rated_at: "2024-04-01T00:00:00.000Z", rating: 10, show: breakingBad }],
      watchedMovies: [{ last_watched_at: "2024-04-02T00:00:00.000Z", movie: noImdb }]
    })
    expect(rows.map((r) => [r.key, r.status, r.rating, r.ref])).toEqual([
      ["watched:movie:99:2024-04-02T00:00:00.000Z", "finished", null, { source: "tmdb_movie", id: "777" }],
      ["rating:show:1:2024-04-01T00:00:00.000Z", null, 5, { source: "imdb", id: "tt0903747" }]
    ])
  })
})
