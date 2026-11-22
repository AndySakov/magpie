import {
  Challenge,
  Invite,
  InviteInfo,
  InviteInvalid,
  NameTaken,
  PasskeyRejected,
  Preferences,
  Unauthenticated,
  User,
  type UserId
} from "@magpie/contract"
import {
  type WebAuthnCredential,
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse
} from "@simplewebauthn/server"
import { Config, Context, Effect, Layer, Schema } from "effect"
import { SqlClient } from "effect/sql"
import { createHash, randomBytes, randomUUID } from "node:crypto"
import { defaultPreferences } from "./Users.ts"

const INVITE_DAYS = 7
const SESSION_DAYS = 90
const CHALLENGE_MINUTES = 5

export const hashToken = (token: string) => createHash("sha256").update(token).digest("hex")
const newToken = () => randomBytes(32).toString("base64url")
const asJson = (value: object): unknown => JSON.parse(JSON.stringify(value))

const encodePreferences = Schema.encodeSync(Preferences)

type UserRow = { id: string; name: string; is_admin: boolean }
const toUser = (r: UserRow) => new User({ id: r.id as UserId, name: r.name, isAdmin: r.is_admin })

export const AuthConfig = Config.all({
  rpId: Config.String("RP_ID").pipe(Config.withDefault("localhost")),
  origin: Config.String("ORIGIN").pipe(Config.withDefault("http://localhost:5173"))
})

export const insertInvite = (
  sql: SqlClient.SqlClient,
  opts: { readonly forUserId?: string | undefined; readonly isAdmin: boolean; readonly createdBy: string | null }
) =>
  Effect.gen(function*() {
    const token = newToken()
    const [row] = yield* sql<{ expires_at: Date; for_name: string | null }>`
      INSERT INTO invite (token_hash, user_id, is_admin, created_by, expires_at)
      VALUES (${hashToken(token)}, ${opts.forUserId ?? null}::uuid, ${opts.isAdmin}, ${opts.createdBy}::uuid,
              now() + make_interval(days => ${INVITE_DAYS}))
      RETURNING expires_at, (SELECT name FROM app_user WHERE id = invite.user_id) AS for_name`
    return new Invite({ token, forName: row!.for_name, expiresAt: new Date(row!.expires_at).toISOString() })
  })

