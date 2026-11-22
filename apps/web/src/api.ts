import {
  Feedback,
  Filters,
  ImportRequest,
  ItemPatch,
  MagpieApi,
  Preferences,
  SearchFurther,
  type Category,
  type ImportSource,
  type ItemId,
  type Status,
  type UserId
} from "@magpie/contract"
import { startAuthentication, startRegistration, WebAuthnAbortService } from "@simplewebauthn/browser"
import { Cause, Effect, Exit, ManagedRuntime } from "effect"
import { FetchHttpClient } from "effect/http"
import { HttpApiClient } from "effect/http-api"

type Client = HttpApiClient.ForApi<typeof MagpieApi>

const fetchImpl: Promise<typeof globalThis.fetch> =
  import.meta.env.VITE_MOCK === "1"
    ? import("./mock").then((m) => m.mockFetch)
    : Promise.resolve(globalThis.fetch.bind(globalThis))

const runtime = ManagedRuntime.make(FetchHttpClient.layer)
let clientPromise: Promise<Client> | undefined
const getClient = () => (clientPromise ??= runtime.runPromise(HttpApiClient.make(MagpieApi, { baseUrl: "" })))

export type ApiErrorKind =
  | "Unauthenticated"
  | "NotAdmin"
  | "InviteInvalid"
  | "NameTaken"
  | "PasskeyRejected"
  | "PasskeyCancelled"
  | "ItemNotFound"
  | "ImportFailed"
  | "Network"
  | "Unexpected"

export class ApiError extends Error {
  constructor(
    readonly kind: ApiErrorKind,
    message: string
  ) {
    super(message)
  }
}

const toApiError = (cause: unknown): ApiError => {
  const tag = typeof cause === "object" && cause !== null && "_tag" in cause ? String(cause._tag) : ""
  switch (tag) {
    case "Unauthenticated":
      return new ApiError("Unauthenticated", "You've been signed out. Sign in again.")
    case "NotAdmin":
      return new ApiError("NotAdmin", "Only the person who runs this Magpie can do that.")
    case "InviteInvalid":
      return new ApiError("InviteInvalid", "This invite link has been used or has expired. Ask for a new one.")
    case "NameTaken":
      return new ApiError("NameTaken", "Someone here already goes by that name. Try another.")
    case "PasskeyRejected":
      return new ApiError("PasskeyRejected", (cause as { message?: string }).message ?? "That passkey didn't work.")
    case "ItemNotFound":
      return new ApiError("ItemNotFound", "That title is no longer in the catalogue.")
    case "ImportFailed":
      return new ApiError("ImportFailed", (cause as { message?: string }).message ?? "The import could not be read.")
    case "HttpClientError":
      return new ApiError("Network", "Can't reach the Magpie server. Check that the API is running, then try again.")
    default:
      return new ApiError("Unexpected", "The server sent a response Magpie doesn't understand.")
  }
}

export const SIGNED_OUT = "magpie:signed-out"

const call = async <A, E>(f: (client: Client) => Effect.Effect<A, E>): Promise<A> => {
  const [client, fetchFn] = await Promise.all([getClient(), fetchImpl])
  const exit = await runtime.runPromiseExit(f(client).pipe(Effect.provideService(FetchHttpClient.Fetch, fetchFn)))
  if (Exit.isSuccess(exit)) return exit.value
  const error = toApiError(Cause.squash(exit.cause))
  if (error.kind === "Unauthenticated") window.dispatchEvent(new Event(SIGNED_OUT))
  console.error(error.message, Cause.pretty(exit.cause))
  throw error
}

const writes = new Set<Promise<unknown>>()
const track = <A>(p: Promise<A>): Promise<A> => {
  writes.add(p)
  const done = () => writes.delete(p)
  p.then(done, done)
  return p
}

export type PreferencesInput = {
  readonly genres: Readonly<Record<string, ReadonlyArray<string>>>
  readonly dial: Readonly<Record<string, number>>
  readonly filters: Omit<Filters, never>
  readonly onboarded: boolean
}

const toPreferences = (p: PreferencesInput) =>
  new Preferences({ genres: p.genres, dial: p.dial, onboarded: p.onboarded, filters: new Filters({ ...p.filters }) })

