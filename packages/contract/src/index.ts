import { Context, Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiMiddleware, HttpApiSchema, HttpApiSecurity } from "effect/http-api"

export const Category = Schema.Literals(["movie", "tv", "anime", "book"])
export type Category = typeof Category.Type
export const CATEGORIES: ReadonlyArray<Category> = ["movie", "tv", "anime", "book"]

export const ItemId = Schema.Number.pipe(Schema.brand("ItemId"))
export type ItemId = typeof ItemId.Type

export const Stars = Schema.Finite.check(Schema.isBetween({ minimum: 0.5, maximum: 5 }), Schema.isMultipleOf(0.5))

export const UserId = Schema.String.pipe(Schema.brand("UserId"))
export type UserId = typeof UserId.Type

export const Status = Schema.Literals(["want", "in_progress", "finished", "dropped"])
export type Status = typeof Status.Type

export class Item extends Schema.Class<Item>("Item")({
  id: ItemId,
  category: Category,
  title: Schema.String,
  year: Schema.NullOr(Schema.Number),
  synopsis: Schema.NullOr(Schema.String),
  genres: Schema.Array(Schema.String),
  tags: Schema.Array(Schema.String),
  creators: Schema.Array(Schema.String),
  imageUrl: Schema.NullOr(Schema.String),
  backdropUrl: Schema.NullOr(Schema.String),
  trailerYoutubeId: Schema.NullOr(Schema.String),
  lengthValue: Schema.NullOr(Schema.Number),
  lengthUnit: Schema.NullOr(Schema.Literals(["minutes", "episodes", "pages"])),
  language: Schema.NullOr(Schema.String),
  // Public score 0-100. Null until the user has rated the item, to avoid anchoring.
  publicScore: Schema.NullOr(Schema.Number)
}) {}

export const ReasonSource = Schema.Literals(["similar", "neighbours", "link", "explore", "calibration"])

export const ProviderId = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 2_147_483_647 })).pipe(Schema.brand("ProviderId"))
export type ProviderId = typeof ProviderId.Type

export class Provider extends Schema.Class<Provider>("Provider")({
  id: ProviderId,
  name: Schema.String,
  logoUrl: Schema.NullOr(Schema.String)
}) {}

export class Recommendation extends Schema.Class<Recommendation>("Recommendation")({
  item: Item,
  score: Schema.Number,
  source: ReasonSource,
  reasons: Schema.Array(Schema.String),
  // The user's own streaming services that carry this item in their region.
  availableOn: Schema.Array(Provider)
}) {}

export class UserItem extends Schema.Class<UserItem>("UserItem")({
  item: Item,
  status: Schema.NullOr(Status),
  // 1-5 stars, or null. Thumbs up/down are stored as 4/2.
  rating: Schema.NullOr(Schema.Number),
  progress: Schema.NullOr(Schema.Number),
  updatedAt: Schema.String
}) {}

export class User extends Schema.Class<User>("User")({
  id: UserId,
  name: Schema.String,
  isAdmin: Schema.Boolean
}) {}

export const LanguageCode = Schema.String.check(Schema.isPattern(/^[a-z]{2,3}$/))

export class Filters extends Schema.Class<Filters>("Filters")({
  showMature: Schema.Boolean,
  languages: Schema.Array(LanguageCode).check(Schema.isMaxLength(2), Schema.isUnique()),
  maxMinutes: Schema.NullOr(Schema.Number),
  maxEpisodes: Schema.NullOr(Schema.Number),
  maxPages: Schema.NullOr(Schema.Number),
  blockedGenres: Schema.Array(Schema.String),
  blockedCreators: Schema.Array(Schema.String)
}) {}

export const RegionCode = Schema.String.check(Schema.isPattern(/^[A-Z]{2}$/))

export class WatchSetup extends Schema.Class<WatchSetup>("WatchSetup")({
  region: Schema.NullOr(RegionCode),
  services: Schema.Array(ProviderId).check(Schema.isMaxLength(30), Schema.isUnique()),
  // Movies and TV in the deck must stream on one of `services` in `region`.
  onlyMine: Schema.Boolean
}) {}