export class Auth extends Context.Service<Auth, {
  inviteInfo(token: string): Effect.Effect<InviteInfo, InviteInvalid>
  registerOptions(token: string, name: string | undefined): Effect.Effect<Challenge, InviteInvalid | NameTaken>
  register(challengeId: string, response: unknown): Effect.Effect<{ user: User; session: string }, InviteInvalid | NameTaken | PasskeyRejected>
  readonly loginOptions: Effect.Effect<Challenge>
  login(challengeId: string, response: unknown): Effect.Effect<{ user: User; session: string }, PasskeyRejected>
  logout(session: string): Effect.Effect<void>
  authenticate(session: string): Effect.Effect<User, Unauthenticated>
  createInvite(createdBy: User, forUserId: UserId | undefined): Effect.Effect<Invite>
  addPasskeyOptions(user: User): Effect.Effect<Challenge>
  addPasskey(user: User, challengeId: string, response: unknown): Effect.Effect<void, PasskeyRejected>
  readonly secureCookie: boolean
}>()("magpie/Auth") {
  static readonly layer = Layer.effect(
    Auth,
    Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient
      const { rpId, origin } = yield* AuthConfig

      const openInvite = (token: string) =>
        sql<{ user_id: string | null; for_name: string | null }>`
          SELECT i.user_id::text, u.name AS for_name FROM invite i LEFT JOIN app_user u ON u.id = i.user_id
          WHERE i.token_hash = ${hashToken(token)} AND i.used_at IS NULL AND i.expires_at > now()`.pipe(
          Effect.orDie,
          Effect.flatMap((rows) => (rows[0] ? Effect.succeed(rows[0]) : Effect.fail(new InviteInvalid())))
        )

      const nameTaken = (name: string) =>
        sql<{ n: number }>`SELECT 1 AS n FROM app_user WHERE lower(name) = lower(${name})`.pipe(
          Effect.orDie,
          Effect.map((rows) => rows.length > 0)
        )

      const storeChallenge = (
        challenge: string,
        extra: { invite: string | null; userId: string; name: string | null } | null
      ) =>
        sql`DELETE FROM auth_challenge WHERE expires_at < now()`.pipe(Effect.andThen(sql<{ id: string }>`
          INSERT INTO auth_challenge (challenge, invite_hash, user_id, name, expires_at)
          VALUES (${challenge}, ${extra?.invite ? hashToken(extra.invite) : null}, ${extra?.userId ?? null}::uuid, ${extra?.name ?? null},
                  now() + make_interval(mins => ${CHALLENGE_MINUTES}))
          RETURNING id::text`), Effect.orDie, Effect.map((rows) => rows[0]!.id))

      const startSession = (userId: string) =>
        Effect.gen(function*() {
          const session = newToken()
          yield* sql`
            INSERT INTO session (token_hash, user_id, expires_at)
            VALUES (${hashToken(session)}, ${userId}::uuid, now() + make_interval(days => ${SESSION_DAYS}))`
          return session
        })

      const creationOptions = (userId: string, userName: string) =>
        Effect.gen(function*() {
          const existing = yield* sql<{ id: string; transports: Array<string> }>`
            SELECT id, transports FROM passkey WHERE user_id = ${userId}::uuid`.pipe(Effect.orDie)
          return yield* Effect.promise(() =>
            generateRegistrationOptions({
              rpName: "Magpie",
              rpID: rpId,
              userName,
              userID: new TextEncoder().encode(userId),
              attestationType: "none",
              excludeCredentials: existing.map((p) => ({ id: p.id, transports: p.transports })),
              authenticatorSelection: { residentKey: "required", userVerification: "preferred" }
            })
          )
        })

      const verifyCreation = (challenge: string, response: unknown) =>
        Effect.tryPromise({
          try: () =>
            verifyRegistrationResponse({
              response: response as never,
              expectedChallenge: challenge,
              expectedOrigin: origin,
              expectedRPID: rpId,
              requireUserVerification: false
            }),
          catch: (e) => new PasskeyRejected({ message: (e as Error).message })
        }).pipe(
          Effect.flatMap((v) =>
            v.verified
              ? Effect.succeed(v.registrationInfo.credential)
              : Effect.fail(new PasskeyRejected({ message: "The passkey could not be verified." }))
          )
        )

      const insertPasskey = (userId: string, credential: WebAuthnCredential) =>
        sql<{ id: string }>`
          INSERT INTO passkey (id, user_id, public_key, counter, transports)
          VALUES (${credential.id}, ${userId}::uuid, ${Buffer.from(credential.publicKey).toString("base64url")},
                  ${credential.counter}, ${credential.transports ?? []})
          ON CONFLICT (id) DO NOTHING
          RETURNING id`.pipe(
          Effect.orDie,
          Effect.flatMap((rows) =>
            rows.length > 0 ? Effect.void : Effect.fail(new PasskeyRejected({ message: "This passkey is already saved in Magpie." }))
          )
        )

      const inviteInfo = Effect.fn("Auth.inviteInfo")(function*(token: string) {
        const invite = yield* openInvite(token)
        return new InviteInfo({ forName: invite.for_name })
      })

      const registerOptions = Effect.fn("Auth.registerOptions")(function*(token: string, name: string | undefined) {
        const invite = yield* openInvite(token)
        const userId = invite.user_id ?? randomUUID()
        const userName = invite.for_name ?? name
        if (userName === undefined) return yield* new NameTaken()
        if (invite.user_id === null && (yield* nameTaken(userName))) return yield* new NameTaken()
        const options = yield* creationOptions(userId, userName)
        const challengeId = yield* storeChallenge(options.challenge, {
          invite: token,
          userId,
          name: invite.user_id === null ? userName : null
        })
        return new Challenge({ challengeId, options: asJson(options) })
      })

      const register = Effect.fn("Auth.register")(function*(challengeId: string, response: unknown) {
        const [pending] = yield* sql<{ challenge: string; invite_hash: string; user_id: string; name: string | null }>`
          DELETE FROM auth_challenge
          WHERE id::text = ${challengeId} AND invite_hash IS NOT NULL AND expires_at > now()
          RETURNING challenge, invite_hash, user_id::text, name`.pipe(Effect.orDie)
        if (!pending) return yield* new PasskeyRejected({ message: "This sign-up attempt expired. Start again." })
        const credential = yield* verifyCreation(pending.challenge, response)

        return yield* Effect.gen(function*() {
          const [invite] = yield* sql<{ user_id: string | null; is_admin: boolean }>`
            UPDATE invite SET used_at = now()
            WHERE token_hash = ${pending.invite_hash} AND used_at IS NULL AND expires_at > now()
            RETURNING user_id::text, is_admin`.pipe(Effect.orDie)
          if (!invite) return yield* new InviteInvalid()
          const [user] = invite.user_id === null
            ? yield* sql<UserRow>`
                INSERT INTO app_user (id, name, preferences, is_admin)
                VALUES (${pending.user_id}::uuid, ${pending.name}, ${JSON.stringify(encodePreferences(defaultPreferences))}::jsonb,
                        ${invite.is_admin})
                ON CONFLICT (name) DO NOTHING
                RETURNING id::text, name, is_admin`.pipe(Effect.orDie)
            : yield* sql<UserRow>`
                UPDATE app_user SET is_admin = is_admin OR ${invite.is_admin} WHERE id = ${invite.user_id}::uuid
                RETURNING id::text, name, is_admin`.pipe(Effect.orDie)
          if (!user) return yield* new NameTaken()
          yield* insertPasskey(user.id, credential)
          const session = yield* startSession(user.id).pipe(Effect.orDie)
          return { user: toUser(user), session }
        }).pipe(sql.withTransaction, Effect.catchTag("SqlError", Effect.die))
      })

      const loginOptions = Effect.gen(function*() {
        const options = yield* Effect.promise(() => generateAuthenticationOptions({ rpID: rpId, userVerification: "preferred" }))
        const challengeId = yield* storeChallenge(options.challenge, null)
        return new Challenge({ challengeId, options: asJson(options) })
      })

      const login = Effect.fn("Auth.login")(function*(challengeId: string, response: unknown) {
        const [pending] = yield* sql<{ challenge: string }>`
          DELETE FROM auth_challenge
          WHERE id::text = ${challengeId} AND invite_hash IS NULL AND user_id IS NULL AND expires_at > now()
          RETURNING challenge`.pipe(Effect.orDie)
        if (!pending) return yield* new PasskeyRejected({ message: "This sign-in attempt expired. Try again." })
        const credentialId = typeof response === "object" && response !== null && "id" in response ? String(response.id) : ""
        const [passkey] = yield* sql<{ id: string; user_id: string; public_key: string; counter: string; transports: Array<string> }>`
          SELECT id, user_id::text, public_key, counter::text, transports FROM passkey WHERE id = ${credentialId}`.pipe(Effect.orDie)
        if (!passkey) return yield* new PasskeyRejected({ message: "Magpie doesn't know this passkey. Ask for a new invite link." })
        const verification = yield* Effect.tryPromise({
          try: () =>
            verifyAuthenticationResponse({
              response: response as never,
              expectedChallenge: pending.challenge,
              expectedOrigin: origin,
              expectedRPID: rpId,
              requireUserVerification: false,
              credential: {
                id: passkey.id,
                publicKey: new Uint8Array(Buffer.from(passkey.public_key, "base64url")),
                counter: Number(passkey.counter),
                transports: passkey.transports
              }
            }),
          catch: (e) => new PasskeyRejected({ message: (e as Error).message })
        })
        if (!verification.verified) return yield* new PasskeyRejected({ message: "The passkey could not be verified." })
        yield* sql`
          UPDATE passkey SET counter = ${verification.authenticationInfo.newCounter}, last_used_at = now()
          WHERE id = ${passkey.id}`.pipe(Effect.orDie)
        const [user] = yield* sql<UserRow>`
          SELECT id::text, name, is_admin FROM app_user WHERE id = ${passkey.user_id}::uuid`.pipe(Effect.orDie)
        const session = yield* startSession(passkey.user_id).pipe(Effect.orDie)
        return { user: toUser(user!), session }
      })

      const logout = (session: string) =>
        sql`DELETE FROM session WHERE token_hash = ${hashToken(session)}`.pipe(Effect.orDie, Effect.asVoid)

      const authenticate = (session: string) =>
        session === ""
          ? Effect.fail(new Unauthenticated())
          : sql<UserRow>`
              UPDATE session s SET expires_at = now() + make_interval(days => ${SESSION_DAYS})
              FROM app_user u
              WHERE s.token_hash = ${hashToken(session)} AND s.expires_at > now() AND u.id = s.user_id
              RETURNING u.id::text, u.name, u.is_admin`.pipe(
              Effect.orDie,
              Effect.flatMap((rows) => (rows[0] ? Effect.succeed(toUser(rows[0])) : Effect.fail(new Unauthenticated())))
            )

      const createInvite = (createdBy: User, forUserId: UserId | undefined) =>
        insertInvite(sql, { forUserId, isAdmin: false, createdBy: createdBy.id }).pipe(Effect.orDie)

      const addPasskeyOptions = (user: User) =>
        Effect.gen(function*() {
          const options = yield* creationOptions(user.id, user.name)
          const challengeId = yield* storeChallenge(options.challenge, { invite: null, userId: user.id, name: null })
          return new Challenge({ challengeId, options: asJson(options) })
        })

      const addPasskey = Effect.fn("Auth.addPasskey")(function*(user: User, challengeId: string, response: unknown) {
        const [pending] = yield* sql<{ challenge: string }>`
          DELETE FROM auth_challenge
          WHERE id::text = ${challengeId} AND invite_hash IS NULL AND user_id = ${user.id}::uuid AND expires_at > now()
          RETURNING challenge`.pipe(Effect.orDie)
        if (!pending) return yield* new PasskeyRejected({ message: "This attempt expired. Try again." })
        const credential = yield* verifyCreation(pending.challenge, response)
        yield* insertPasskey(user.id, credential)
      })

      return Auth.of({
        inviteInfo,
        registerOptions,
        register,
        loginOptions,
        login,
        logout,
        authenticate,
        createInvite,
        addPasskeyOptions,
        addPasskey,
        secureCookie: origin.startsWith("https://")
      })
    })
  )
}
