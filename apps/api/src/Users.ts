import { Filters, Preferences, PreferencesUpdate, User, type UserId, UserNotFound, WatchSetup } from "@magpie/contract"
import { Context, Effect, Layer, Schema } from "effect"
import { SqlClient } from "effect/sql"

export const defaultPreferences = new Preferences({
  genres: {},
  dial: {},
  filters: new Filters({
    showMature: false,
    languages: [],
    maxMinutes: null,
    maxEpisodes: null,
    maxPages: null,
    blockedGenres: [],
    blockedCreators: []
  }),
  watch: new WatchSetup({ region: null, services: [], onlyMine: false }),
  onboarded: false
})

const decodePreferences = Schema.decodeUnknownSync(Preferences)
const encodePreferences = Schema.encodeSync(Preferences)
const encodeUpdate = Schema.encodeSync(PreferencesUpdate)

export class Users extends Context.Service<Users, {
  readonly list: Effect.Effect<ReadonlyArray<User>>
  preferences(id: UserId): Effect.Effect<Preferences, UserNotFound>
  setPreferences(id: UserId, prefs: PreferencesUpdate): Effect.Effect<Preferences, UserNotFound>
}>()("magpie/Users") {
  static readonly layer = Layer.effect(
    Users,
    Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient

      const list = sql<{ id: string; name: string; is_admin: boolean }>`
        SELECT id::text, name, is_admin FROM app_user ORDER BY created_at`.pipe(
        Effect.map((rows) => rows.map((r) => new User({ id: r.id as UserId, name: r.name, isAdmin: r.is_admin }))),
        Effect.orDie
      )

      const preferences = Effect.fn("Users.preferences")(function*(id: UserId) {
        const rows = yield* sql<{ preferences: unknown }>`SELECT preferences FROM app_user WHERE id::text = ${id}`.pipe(Effect.orDie)
        if (rows.length === 0) return yield* new UserNotFound()
        return decodePreferences({ ...encodePreferences(defaultPreferences), ...(rows[0]!.preferences as object) })
      })

      const setPreferences = Effect.fn("Users.setPreferences")(function*(id: UserId, prefs: PreferencesUpdate) {
        const keep = prefs.watch === undefined
        const rows = yield* sql<{ id: string }>`
          UPDATE app_user SET preferences = ${JSON.stringify(encodeUpdate(prefs))}::jsonb
            || CASE WHEN ${keep} AND preferences ? 'watch' THEN jsonb_build_object('watch', preferences->'watch') ELSE '{}'::jsonb END
          WHERE id::text = ${id} RETURNING id::text`.pipe(Effect.orDie)
        if (rows.length === 0) return yield* new UserNotFound()
        return yield* preferences(id)
      })

      return Users.of({ list, preferences, setPreferences })
    })
  )
}
