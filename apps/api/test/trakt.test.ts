import { describe, expect, it } from "vitest"
import { traktRows } from "../src/Trakt.ts"

const breakingBad = { title: "Breaking Bad", year: 2008, ids: { trakt: 1, imdb: "tt0903747", tmdb: 1396 }, aired_episodes: 62, status: "ended" }
const severance = { title: "Severance", year: 2022, ids: { trakt: 154997, imdb: "tt11280740", tmdb: 95396 }, aired_episodes: 19, status: "returning series" }
const tron = { title: "TRON: Legacy", year: 2010, ids: { trakt: 12601, imdb: "tt1104001", tmdb: 20526 } }
const noImdb = { title: "Obscure Film", year: 2021, ids: { trakt: 99, imdb: null, tmdb: 777 } }


describe("trakt rows", () => {
  it("maps each list to library rows", () => {
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

  // Live /sync/watched/shows sends no seasons, only total plays, whatever `extended` asks for.
  it("tracks show progress from episode plays, as live Trakt reports it", () => {
    const [partial] = traktRows({
      watchedShows: [{ plays: 3, last_watched_at: "2026-11-24T16:38:00.000Z", show: breakingBad }]
    })
    expect([partial!.key, partial!.status, partial!.progress, partial!.category]).toEqual(["watched:show:1:3", "in_progress", 3, "tv"])
  })

  it("finishes a show at its aired episode count and never reports more progress than that", () => {
    const [done] = traktRows({ watchedShows: [{ plays: 70, last_watched_at: "2024-03-01T00:00:00.000Z", show: breakingBad }] })
    expect([done!.key, done!.status, done!.progress]).toEqual(["watched:show:1:62:finished", "finished", 62])
  })

  it("keeps a show that is still airing in progress, even when caught up", () => {
    const [current] = traktRows({ watchedShows: [{ plays: 19, last_watched_at: "2025-03-21T00:00:00.000Z", show: severance }] })
    expect([current!.key, current!.status, current!.progress]).toEqual(["watched:show:154997:19", "in_progress", 19])
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