const withLimit = (category: Category, limit: number | undefined) =>
  limit === undefined ? { category } : { category, limit }

const passkeyError = (e: unknown): ApiError =>
  e instanceof ApiError
    ? e
    : e instanceof Error && (e.name === "NotAllowedError" || e.name === "AbortError")
      ? new ApiError("PasskeyCancelled", "Passkey prompt closed. Try again when you're ready.")
      : e instanceof Error && e.name === "InvalidStateError"
      ? new ApiError("PasskeyRejected", "This device already has your Magpie passkey.")
      : new ApiError("PasskeyRejected", e instanceof Error ? e.message : "Your device couldn't create a passkey.")

export const passkeysSupported = () => typeof window !== "undefined" && "PublicKeyCredential" in window

export const api = {
  me: () => call((c) => c.users.me()),
  inviteInfo: (token: string) => call((c) => c.auth.invite({ params: { token } })),
  join: async (invite: string, name: string | undefined) => {
    try {
      const challenge = await call((c) => c.auth.registerOptions({ payload: name === undefined ? { invite } : { invite, name } }))
      const response = await startRegistration({ optionsJSON: challenge.options as never })
      return await call((c) => c.auth.register({ payload: { challengeId: challenge.challengeId, response } }))
    } catch (e) {
      throw passkeyError(e)
    }
  },
  signIn: async () => {
    try {
      WebAuthnAbortService.cancelCeremony()
      const challenge = await call((c) => c.auth.loginOptions())
      const response = await startAuthentication({ optionsJSON: challenge.options as never })
      return await call((c) => c.auth.login({ payload: { challengeId: challenge.challengeId, response } }))
    } catch (e) {
      throw passkeyError(e)
    }
  },
  signOut: () => call((c) => c.auth.logout()),
  addPasskey: async () => {
    try {
      const challenge = await call((c) => c.users.passkeyOptions())
      const response = await startRegistration({ optionsJSON: challenge.options as never })
      await call((c) => c.users.addPasskey({ payload: { challengeId: challenge.challengeId, response } }))
    } catch (e) {
      throw passkeyError(e)
    }
  },
  members: () => call((c) => c.users.list()),
  createInvite: (forUserId?: UserId) => call((c) => c.users.invite({ payload: forUserId === undefined ? {} : { forUserId } })),

  preferences: () => call((c) => c.users.preferences()),
  setPreferences: (prefs: PreferencesInput) => call((c) => c.users.setPreferences({ payload: toPreferences(prefs) })),

  genres: (category: Category) => call((c) => c.discover.genres({ query: { category } })),
  creators: (q: string) => call((c) => c.discover.creators({ query: { q } })),
  search: (q: string, category: Category | null) =>
    call((c) => c.discover.search({ query: category === null ? { q } : { q, category } })),
  searchFurther: (q: string, category: Category | null) =>
    call((c) => c.discover.searchFurther({ payload: new SearchFurther(category === null ? { q } : { q, category }) })),
  calibration: (category: Category, limit?: number) => call((c) => c.discover.calibration({ query: withLimit(category, limit) })),
  deck: (category: Category, limit?: number) => call((c) => c.discover.deck({ query: withLimit(category, limit) })),
  feedback: (itemId: ItemId, kind: Feedback["kind"], rating?: number) =>
    track(call((c) => c.discover.feedback({ payload: new Feedback(rating === undefined ? { itemId, kind } : { itemId, kind, rating }) }))),
  /** Resolves once every feedback write started so far has settled. */
  idle: () => Promise.allSettled([...writes]).then(() => undefined),

  watchlist: (filter: { status?: Status; category?: Category }) => call((c) => c.library.watchlist({ query: filter })),
  updateItem: (itemId: ItemId, patch: ConstructorParameters<typeof ItemPatch>[0]) =>
    call((c) => c.library.update({ params: { itemId }, payload: new ItemPatch(patch) })),
  importHistory: (source: ImportSource, content: string, filename?: string) =>
    call((c) =>
      c.library.import({
        params: { source },
        payload: new ImportRequest(filename === undefined ? { content } : { content, filename })
      })
    )
}
