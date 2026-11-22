import { beforeAll, describe, expect, it } from "vitest"
import { API, call, localSql, newAdmin, newUser } from "./client.ts"

// Runs against a live API with an ingested catalog: API_URL=http://localhost:3000 pnpm test
const run = API ? describe : describe.skip

let session = ""

const findMovie = async (title: string, year: number) => {
  const { body } = await call("GET", `/search?q=${encodeURIComponent(title)}&category=movie`, { session })
  const hit = (body as Array<{ id: number; title: string; year: number }>).find((i) => i.title === title && i.year === year)
  if (!hit) throw new Error(`${title} not in catalog`)
  return hit
}

run("magpie e2e", () => {
  let admin = ""
  beforeAll(async () => {
    admin = await newAdmin()
    session = await newUser(admin)
  })

  it("rating an item puts it on the watchlist and reveals its public score", async () => {
    const matrix = await findMovie("The Matrix", 1999)
    expect((await call("POST", "/me/feedback", { body: { itemId: matrix.id, kind: "seen", rating: 5 }, session })).status).toBe(200)
    const { body } = await call("GET", "/me/items", { session })
    const entry = body.find((e: { item: { id: number } }) => e.item.id === matrix.id)
    expect(entry.status).toBe("finished")
    expect(entry.rating).toBe(5)
    expect(typeof entry.item.publicScore).toBe("number")
  })

  it("the deck never contains items the user has already interacted with, and hides public scores", async () => {
    const heat = await findMovie("Heat", 1995)
    await call("POST", "/me/feedback", { body: { itemId: heat.id, kind: "not_interested" }, session })
    const { status, body } = await call("GET", "/me/deck?category=movie&limit=40", { session })
    expect(status).toBe(200)
    expect(body.length).toBeGreaterThan(10)
    const ids = body.map((r: { item: { id: number } }) => r.item.id)
    expect(ids).not.toContain(heat.id)
    expect(body.every((r: { item: { publicScore: unknown } }) => r.item.publicScore === null)).toBe(true)
    expect(body.every((r: { reasons: Array<string> }) => r.reasons.length > 0)).toBe(true)
  })

  it("explains picks by the liked titles they are closest to, never by disliked ones", async () => {
    const fresh = await newUser(admin)
    const rate = async (title: string, year: number, rating: number) => {
      const { id } = await findMovie(title, year)
      await call("POST", "/me/feedback", { body: { itemId: id, kind: "seen", rating }, session: fresh })
    }
    await rate("Alien", 1979, 5)
    await rate("Aliens", 1986, 5)
    await rate("Batman & Robin", 1997, 1)
    const { body } = await call("GET", "/me/deck?category=movie&limit=40", { session: fresh })
    const because = body.flatMap((r: { reasons: Array<string> }) => r.reasons.filter((x) => x.startsWith("Because you liked ")))
    expect(because.length).toBeGreaterThan(3)
    for (const reason of because) expect(reason).toMatch(/^Because you liked (Alien|Aliens)( and (Alien|Aliens))?$/)
  })

  it("re-importing the same IMDb export is idempotent", async () => {
    const csv = [
      "Const,Your Rating,Date Rated,Title,Original Title,URL,Title Type,IMDb Rating,Runtime (mins),Year,Genres,Num Votes,Release Date,Directors",
      "tt0137523,9,2020-01-01,Fight Club,Fight Club,https://www.imdb.com/title/tt0137523/,Movie,8.8,139,1999,Drama,2500000,1999-10-15,David Fincher",
      "tt0000000,7,2020-01-01,Not A Real Film,Not A Real Film,,Movie,5,90,1999,Drama,10,,"
    ].join("\n")
    const first = await call("POST", "/me/imports/imdb", { body: { content: csv }, session })
    expect(first.body.total).toBe(2)
    expect(first.body.matched).toBe(1)
    expect(first.body.unmatched.map((u: { title: string }) => u.title)).toEqual(["Not A Real Film"])
    const before = (await call("GET", "/me/items", { session })).body.length
    await call("POST", "/me/imports/imdb", { body: { content: csv }, session })
    const after = (await call("GET", "/me/items", { session })).body
    expect(after.length).toBe(before)
    expect(after.find((e: { item: { title: string } }) => e.item.title === "Fight Club").rating).toBe(4.5)
  })

  it("calibration leads with a popular title and shows one divisive title per franchise", async () => {
    const fresh = await newUser(admin)
    const { body } = await call("GET", "/me/calibration?category=movie&limit=40", { session: fresh })
    expect(body[0].reasons).toEqual(["Most people have seen this"])
    const divisive = body
      .filter((r: { reasons: Array<string> }) => r.reasons[0]!.startsWith("Divisive"))
      .map((r: { item: { title: string } }) => r.item.title.split(":")[0]!.replace(/\s+([0-9]+|[IVX]+)$/, ""))
    expect(divisive.length).toBeGreaterThan(3)
    expect(new Set(divisive).size).toBe(divisive.length)
  })

  it("rejects ratings outside half-star 0.5-5", async () => {
    const matrix = await findMovie("The Matrix", 1999)
    expect((await call("POST", "/me/feedback", { body: { itemId: matrix.id, kind: "seen", rating: 7 }, session })).status).toBe(400)
    expect((await call("POST", "/me/feedback", { body: { itemId: matrix.id, kind: "seen", rating: 3.3 }, session })).status).toBe(400)
  })


  it("a series length limit applies to TV as well as anime", async () => {
    const fresh = await newUser(admin)
    const prefs = (await call("GET", "/me/preferences", { session: fresh })).body
    const limited = { ...prefs, onboarded: true, filters: { ...prefs.filters, maxEpisodes: 8 } }
    expect((await call("PUT", "/me/preferences", { body: limited, session: fresh })).status).toBe(200)
    const { body } = await call("GET", "/me/deck?category=tv&limit=30", { session: fresh })
    expect(body.length).toBeGreaterThan(5)
    expect(body.filter((r: { item: { lengthValue: number | null } }) => (r.item.lengthValue ?? 0) > 8)).toEqual([])
  })

  it("creator search finds people by part of their name and ignores short queries", async () => {
    const { body } = await call("GET", "/creators?q=nolan", { session })
    expect(body[0]).toEqual({ name: "Christopher Nolan", role: "director", knownFor: "The Dark Knight" })
    expect((await call("GET", "/creators?q=no", { session })).body).toEqual([])
  })

  describe("language preference", () => {
    const withLanguages = async (languages: Array<string>) => {
      const fresh = await newUser(admin)
      const prefs = (await call("GET", "/me/preferences", { session: fresh })).body
      const reply = await call("PUT", "/me/preferences", {
        body: { ...prefs, onboarded: true, filters: { ...prefs.filters, languages } },
        session: fresh
      })
      return { fresh, status: reply.status }
    }

    it("keeps films and TV to the chosen languages", async () => {
      const { fresh } = await withLanguages(["en", "fr"])
      for (const category of ["movie", "tv"]) {
        const { body } = await call("GET", `/me/deck?category=${category}&limit=40`, { session: fresh })
        expect(body.length).toBeGreaterThan(10)
        const others = body.filter((r: { item: { language: string | null } }) => r.item.language !== "en" && r.item.language !== "fr")
        expect(others).toEqual([])
      }
    })

    it("doesn't filter anime by language", async () => {
      const { fresh } = await withLanguages(["en"])
      const { body } = await call("GET", "/me/deck?category=anime&limit=20", { session: fresh })
      expect(body.length).toBeGreaterThan(10)
    })

    it("accepts at most two distinct language codes", async () => {
      expect((await withLanguages(["en", "fr", "es"])).status).toBe(400)
      expect((await withLanguages(["en", "en"])).status).toBe(400)
      expect((await withLanguages(["English"])).status).toBe(400)
    })
  })

  describe("search", () => {
    const search = async (q: string, category?: string) => {
      const query = new URLSearchParams({ q, ...(category ? { category } : {}) })
      const { status, body } = await call("GET", `/search?${query}`, { session })
      expect(status).toBe(200)
      return body as Array<{ title: string; category: string }>
    }

    it("ranks well-known titles that start with the query first", async () => {
      expect((await search("harry"))[0]).toMatchObject({ title: "Harry Potter and the Philosopher's Stone", category: "book" })
    })

    it("finds anime by their original title", async () => {
      expect((await search("shingeki"))[0]).toMatchObject({ title: "Attack on Titan", category: "anime" })
    })

    it("forgives a typo", async () => {
      expect((await search("piranesy"))[0]).toMatchObject({ title: "Piranesi", category: "book" })
    })

    it("only matches whole titles for very short queries", async () => {
      const titles = (await search("It")).map((r) => r.title.toLowerCase())
      expect(titles.length).toBeGreaterThan(0)
      expect([...new Set(titles)]).toEqual(["it"])
    })

    it("narrows to one kind", async () => {
      const kinds = (await search("dune", "book")).map((r) => r.category)
      expect([...new Set(kinds)]).toEqual(["book"])
    })
  })

  describe("search further (calls TMDB, AniList and Open Library)", () => {
    const Q = "the hobbit or there and back again"
    const further = (q: string, category?: string) =>
      call("POST", "/search/further", { body: category ? { q, category } : { q }, session })
    const hobbits1990 = async () =>
      (await call("GET", `/search?${new URLSearchParams({ q: "the hobbit", category: "book" })}`, { session })).body.filter(
        (i: { title: string; year: number }) => i.title === "The Hobbit" && i.year === 1990
      ).length

    beforeAll(() => {
      localSql(`DELETE FROM search_enrichment WHERE query = 'book:${Q}';
        DELETE FROM item WHERE meta ? 'enriched_at' AND id IN
          (SELECT item_id FROM item_external_id WHERE source = 'openlibrary' AND external_id = 'OL19622663W')`)
    })

    it("stores what the external catalogues find, so local search finds it next time", async () => {
      expect(await hobbits1990()).toBe(1)
      const { status, body } = await further(Q, "book")
      expect(status).toBe(200)
      expect(body).toContainEqual(expect.objectContaining({ title: "The Hobbit", category: "book", year: 1990 }))
      expect(await hobbits1990()).toBe(2)
    })

    it("doesn't ask again or add duplicates for a query it looked up recently", async () => {
      const again = await further(Q, "book")
      expect(again.status).toBe(200)
      expect(again.body).toEqual([])
      expect(await hobbits1990()).toBe(2)
    })

    it("rejects queries under three characters", async () => {
      expect((await further("hp")).status).toBe(400)
    })
  })
})
