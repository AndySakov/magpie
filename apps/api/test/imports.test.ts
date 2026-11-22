import { describe, expect, it } from "vitest"
import { parseCsv, parseGoodreads, parseImdb, parseLetterboxd, parseMal } from "../src/Imports.ts"

describe("parseCsv", () => {
  it("handles quoted commas, escaped quotes, CRLF and a BOM", () => {
    const text = "﻿Name,Note\r\n\"Crouching Tiger, Hidden Dragon\",\"He said \"\"hi\"\"\"\r\nAlien,\r\n"
    expect(parseCsv(text)).toEqual([
      { Name: "Crouching Tiger, Hidden Dragon", Note: "He said \"hi\"" },
      { Name: "Alien", Note: "" }
    ])
  })
})

describe("parseLetterboxd", () => {
  const ratings = "Date,Name,Year,Letterboxd URI,Rating\n2024-03-01,Past Lives,2023,https://boxd.it/abc,4.5\n"

  it("reads ratings as finished with half stars", () => {
    expect(parseLetterboxd(ratings, "ratings.csv")).toEqual([{
      key: "https://boxd.it/abc",
      category: "movie",
      title: "Past Lives",
      year: 2023,
      rating: 4.5,
      status: "finished",
      at: new Date("2024-03-01")
    }])
  })

  it("marks watchlist.csv entries as want, using the filename", () => {
    const watchlist = "Date,Name,Year,Letterboxd URI\n2024-05-02,Dune: Part Two,2024,https://boxd.it/xyz\n"
    expect(parseLetterboxd(watchlist, "watchlist.csv")[0]?.status).toBe("want")
    expect(parseLetterboxd(watchlist, "watched.csv")[0]?.status).toBe("finished")
  })
})

describe("parseImdb", () => {
  it("maps tconst, 10-point ratings to stars and series to tv", () => {
    const text = [
      "Const,Your Rating,Date Rated,Title,Original Title,URL,Title Type,IMDb Rating,Runtime (mins),Year,Genres,Num Votes,Release Date,Directors",
      "tt0903747,10,2023-01-02,Breaking Bad,Breaking Bad,https://www.imdb.com/title/tt0903747/,TV Series,9.5,49,2008,\"Crime, Drama\",2000000,2008-01-20,",
      "tt0133093,7,2022-06-10,The Matrix,The Matrix,https://www.imdb.com/title/tt0133093/,Movie,8.7,136,1999,Action,2000000,1999-03-31,Lana Wachowski"
    ].join("\n")
    const rows = parseImdb(text)
    expect(rows.map((r) => [r.ref?.id, r.category, r.rating])).toEqual([
      ["tt0903747", "tv", 5],
      ["tt0133093", "movie", 3.5]
    ])
  })
})

describe("parseGoodreads", () => {
  it("strips series suffixes, maps shelves and treats 0 stars as unrated", () => {
    const text = [
      "Book Id,Title,Author,Author l-f,Additional Authors,ISBN,ISBN13,My Rating,Average Rating,Publisher,Binding,Number of Pages,Year Published,Original Publication Year,Date Read,Date Added,Bookshelves,Bookshelves with positions,Exclusive Shelf",
      "1,\"The Fellowship of the Ring (The Lord of the Rings, #1)\",J.R.R. Tolkien,\"Tolkien, J.R.R.\",,,,5,4.38,,Paperback,398,2003,1954,2020/01/05,2019/12/01,,,read",
      "2,Piranesi,Susanna Clarke,\"Clarke, Susanna\",,,,0,4.2,,Hardcover,272,2020,2020,,2024/02/01,to-read,to-read (#1),to-read"
    ].join("\n")
    expect(parseGoodreads(text).map((r) => [r.title, r.year, r.author, r.rating, r.status])).toEqual([
      ["The Fellowship of the Ring", 1954, "J.R.R. Tolkien", 5, "finished"],
      ["Piranesi", 2020, "Susanna Clarke", null, "want"]
    ])
  })
})

describe("parseMal", () => {
  it("reads ids, CDATA titles, scores, status and progress", () => {
    const xml = `<myanimelist>
      <anime><series_animedb_id>5114</series_animedb_id><series_title><![CDATA[Fullmetal Alchemist: Brotherhood]]></series_title>
        <my_watched_episodes>64</my_watched_episodes><my_finish_date>2021-04-02</my_finish_date><my_score>10</my_score><my_status>Completed</my_status></anime>
      <anime><series_animedb_id>1535</series_animedb_id><series_title><![CDATA[Death Note]]></series_title>
        <my_watched_episodes>12</my_watched_episodes><my_finish_date>0000-00-00</my_finish_date><my_score>0</my_score><my_status>Dropped</my_status></anime>
    </myanimelist>`
    expect(parseMal(xml).map((r) => [r.ref?.id, r.title, r.rating, r.status, r.progress])).toEqual([
      ["5114", "Fullmetal Alchemist: Brotherhood", 5, "finished", 64],
      ["1535", "Death Note", null, "dropped", 12]
    ])
  })
})
