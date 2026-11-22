import {
  Authentication,
  type Category,
  CreatorHit,
  CurrentUser,
  GenreCount,
  Item,
  MagpieApi,
  NotAdmin,
  SESSION_COOKIE,
  sessionSecurity,
  type User,
  UserNotFound
} from "@magpie/contract"
import { Effect, Layer, Redacted } from "effect"
import { HttpServerRequest } from "effect/http"
import { SqlClient } from "effect/sql"
import { HttpApiBuilder } from "effect/http-api"
import { Auth } from "./Auth.ts"
import { Imports } from "./Imports.ts"
import { ITEM_COLUMNS, type ItemRow, toItem } from "./Items.ts"
import { Library } from "./Library.ts"
import { Recommender } from "./Recommender.ts"
import { Users } from "./Users.ts"
import { Enrich } from "./Enrich.ts"

const SESSION_MAX_AGE = "400 days"

export const AuthenticationLive = Layer.effect(
  Authentication,
  Effect.gen(function*() {
    const auth = yield* Auth
    return Authentication.of({
      session: (httpEffect, { credential }) =>
        Effect.flatMap(auth.authenticate(Redacted.value(credential)), (user) =>
          Effect.provideService(httpEffect, CurrentUser, user))
    })
  })
).pipe(Layer.provide(Auth.layer))

const AuthHandlers = HttpApiBuilder.group(
  MagpieApi,
  "auth",
  Effect.fn(function*(handlers) {
    const auth = yield* Auth
    const setSession = (session: string) =>
      HttpApiBuilder.securitySetCookie(sessionSecurity, session, {
        path: "/",
        sameSite: "lax",
        secure: auth.secureCookie,
        maxAge: SESSION_MAX_AGE
      })
    const signedIn = <E>(effect: Effect.Effect<{ user: User; session: string }, E>) =>
      Effect.flatMap(effect, ({ user, session }) => Effect.as(setSession(session), user))
    return handlers.handleAll({
      invite: ({ params }) => auth.inviteInfo(params.token),
      registerOptions: ({ payload }) => auth.registerOptions(payload.invite, payload.name),
      register: ({ payload }) => signedIn(auth.register(payload.challengeId, payload.response)),
      loginOptions: () => auth.loginOptions,
      login: ({ payload }) => signedIn(auth.login(payload.challengeId, payload.response)),
      logout: () =>
        Effect.gen(function*() {
          const request = yield* HttpServerRequest.HttpServerRequest
          const session = request.cookies[SESSION_COOKIE]
          if (session) yield* auth.logout(session)
          yield* HttpApiBuilder.securitySetCookie(sessionSecurity, "", { path: "/", secure: auth.secureCookie, maxAge: 0 })
        })
    })
  })
)

const adminOnly = Effect.flatMap(Effect.service(CurrentUser), (user) => (user.isAdmin ? Effect.succeed(user) : Effect.fail(new NotAdmin())))

const mine = <A, E, R>(f: (me: User) => Effect.Effect<A, E, R>) =>
  Effect.flatMap(Effect.service(CurrentUser), f).pipe(
    Effect.catchIf((e): e is Extract<E, UserNotFound> => e instanceof UserNotFound, Effect.die)
  ) as Effect.Effect<A, Exclude<E, UserNotFound>, R | CurrentUser>

const clampLimit = (n: number | undefined, fallback: number) => Math.min(Math.max(n ?? fallback, 1), 100)

const UsersHandlers = HttpApiBuilder.group(
  MagpieApi,
  "users",
  Effect.fn(function*(handlers) {
    const users = yield* Users
    const auth = yield* Auth
    return handlers.handleAll({
      me: () => Effect.service(CurrentUser),
      preferences: () => mine((me) => users.preferences(me.id)),
      setPreferences: ({ payload }) => mine((me) => users.setPreferences(me.id, payload)),
      list: () => Effect.andThen(adminOnly, users.list),
      invite: ({ payload }) => Effect.flatMap(adminOnly, (me) => auth.createInvite(me, payload.forUserId)),
      passkeyOptions: () => Effect.flatMap(Effect.service(CurrentUser), (me) => auth.addPasskeyOptions(me)),
      addPasskey: ({ payload }) =>
        Effect.flatMap(Effect.service(CurrentUser), (me) => auth.addPasskey(me, payload.challengeId, payload.response))
    })
  })
)