export class Preferences extends Schema.Class<Preferences>("Preferences")({
  genres: Schema.Record(Schema.String, Schema.Array(Schema.String)),
  // 0 = more of what I love, 1 = surprise me. Keyed by category.
  dial: Schema.Record(Schema.String, Schema.Number),
  filters: Filters,
  watch: WatchSetup,
  onboarded: Schema.Boolean
}) {}

// App copies built before `watch` existed still save without it. The stored value is then kept.
export const PreferencesUpdate = Schema.Struct({ ...Preferences.fields, watch: Schema.optionalKey(WatchSetup) })
export type PreferencesUpdate = typeof PreferencesUpdate.Type

export const FeedbackKind = Schema.Literals(["interested", "not_interested", "seen"])

export class Feedback extends Schema.Class<Feedback>("Feedback")({
  itemId: ItemId,
  kind: FeedbackKind,
  // For "seen": 0.5-5 stars in half steps, or thumbs as 4 (up) / 2 (down).
  rating: Schema.optional(Stars)
}) {}

export class ItemPatch extends Schema.Class<ItemPatch>("ItemPatch")({
  status: Schema.optional(Schema.NullOr(Status)),
  rating: Schema.optional(Schema.NullOr(Stars)),
  progress: Schema.optional(Schema.NullOr(Schema.Number))
}) {}

export const ImportSource = Schema.Literals(["letterboxd", "imdb", "goodreads", "mal", "anilist"])
export type ImportSource = typeof ImportSource.Type

export class ImportRequest extends Schema.Class<ImportRequest>("ImportRequest")({
  // File contents for CSV/XML sources, or the username for anilist.
  content: Schema.String,
  // Original file name. Letterboxd's watched.csv and watchlist.csv share headers; the name tells them apart.
  filename: Schema.optional(Schema.String)
}) {}

export class UnmatchedRow extends Schema.Class<UnmatchedRow>("UnmatchedRow")({
  title: Schema.String,
  year: Schema.NullOr(Schema.Number),
  rating: Schema.NullOr(Schema.Number),
  status: Schema.NullOr(Status),
  candidates: Schema.Array(Item)
}) {}

export class ImportResult extends Schema.Class<ImportResult>("ImportResult")({
  total: Schema.Number,
  matched: Schema.Number,
  unmatched: Schema.Array(UnmatchedRow)
}) {}

export class GenreCount extends Schema.Class<GenreCount>("GenreCount")({
  genre: Schema.String,
  count: Schema.Number
}) {}

export class CreatorHit extends Schema.Class<CreatorHit>("CreatorHit")({
  name: Schema.String,
  role: Schema.String,
  knownFor: Schema.String
}) {}

export class Region extends Schema.Class<Region>("Region")({
  code: RegionCode,
  name: Schema.String
}) {}

export class WatchOptions extends Schema.Class<WatchOptions>("WatchOptions")({
  region: RegionCode,
  // TMDB's watch page for the title. JustWatch's terms require linking to it rather than to providers directly.
  link: Schema.NullOr(Schema.String),
  stream: Schema.Array(Provider),
  free: Schema.Array(Provider),
  rent: Schema.Array(Provider),
  buy: Schema.Array(Provider)
}) {}

export class TraktStatus extends Schema.Class<TraktStatus>("TraktStatus")({
  // False when this Magpie has no Trakt app configured.
  configured: Schema.Boolean,
  connected: Schema.Boolean,
  username: Schema.NullOr(Schema.String),
  syncedAt: Schema.NullOr(Schema.String)
}) {}

export class UserNotFound extends Schema.TaggedError<UserNotFound>()("UserNotFound", {}) {}
export class ItemNotFound extends Schema.TaggedError<ItemNotFound>()("ItemNotFound", {}) {}
export class ImportFailed extends Schema.TaggedError<ImportFailed>()("ImportFailed", { message: Schema.String }) {}
export class TraktFailed extends Schema.TaggedError<TraktFailed>()("TraktFailed", { message: Schema.String }) {}
export class Unauthenticated extends Schema.TaggedError<Unauthenticated>()("Unauthenticated", {}) {}
export class NotAdmin extends Schema.TaggedError<NotAdmin>()("NotAdmin", {}) {}
export class InviteInvalid extends Schema.TaggedError<InviteInvalid>()("InviteInvalid", {}) {}
export class NameTaken extends Schema.TaggedError<NameTaken>()("NameTaken", {}) {}
export class PasskeyRejected extends Schema.TaggedError<PasskeyRejected>()("PasskeyRejected", { message: Schema.String }) {}

