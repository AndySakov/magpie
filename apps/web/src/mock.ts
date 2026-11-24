// Dev-only in-browser API (VITE_MOCK=1). Runs the real contract through HttpApiBuilder, so every
// response is encoded and decoded by the same schemas the server uses. Titles are real works; all
// scores, reasons and history are synthetic.
import {
  CATEGORIES,
  GenreCount,
  ImportResult,
  Item,
  ItemId,
  ItemNotFound,
  MagpieApi,
  Preferences,
  Provider,
  ProviderId,
  Recommendation,
  Region,
  WatchOptions,
  WatchSetup,
  UnmatchedRow,
  User,
  UserId,
  UserItem,
  Authentication,
  Challenge,
  CreatorHit,
  CurrentUser,
  Invite,
  InviteInfo,
  Filters,
  type Category,
  type Status
} from "@magpie/contract"
import { Effect, Layer } from "effect"
import { HttpRouter, HttpServer } from "effect/http"
import { HttpApiBuilder } from "effect/http-api"

type Row = readonly [
  title: string,
  year: number,
  genres: ReadonlyArray<string>,
  creators: ReadonlyArray<string>,
  length: number,
  synopsis: string,
  withImage?: boolean
]

const catalog: Record<Category, ReadonlyArray<Row>> = {
  movie: [
    ["Paris, Texas", 1984, ["Drama"], ["Wim Wenders"], 145, "A man wanders out of the desert after four years and tries to rebuild what he left behind.", true],
    ["In the Mood for Love", 2000, ["Drama", "Romance"], ["Wong Kar-wai"], 98, "Two neighbours in 1962 Hong Kong suspect their spouses of an affair and drift towards each other.", true],
    ["Stalker", 1979, ["Science Fiction", "Drama"], ["Andrei Tarkovsky"], 162, "A guide leads a writer and a professor into the Zone, where a room is said to grant wishes."],
    ["Portrait of a Lady on Fire", 2019, ["Drama", "Romance"], ["Céline Sciamma"], 122, "A painter is commissioned to secretly paint a reluctant bride on an isolated Breton island.", true],
    ["The Thing", 1982, ["Horror", "Science Fiction"], ["John Carpenter"], 109, "An Antarctic research crew discovers something that can imitate any of them."],
    ["Perfect Days", 2023, ["Drama"], ["Wim Wenders"], 124, "A Tokyo toilet cleaner finds quiet joy in routine, cassette tapes and trees.", true],
    ["Mad Max: Fury Road", 2015, ["Action", "Adventure"], ["George Miller"], 120, "A drifter and a rebel commander flee a desert tyrant in a war rig full of his wives."],
    ["Aftersun", 2022, ["Drama"], ["Charlotte Wells"], 102, "A woman recalls a Turkish holiday with her father twenty years earlier.", true],
    ["Synecdoche, New York", 2008, ["Drama", "Comedy"], ["Charlie Kaufman"], 124, "A theatre director builds a life-size replica of New York inside a warehouse."],
    ["Past Lives", 2023, ["Drama", "Romance"], ["Celine Song"], 106, "Two childhood friends reunite in New York decades after one emigrated from Seoul.", true]
  ],
  tv: [
    ["Severance", 2022, ["Thriller", "Science Fiction"], ["Dan Erickson"], 19, "Office workers have their memories surgically split between work and home.", true],
    ["The Bear", 2022, ["Drama", "Comedy"], ["Christopher Storer"], 38, "A fine-dining chef comes home to run his late brother's Chicago sandwich shop."],
    ["Twin Peaks", 1990, ["Mystery", "Drama"], ["David Lynch", "Mark Frost"], 30, "An FBI agent investigates the murder of a homecoming queen in a strange logging town.", true],
    ["Detectorists", 2014, ["Comedy"], ["Mackenzie Crook"], 19, "Two metal detectorists search Essex fields for treasure and meaning."],
    ["Halt and Catch Fire", 2014, ["Drama"], ["Christopher Cantwell", "Christopher C. Rogers"], 40, "Engineers chase the personal computer boom, then the internet, across a decade.", true],
    ["Shōgun", 2024, ["Drama", "History"], ["Rachel Kondo", "Justin Marks"], 10, "An English pilot shipwrecked in feudal Japan is drawn into a lord's struggle for power."],
    ["The Leftovers", 2014, ["Drama", "Mystery"], ["Damon Lindelof", "Tom Perrotta"], 28, "Three years after 2% of the world vanished, a small town police chief holds on.", true],
    ["Fleabag", 2016, ["Comedy", "Drama"], ["Phoebe Waller-Bridge"], 12, "A grieving, oversharing Londoner navigates family, sex and a café nobody visits."]
  ],
  anime: [
    ["Mushishi", 2005, ["Fantasy", "Slice of Life"], ["Artland"], 26, "A wanderer studies mushi, primitive life forms that cause strange phenomena."],
    ["Ping Pong the Animation", 2014, ["Sports", "Drama"], ["Tatsunoko Production"], 11, "Two high-school friends take very different paths through competitive table tennis."],
    ["Mob Psycho 100", 2016, ["Action", "Comedy"], ["Bones"], 12, "A boy with huge psychic power just wants to be normal and join the body improvement club."],
    ["Frieren: Beyond Journey's End", 2023, ["Fantasy", "Adventure"], ["Madhouse"], 28, "An elf mage, decades after her party defeated the Demon King, learns what her friends meant."],
    ["Odd Taxi", 2021, ["Mystery", "Drama"], ["OLM", "P.I.C.S."], 13, "A walrus taxi driver gets pulled into the disappearance of a high-school girl."],
    ["Kaiba", 2008, ["Science Fiction", "Romance"], ["Madhouse"], 12, "In a world where memories can be stored and traded, a boy wakes with none."],
    ["Mononoke", 2007, ["Horror", "Mystery"], ["Toei Animation"], 12, "A medicine seller hunts spirits by learning their form, truth and reason."],
    ["Space Brothers", 2012, ["Drama", "Comedy"], ["A-1 Pictures"], 99, "An older brother quits his car-design job to follow his younger brother into space."]
  ],
  book: [
    ["The Left Hand of Darkness", 1969, ["Science Fiction"], ["Ursula K. Le Guin"], 304, "An envoy to a winter world where people have no fixed sex must earn a king's trust."],
    ["Piranesi", 2020, ["Fantasy"], ["Susanna Clarke"], 272, "A man lives in an endless house of statues and tides, keeping careful journals.", true],
    ["Stoner", 1965, ["Literary Fiction"], ["John Williams"], 288, "The quiet life of a Missouri farm boy who becomes an English professor."],
    ["The Remains of the Day", 1989, ["Literary Fiction"], ["Kazuo Ishiguro"], 258, "An English butler takes a motoring trip and reckons with decades of service."],
    ["Roadside Picnic", 1972, ["Science Fiction"], ["Arkady Strugatsky", "Boris Strugatsky"], 224, "Stalkers smuggle artefacts out of zones left behind by an alien visit."],
    ["Pachinko", 2017, ["Historical Fiction"], ["Min Jin Lee"], 496, "Four generations of a Korean family in Japan across the twentieth century.", true],
    ["The Dispossessed", 1974, ["Science Fiction"], ["Ursula K. Le Guin"], 387, "A physicist leaves his anarchist moon to work on the capitalist planet it broke from."],
    ["Tomorrow, and Tomorrow, and Tomorrow", 2022, ["Literary Fiction"], ["Gabrielle Zevin"], 416, "Two friends design video games together across thirty years.", true]
  ]
}