const DiscoverHandlers = HttpApiBuilder.group(
  MagpieApi,
  "discover",
  Effect.fn(function*(handlers) {
    const sql = yield* SqlClient.SqlClient
    const recommender = yield* Recommender
    const library = yield* Library
    const users = yield* Users
    const enrich = yield* Enrich
    return handlers.handleAll({
      searchFurther: ({ payload }) =>
        mine((me) =>
          Effect.flatMap(users.preferences(me.id), (prefs) =>
            enrich.search(payload.q, (payload.category ?? null) as Category | null, prefs.filters.showMature)
          )
        ),
      genres: ({ query }) =>
        sql<{ genre: string; count: number }>`
          SELECT g AS genre, count(*)::int AS count
          FROM item, unnest(genres) g
          WHERE category = ${query.category}::category AND NOT is_adult
          GROUP BY g HAVING count(*) >= 20 ORDER BY count(*) DESC LIMIT 40`.pipe(
          Effect.map((rows) => rows.map((r) => new GenreCount(r))),
          Effect.orDie
        ),
      calibration: ({ query }) => mine((me) => recommender.calibration(me.id, query.category, clampLimit(query.limit, 30))),
      deck: ({ query }) => mine((me) => recommender.deck(me.id, query.category, clampLimit(query.limit, 20))),
      feedback: ({ payload }) => mine((me) => library.feedback(me.id, payload)),
      creators: ({ query }) => {
        const q = query.q.trim().toLowerCase()
        if (q.length < 3) return Effect.succeed([])
        return sql<{ name: string; role: string; known_for: string }>`
          SELECT name, role, known_for FROM (
            SELECT DISTINCT ON (lower(c.name)) c.name, ic.role, i.title AS known_for, i.popularity
            FROM creator c JOIN item_creator ic ON ic.creator_id = c.id JOIN item i ON i.id = ic.item_id
            WHERE lower(c.name) LIKE ${"%" + q.replace(/[\\%_]/g, (ch) => "\\" + ch) + "%"}
            ORDER BY lower(c.name), i.popularity DESC, ic.role = 'writer'
          ) hits
          ORDER BY popularity DESC LIMIT 8`.pipe(
          Effect.map((rows) => rows.map((r) => new CreatorHit({ name: r.name, role: r.role, knownFor: r.known_for }))),
          Effect.orDie
        )
      },
      search: ({ query }) =>
        mine((me) =>
          Effect.gen(function*() {
            const q = query.q.trim().toLowerCase()
            if (q === "") return []
            const prefs = yield* users.preferences(me.id)
            const category = (query.category ?? null) as Category | null
            const rows = q.length < 3
              ? yield* sql.unsafe<ItemRow>(
                `SELECT ${ITEM_COLUMNS} FROM item i
                 WHERE (lower(i.title) = $1 OR lower(i.original_title) = $1)
                   AND ($2::category IS NULL OR i.category = $2::category) AND ($3 OR NOT i.is_adult)
                 ORDER BY i.popularity DESC LIMIT 20`,
                [q, category, prefs.filters.showMature]
              )
              : yield* sql.unsafe<ItemRow>(
                `WITH hits AS (
                   SELECT id FROM item WHERE lower(title) LIKE $2
                   UNION SELECT id FROM item WHERE lower(original_title) LIKE $2
                   UNION SELECT id FROM item WHERE $1 <% lower(title)
                 )
                 SELECT ${ITEM_COLUMNS} FROM item i JOIN hits USING (id)
                 WHERE ($3::category IS NULL OR i.category = $3::category) AND ($4 OR NOT i.is_adult)
                 ORDER BY greatest(
                   CASE WHEN lower(i.title) = $1 OR lower(i.original_title) = $1 THEN 4
                        WHEN lower(i.title) LIKE $1 || '%' OR lower(i.original_title) LIKE $1 || '%' THEN 2
                        WHEN lower(i.title) LIKE '% ' || $1 || '%' OR lower(i.original_title) LIKE '% ' || $1 || '%' THEN 1.2
                        WHEN lower(i.title) LIKE $2 OR lower(i.original_title) LIKE $2 THEN 0.6
                        ELSE 0 END,
                   word_similarity($1, lower(i.title))
                 ) + i.popularity * 2 DESC
                 LIMIT 20`,
                [q, `%${q.replace(/[\\%_]/g, (ch) => "\\" + ch)}%`, category, prefs.filters.showMature]
              )
            return rows.map((r) => toItem(r, false))
          }).pipe(Effect.orDie)
        )
    })
  })
)

const LibraryHandlers = HttpApiBuilder.group(
  MagpieApi,
  "library",
  Effect.fn(function*(handlers) {
    const library = yield* Library
    const imports = yield* Imports
    return handlers.handleAll({
      watchlist: ({ query }) => mine((me) => library.watchlist(me.id, { status: query.status, category: query.category })),
      update: ({ params, payload }) => mine((me) => library.update(me.id, params.itemId, payload)),
      import: ({ params, payload }) => mine((me) => imports.run(me.id, params.source, payload.content, payload.filename))
    })
  })
)

const Services = Layer.mergeAll(
  Auth.layer,
  Users.layer,
  Recommender.layer,
  Enrich.layer,
  Imports.layer.pipe(Layer.provideMerge(Library.layer))
)

export const ApiLive = HttpApiBuilder.layer(MagpieApi, { openapiPath: "/api/openapi.json" }).pipe(
  Layer.provide([AuthHandlers, UsersHandlers, DiscoverHandlers, LibraryHandlers]),
  Layer.provide(Services)
)