export class CurrentUser extends Context.Service<CurrentUser, User>()("magpie/CurrentUser") {}

export const SESSION_COOKIE = "magpie_session"
export const sessionSecurity = HttpApiSecurity.apiKey({ key: SESSION_COOKIE, in: "cookie" })

export class Authentication extends HttpApiMiddleware.Service<Authentication, { provides: CurrentUser }>()(
  "magpie/Authentication",
  { error: Unauthenticated.pipe(HttpApiSchema.status(401)), security: { session: sessionSecurity } }
) {}

export class Challenge extends Schema.Class<Challenge>("Challenge")({
  challengeId: Schema.String,
  options: Schema.Unknown
}) {}

export class InviteInfo extends Schema.Class<InviteInfo>("InviteInfo")({
  forName: Schema.NullOr(Schema.String)
}) {}

export class Invite extends Schema.Class<Invite>("Invite")({
  token: Schema.String,
  forName: Schema.NullOr(Schema.String),
  expiresAt: Schema.String
}) {}

export const DisplayName = Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(40))

const InviteGone = InviteInvalid.pipe(HttpApiSchema.status(404))
const Taken = NameTaken.pipe(HttpApiSchema.status(409))
const Rejected = PasskeyRejected.pipe(HttpApiSchema.status(400))
const AdminOnly = NotAdmin.pipe(HttpApiSchema.status(403))
const MissingItem = ItemNotFound.pipe(HttpApiSchema.status(404))
const Answer = Schema.Struct({ challengeId: Schema.String, response: Schema.Unknown })

export class AuthGroup extends HttpApiGroup.make("auth")
  .add(
    HttpApiEndpoint.post("invite", "/auth/invites/lookup", {
      payload: Schema.Struct({ token: Schema.String }),
      success: InviteInfo,
      error: InviteGone
    }),
    HttpApiEndpoint.post("registerOptions", "/auth/register/options", {
      payload: Schema.Struct({ invite: Schema.String, name: Schema.optional(DisplayName) }),
      success: Challenge,
      error: [InviteGone, Taken]
    }),
    HttpApiEndpoint.post("register", "/auth/register", { payload: Answer, success: User, error: [InviteGone, Taken, Rejected] }),
    HttpApiEndpoint.post("loginOptions", "/auth/login/options", { success: Challenge }),
    HttpApiEndpoint.post("login", "/auth/login", { payload: Answer, success: User, error: Rejected }),
    HttpApiEndpoint.post("logout", "/auth/logout", { success: Schema.Void })
  ) {}

export class UsersGroup extends HttpApiGroup.make("users")
  .add(
    HttpApiEndpoint.get("me", "/me", { success: User }),
    HttpApiEndpoint.get("preferences", "/me/preferences", { success: Preferences }),
    HttpApiEndpoint.put("setPreferences", "/me/preferences", { payload: PreferencesUpdate, success: Preferences }),
    HttpApiEndpoint.get("list", "/users", { success: Schema.Array(User), error: AdminOnly }),
    HttpApiEndpoint.post("passkeyOptions", "/me/passkeys/options", { success: Challenge }),
    HttpApiEndpoint.post("addPasskey", "/me/passkeys", { payload: Answer, success: Schema.Void, error: Rejected }),
    HttpApiEndpoint.post("invite", "/invites", {
      payload: Schema.Struct({ forUserId: Schema.optional(UserId) }),
      success: Invite,
      error: AdminOnly
    })
  )
  .middleware(Authentication) {}

export class SearchFurther extends Schema.Class<SearchFurther>("SearchFurther")({
  q: Schema.Trim.check(Schema.isMinLength(3), Schema.isMaxLength(100)),
  category: Schema.optional(Category)
}) {}