const unitFor: Record<Category, "minutes" | "episodes" | "pages"> = {
  movie: "minutes",
  tv: "episodes",
  anime: "episodes",
  book: "pages"
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-")

const items: Item[] = CATEGORIES.flatMap((category, ci) =>
  catalog[category].map(
    ([title, year, genres, creators, length, synopsis, withImage], i) =>
      new Item({
        id: ItemId.make(ci * 100 + i + 1),
        category,
        title,
        year,
        synopsis,
        genres,
        tags: [],
        creators,
        imageUrl: withImage ? `https://picsum.photos/seed/${slug(title)}/600/900` : null,
        backdropUrl: null,
        trailerYoutubeId: null,
        lengthValue: length,
        lengthUnit: unitFor[category],
        language: category === "anime" ? "ja" : "en",
        publicScore: null
      })
  )
)

const byId = new Map(items.map((item) => [item.id as number, item]))

const reasonsFor = (item: Item, index: number): ReadonlyArray<string> => {
  const peers = items.filter((other) => other.category === item.category && other.id !== item.id)
  const a = peers[index % peers.length]
  const b = peers[(index + 3) % peers.length]
  const pool = [
    `Because you liked ${a?.title} and ${b?.title}`,
    `3 people with your taste loved this`,
    `From ${item.creators[0]}, who made ${a?.title}`,
    `A hidden gem in ${item.genres[0]?.toLowerCase()}`
  ]
  return index % 3 === 0 ? [pool[0]!, pool[1]!] : [pool[index % pool.length]!]
}

type Entry = { status: Status | null; rating: number | null; progress: number | null; updatedAt: string }

const db = {
  users: [
    new User({ id: UserId.make("u-ada"), name: "Ada", isAdmin: true }),
    new User({ id: UserId.make("u-kofi"), name: "Kofi", isAdmin: false })
  ],
  prefs: new Map<string, Preferences>(),
  library: new Map<string, Map<number, Entry>>(),
  swiped: new Map<string, Set<number>>()
}

const defaultPrefs = (onboarded: boolean) =>
  new Preferences({
    genres: onboarded ? { movie: ["Drama"], tv: [], anime: ["Fantasy"], book: ["Science Fiction"] } : {},
    dial: {},
    onboarded,
    filters: new Filters({
      showMature: false,
      languages: [],
      maxMinutes: null,
      maxEpisodes: null,
      maxPages: null,
      blockedGenres: [],
      blockedCreators: []
    }),
    watch: new WatchSetup({ region: null, services: [], onlyMine: false })
  })

db.prefs.set("u-ada", defaultPrefs(true))
db.prefs.set("u-kofi", defaultPrefs(false))
db.library.set(
  "u-ada",
  new Map<number, Entry>([
    [1, { status: "finished", rating: 5, progress: null, updatedAt: "2026-11-02T20:11:00Z" }],
    [101, { status: "in_progress", rating: null, progress: 6, updatedAt: "2026-11-19T22:40:00Z" }],
    [204, { status: "want", rating: null, progress: null, updatedAt: "2026-11-18T09:05:00Z" }],
    [302, { status: "in_progress", rating: null, progress: 140, updatedAt: "2026-11-20T23:15:00Z" }],
    [107, { status: "dropped", rating: 2, progress: 3, updatedAt: "2026-10-12T18:00:00Z" }],
    [5, { status: "want", rating: null, progress: null, updatedAt: "2026-11-21T08:30:00Z" }]
  ])
)

const libraryOf = (userId: string) => {
  let lib = db.library.get(userId)
  if (!lib) db.library.set(userId, (lib = new Map()))
  return lib
}
const swipedOf = (userId: string) => {
  let set = db.swiped.get(userId)
  if (!set) db.swiped.set(userId, (set = new Set()))
  return set
}

const ME = UserId.make("u-ada")
const me = () => db.users[0]!

const toUserItem = (item: Item, entry: Entry) =>
  new UserItem({
    item: entry.rating === null ? item : new Item({ ...item, publicScore: 60 + ((item.id * 7) % 35) }),
    status: entry.status,
    rating: entry.rating,
    progress: entry.progress,
    updatedAt: entry.updatedAt
  })

const recs = (userId: string, category: Category, limit: number, source: Recommendation["source"]) => {
  const swiped = swipedOf(userId)
  const lib = libraryOf(userId)
  return items
    .filter((item) => item.category === category && !swiped.has(item.id) && !lib.has(item.id))
    .slice(0, limit)
    .map(
      (item, i) =>
        new Recommendation({
          item,
          score: 0.9 - i * 0.04,
          source,
          reasons: source === "calibration" ? ["Popular pick to calibrate your taste"] : reasonsFor(item, i),
          availableOn: source !== "calibration" && (item.category === "movie" || item.category === "tv") && i % 3 === 0
            ? mockProviders.filter((p) => (db.prefs.get(userId)?.watch.services ?? []).includes(p.id)).slice(0, 1)
            : []
        })
    )
}

const mockProviders = [
  [8, "Netflix"], [119, "Amazon Prime Video"], [337, "Disney Plus"], [1899, "Max"], [350, "Apple TV+"], [283, "Crunchyroll"]
].map(([id, name]) => new Provider({ id: ProviderId.make(id as number), name: name as string, logoUrl: null }))

const WatchLive = HttpApiBuilder.group(MagpieApi, "watch", (handlers) =>
  handlers.handleAll({
    regions: () =>
      Effect.succeed([["GB", "United Kingdom"], ["KE", "Kenya"], ["NG", "Nigeria"], ["US", "United States of America"]]
        .map(([code, name]) => new Region({ code: code!, name: name! }))),
    providers: () => Effect.succeed(mockProviders),
    options: ({ params }) =>
      Effect.sync(() => {
        const region = db.prefs.get(ME)?.watch.region ?? null
        const item = byId.get(params.itemId)
        if (region === null || !item || (item.category !== "movie" && item.category !== "tv")) return null
        return new WatchOptions({
          region,
          link: "https://www.themoviedb.org/",
          stream: mockProviders.slice(0, 2),
          free: [],
          rent: mockProviders.slice(4, 5),
          buy: mockProviders.slice(4, 5)
        })
      })
  })
)

const AuthLive = HttpApiBuilder.group(MagpieApi, "auth", (handlers) =>
  handlers.handleAll({
    invite: () => Effect.succeed(new InviteInfo({ forName: null })),
    registerOptions: () => Effect.succeed(new Challenge({ challengeId: "mock", options: {} })),
    register: () => Effect.sync(me),
    loginOptions: () => Effect.succeed(new Challenge({ challengeId: "mock", options: {} })),
    login: () => Effect.sync(me),
    logout: () => Effect.void
  })
)

const AuthenticationMock = Layer.succeed(Authentication)({
  session: (httpEffect) => Effect.provideService(httpEffect, CurrentUser, me())
})

const UsersLive = HttpApiBuilder.group(MagpieApi, "users", (handlers) =>
  handlers.handleAll({
    me: () => Effect.sync(me),
    passkeyOptions: () => Effect.succeed(new Challenge({ challengeId: "mock", options: {} })),
    addPasskey: () => Effect.void,
    list: () => Effect.sync(() => db.users),
    invite: ({ payload }) =>
      Effect.succeed(
        new Invite({
          token: crypto.randomUUID().replaceAll("-", ""),
          forName: db.users.find((u) => u.id === payload.forUserId)?.name ?? null,
          expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString()
        })
      ),
    preferences: () => Effect.sync(() => db.prefs.get(ME) ?? defaultPrefs(false)),
    setPreferences: ({ payload }) =>
      Effect.sync(() => {
        db.prefs.set(ME, payload)
        return payload
      })
  })
)

const DiscoverLive = HttpApiBuilder.group(MagpieApi, "discover", (handlers) =>
  handlers.handleAll({
    genres: ({ query }) =>
      Effect.sync(() => {
        const counts = new Map<string, number>()
        for (const item of items) {
          if (item.category !== query.category) continue
          for (const genre of item.genres) counts.set(genre, (counts.get(genre) ?? 0) + 1)
        }
        const extra = ["Documentary", "Animation", "Crime", "Western", "Musical"]
        extra.forEach((genre, i) => counts.set(genre, counts.get(genre) ?? 1 + i))
        return [...counts]
          .map(([genre, count]) => new GenreCount({ genre, count: count * 1375 + genre.length * 91 }))
          .sort((a, b) => b.count - a.count)
      }),
    calibration: ({ query }) => Effect.sync(() => recs(ME, query.category, query.limit ?? 5, "calibration")),
    deck: ({ query }) => Effect.sync(() => recs(ME, query.category, query.limit ?? 6, "similar")),
    feedback: ({ payload }) =>
      Effect.void.pipe(
        Effect.flatMap(() => (byId.has(payload.itemId) ? Effect.void : Effect.fail(new ItemNotFound()))),
        Effect.map(() => {
          swipedOf(ME).add(payload.itemId)
          const now = new Date().toISOString()
          if (payload.kind === "interested")
            libraryOf(ME).set(payload.itemId, { status: "want", rating: null, progress: null, updatedAt: now })
          if (payload.kind === "seen")
            libraryOf(ME).set(payload.itemId, {
              status: "finished",
              rating: payload.rating ?? null,
              progress: null,
              updatedAt: now
            })
        })
      ),
    searchFurther: ({ payload }) =>
      Effect.sync(() =>
        items.filter(
          (item) =>
            (item.synopsis ?? "").toLowerCase().includes(payload.q.toLowerCase()) &&
            (payload.category === undefined || item.category === payload.category)
        )
      ),
    creators: ({ query }) =>
      Effect.sync(() =>
        [...new Set(items.flatMap((i) => i.creators))]
          .filter((name) => name.toLowerCase().includes(query.q.toLowerCase()))
          .slice(0, 8)
          .map((name) => new CreatorHit({ name, role: "director", knownFor: items.find((i) => i.creators.includes(name))!.title }))
      ),
    search: ({ query }) =>
      Effect.sync(() =>
        items.filter(
          (item) =>
            item.title.toLowerCase().includes(query.q.toLowerCase()) &&
            (query.category === undefined || item.category === query.category)
        )
      )
  })
)

const LibraryLive = HttpApiBuilder.group(MagpieApi, "library", (handlers) =>
  handlers.handleAll({
    watchlist: ({ query }) =>
      Effect.void.pipe(
        Effect.map(() =>
          [...libraryOf(ME)]
            .flatMap(([id, entry]) => {
              const item = byId.get(id)
              return item ? [toUserItem(item, entry)] : []
            })
            .filter(
              (ui) =>
                ui.status !== null &&
                (query.status === undefined || ui.status === query.status) &&
                (query.category === undefined || ui.item.category === query.category)
            )
            .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        )
      ),
    update: ({ params, payload }) =>
      Effect.void.pipe(
        Effect.flatMap(() => {
          const item = byId.get(params.itemId)
          if (!item) return Effect.fail(new ItemNotFound())
          const lib = libraryOf(ME)
          const prev = lib.get(params.itemId) ?? { status: null, rating: null, progress: null, updatedAt: "" }
          const next: Entry = {
            status: payload.status === undefined ? prev.status : payload.status,
            rating: payload.rating === undefined ? prev.rating : payload.rating,
            progress: payload.progress === undefined ? prev.progress : payload.progress,
            updatedAt: new Date().toISOString()
          }
          lib.set(params.itemId, next)
          return Effect.succeed(toUserItem(item, next))
        })
      ),
    import: ({ payload }) =>
      Effect.void.pipe(
        Effect.map(() => {
          const lines = payload.content.split(/\r?\n/).filter((l) => l.trim() !== "")
          const total = Math.max(lines.length - 1, 12)
          const pick = (category: Category, n: number) => items.filter((i) => i.category === category).slice(n, n + 2)
          return new ImportResult({
            total,
            matched: total - 2,
            unmatched: [
              new UnmatchedRow({ title: "Solaris", year: null, rating: 4, status: "finished", candidates: pick("movie", 2) }),
              new UnmatchedRow({ title: "The Remains", year: 1989, rating: null, status: null, candidates: pick("book", 3) })
            ]
          })
        })
      )
  })
)

const { handler } = HttpRouter.toWebHandler(
  HttpApiBuilder.layer(MagpieApi).pipe(
    Layer.provide([AuthLive, UsersLive, DiscoverLive, LibraryLive, WatchLive]),
    Layer.provide(AuthenticationMock),
    Layer.provide(HttpServer.layerServices)
  ),
  { disableLogger: true }
)

const latency = () => new Promise((resolve) => setTimeout(resolve, 180 + Math.random() * 320))

export const mockFetch: typeof globalThis.fetch = async (input, init) => {
  await latency()
  return handler(new Request(input, init))
}
