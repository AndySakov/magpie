import { Config, Context, Data, Effect, Layer, Option, Schema } from "effect"

export class TraktError extends Data.TaggedError("TraktError")<{ readonly message: string; readonly status?: number }> {}

const AUTH = "https://auth.trakt.tv"
const API = "https://api.trakt.tv"
// Trakt caps page sizes per endpoint (often 250) and clamps larger values.
const PAGE_SIZE = 250

const Tokens = Schema.Struct({
  access_token: Schema.String,
  refresh_token: Schema.String,
  expires_in: Schema.Number,
  created_at: Schema.Number
})
/** Trakt requests spent in one run. A request past `limit` fails instead of being sent. */
export class Meter {
  spent = 0
  constructor(readonly limit: number) {}
  readonly take: Effect.Effect<void, TraktError> = Effect.suspend(() => {
    if (this.spent >= this.limit) return Effect.fail(new TraktError({ message: "Stopped at the Trakt request budget for this run" }))
    this.spent++
    return Effect.void
  })
}

export interface Tokens {
  readonly accessToken: string
  readonly refreshToken: string
  readonly expiresAt: Date
}

export class TraktApi extends Context.Service<TraktApi, {
  /** False when TRAKT_CLIENT_ID is unset: the integration is hidden rather than failing. */
  readonly configured: boolean
  readonly redirectUri: string
  authorizeUrl(state: string, challenge: string): string
  exchange(code: string, verifier: string, meter: Meter): Effect.Effect<Tokens, TraktError>
  refresh(refreshToken: string, meter: Meter): Effect.Effect<Tokens, TraktError>
  revoke(accessToken: string): Effect.Effect<void, TraktError>
  /** One GET, or every page of a paginated endpoint, each charged to `meter`. */
  get(path: string, accessToken: string, meter: Meter, opts?: { readonly paginated?: boolean }): Effect.Effect<unknown, TraktError>
}>()("magpie/TraktApi") {
  static readonly layer = Layer.effect(
    TraktApi,
    Effect.gen(function*() {
      const clientId = Option.getOrElse(yield* Config.option(Config.String("TRAKT_CLIENT_ID")), () => "").trim()
      const origin = yield* Config.String("ORIGIN").pipe(Config.withDefault("http://localhost:5173"))
      const redirectUri = `${origin}/trakt/callback`

      const request = (url: string, init: RequestInit) =>
        Effect.tryPromise({
          try: async () => {
            const r = await fetch(url, { ...init, signal: AbortSignal.timeout(15_000) })
            const text = await r.text()
            if (!r.ok) throw new TraktError({ message: `Trakt ${r.status} on ${new URL(url).pathname}`, status: r.status })
            return { body: text ? (JSON.parse(text) as unknown) : null, headers: r.headers }
          },
          catch: (e) => (e instanceof TraktError ? e : new TraktError({ message: `Could not reach Trakt: ${e instanceof Error ? e.message : String(e)}` }))
        })

      const json = { "content-type": "application/json", "user-agent": "Magpie/1.0" }

      const token = (meter: Meter, body: Record<string, string>) =>
        meter.take.pipe(
          Effect.andThen(request(`${AUTH}/oauth/token`, { method: "POST", headers: json, body: JSON.stringify({ client_id: clientId, redirect_uri: redirectUri, ...body }) })),
          Effect.flatMap((r) => Schema.decodeUnknownEffect(Tokens)(r.body)),
          Effect.map((t): Tokens => ({
            accessToken: t.access_token,
            refreshToken: t.refresh_token,
            expiresAt: new Date((t.created_at + t.expires_in) * 1000)
          })),
          Effect.mapError((e) => (e instanceof TraktError ? e : new TraktError({ message: "Unexpected token response from Trakt" })))
        )

      const get = (path: string, accessToken: string, meter: Meter, opts?: { readonly paginated?: boolean }) =>
        Effect.gen(function*() {
          const headers = { ...json, "trakt-api-version": "2", "trakt-api-key": clientId, authorization: `Bearer ${accessToken}` }
          if (!opts?.paginated) {
            yield* meter.take
            return (yield* request(`${API}${path}`, { headers })).body
          }
          const items: Array<unknown> = []
          let page = 1
          let pages = 1
          do {
            const sep = path.includes("?") ? "&" : "?"
            yield* meter.take
            const r = yield* request(`${API}${path}${sep}page=${page}&limit=${PAGE_SIZE}`, { headers })
            if (Array.isArray(r.body)) items.push(...r.body)
            pages = Number(r.headers.get("x-pagination-page-count") ?? "1") || 1
            page++
          } while (page <= pages)
          return items
        })

      return TraktApi.of({
        configured: clientId !== "",
        redirectUri,
        authorizeUrl: (state, challenge) =>
          `${AUTH}/oauth/authorize?${new URLSearchParams({
            response_type: "code",
            client_id: clientId,
            redirect_uri: redirectUri,
            state,
            code_challenge: challenge,
            code_challenge_method: "S256"
          })}`,
        exchange: (code, verifier, meter) => token(meter, { code, code_verifier: verifier, grant_type: "authorization_code" }),
        refresh: (refreshToken, meter) => token(meter, { refresh_token: refreshToken, grant_type: "refresh_token" }),
        revoke: (accessToken) =>
          request(`${AUTH}/oauth/revoke`, { method: "POST", headers: json, body: JSON.stringify({ token: accessToken, client_id: clientId }) }).pipe(Effect.asVoid),
        get
      })
    })
  )
}