export class DiscoverGroup extends HttpApiGroup.make("discover")
  .add(
    HttpApiEndpoint.get("genres", "/genres", {
      query: { category: Category },
      success: Schema.Array(GenreCount)
    }),
    HttpApiEndpoint.get("calibration", "/me/calibration", {
      query: { category: Category, limit: Schema.optional(Schema.NumberFromString) },
      success: Schema.Array(Recommendation)
    }),
    HttpApiEndpoint.get("deck", "/me/deck", {
      query: { category: Category, limit: Schema.optional(Schema.NumberFromString) },
      success: Schema.Array(Recommendation)
    }),
    HttpApiEndpoint.post("feedback", "/me/feedback", { payload: Feedback, success: Schema.Void, error: MissingItem }),
    HttpApiEndpoint.get("creators", "/creators", { query: { q: Schema.String }, success: Schema.Array(CreatorHit) }),
    HttpApiEndpoint.get("search", "/search", {
      query: { q: Schema.String, category: Schema.optional(Category) },
      success: Schema.Array(Item)
    }),
    HttpApiEndpoint.post("searchFurther", "/search/further", { payload: SearchFurther, success: Schema.Array(Item) })
  )
  .middleware(Authentication) {}

export class LibraryGroup extends HttpApiGroup.make("library")
  .add(
    HttpApiEndpoint.get("watchlist", "/me/items", {
      query: { status: Schema.optional(Status), category: Schema.optional(Category) },
      success: Schema.Array(UserItem)
    }),
    HttpApiEndpoint.patch("update", "/me/items/:itemId", {
      params: { itemId: Schema.NumberFromString.pipe(Schema.brand("ItemId")) },
      payload: ItemPatch,
      success: UserItem,
      error: MissingItem
    }),
    HttpApiEndpoint.post("import", "/me/imports/:source", {
      params: { source: ImportSource },
      payload: ImportRequest,
      success: ImportResult,
      error: ImportFailed.pipe(HttpApiSchema.status(400))
    })
  )
  .middleware(Authentication) {}

export class WatchGroup extends HttpApiGroup.make("watch")
  .add(
    HttpApiEndpoint.get("regions", "/watch/regions", { success: Schema.Array(Region) }),
    HttpApiEndpoint.get("providers", "/watch/providers", { query: { region: RegionCode }, success: Schema.Array(Provider) }),
    // Null when the user has no region set or the item has no TMDB match (anime and books).
    HttpApiEndpoint.get("options", "/items/:itemId/watch", {
      params: { itemId: Schema.NumberFromString.pipe(Schema.brand("ItemId")) },
      success: Schema.NullOr(WatchOptions),
      error: MissingItem
    })
  )
  .middleware(Authentication) {}

const Trakt = TraktFailed.pipe(HttpApiSchema.status(400))

export class TraktGroup extends HttpApiGroup.make("trakt")
  .add(
    HttpApiEndpoint.get("status", "/me/trakt", { success: TraktStatus }),
    // Starts sign-in: returns the Trakt authorize URL to send the browser to.
    HttpApiEndpoint.post("connect", "/me/trakt/connect", { success: Schema.Struct({ url: Schema.String }), error: Trakt }),
    // Finishes sign-in with the code Trakt sent to /trakt/callback, then imports everything.
    HttpApiEndpoint.post("callback", "/me/trakt/callback", {
      payload: Schema.Struct({ code: Schema.String, state: Schema.String }),
      success: ImportResult,
      error: Trakt
    }),
    HttpApiEndpoint.post("sync", "/me/trakt/sync", { success: ImportResult, error: Trakt }),
    HttpApiEndpoint.delete("disconnect", "/me/trakt", { success: Schema.Void })
  )
  .middleware(Authentication) {}

export class MagpieApi extends HttpApi.make("magpie")
  .add(AuthGroup)
  .add(UsersGroup)
  .add(DiscoverGroup)
  .add(LibraryGroup)
  .add(WatchGroup)
  .add(TraktGroup)
  .prefix("/api") {}
