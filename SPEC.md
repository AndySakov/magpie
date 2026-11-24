# Magpie: product spec (draft)

Organic discovery of movies, TV, anime and books from your history, preferences and feedback. For you and friends. Running cost close to zero.

## Stack

- Mobile-first PWA.
- TypeScript + Effect backend, Postgres with pgvector.
- Zero-cost hosting. Free managed Postgres tiers (~0.5 GB) will not fit a large catalog; Oracle Cloud always-free ARM VM is the fallback. Decided by the catalog spike.
- Infra as code with Alchemy (`alchemy.run.ts`). Local dev runs Postgres 18 + pgvector 0.8.2 in Docker through the Alchemy Docker provider. All infra values come from `.env` (see `.env.example`).
- Embeddings: `Xenova/bge-small-en-v1.5` (384 dims, q8) run locally with transformers.js. HNSW cosine index.
- Effect 4 HttpApi contract in `packages/contract`, shared by the API (`apps/api`) and the web client (`apps/web`).

## v1 scope

### Categories

Movies, TV, anime, books. Data model is built for later categories (manga, video games, board games, comics, music down to tracks) without rework. See "Foundations".

### Onboarding

1. Pick genres per category.
2. Calibration deck per category: a mix of
   - popular titles, for fast "seen it" coverage, and
   - polarizing titles (high rating variance across sources/neighbours), because consensus favourites carry little taste signal.
3. Imports, as many as possible:
   - API: Trakt, AniList, MyAnimeList, Simkl, Plex/Jellyfin server sync.
   - CSV export: Letterboxd, Goodreads, StoryGraph, IMDb ratings, Netflix viewing activity, TV Time.
   - One matching pipeline maps external IDs to catalog items. Low-confidence matches go to a "confirm these" screen, never silently dropped.

### Swipe deck and watchlist

- Swipe right = interested, left = not interested. "Seen it" button opens thumbs or star rating.
- Statuses: want, in progress, finished, dropped. Episode/chapter tracking manual, auto-filled when Trakt/AniList/Plex sync is connected.
- Implicit signals: drop point, binge speed, rewatches, added but never started.
- Public scores are hidden until the user has rated the item, to avoid anchoring their rating.
- Every card carries an explanation ("Because you liked X and Y", "3 people with your taste loved this").
- Discovery dial: "more of what I love" to "surprise me". Hidden gems boosted over the obvious.
- Rabbit holes: follow a creator, studio, theme or franchise.
- Filters: mature content, language and region, length limits, hard blocks on genres/themes/creators.

### Where to watch

TMDB watch providers (JustWatch data, attribution required). Filter by the services the user subscribes to. UX modelled on Plex Discover; Plex itself is used only for server sync.

## Data sources

Decided after the catalog spike (`spike/catalog/RESULTS.md`).

| Need | Source | Notes |
|---|---|---|
| Movies and TV catalog, text, posters, trailers, providers | TMDB | Used despite its ML clause (non-commercial, friends-only; accepted risk is key revocation). Behind a source adapter so Wikidata can replace it. Comply where free: attribution and JustWatch credit, refresh cached data within 6 months via the changes endpoint, ~40 req/s. |
| Cross-IDs, franchises, creators, all categories | Wikidata | CC0. Fallback backbone for movies/TV. |
| Anime catalog | manami-project anime-offline-database | ODbL, 41.5k titles, relations graph, cross-source scores, no synopses. Don't hotlink its MAL image URLs. |
| Books catalog and popularity | Open Library monthly dumps (works, reading log, ratings) | Sanctioned bulk route. Reading log is the popularity signal. |
| Text for embeddings where TMDB has none | Wikipedia summaries | CC BY-SA, attribution. |
| Movie/TV ratings | TMDB votes, IMDb ratings dataset | |
| User's own history | Trakt OAuth (dev app: owner + 16 invitees), Letterboxd/IMDb/Goodreads/StoryGraph CSV, MAL/AniList user-exported files | AniList and MAL APIs avoided. |

Catalog tiers:

- **Embedded**: items with text and a popularity signal. ~300-650k items, ~1.2-2.6 GB.
- **Light**: IDs, title, year, popularity for anything with any signal. ~4M items, ~1.2 GB.
- Everything else is promoted on first touch.
- Hosting: Oracle always-free ARM VM or a home box; free managed Postgres tiers are too small.

## Recommender

Signals are combined; none is trusted alone.

1. **Taste profiles** per category, with light cross-category influence. Recency-weighted with a per-category decay rate.
2. **Content similarity**: embeddings from a small open model computed offline, plus metadata and creators.
3. **Borrowed neighbours**: collaborative filtering without a large user base. The user is matched against public raters on polarizing titles, then recommendations come from what their nearest neighbours rated highly. Source: MovieLens (32M ratings; needs a GroupLens permission request for non-research use). AniList, MAL, Trakt and Letterboxd all forbid collecting other users' ratings. Friends' ratings cover the rest.
4. **Friends' ratings** (later phase) as a direct signal.
5. **Quality score** per item, independent of everything above:
   - Public ratings (TMDB, AniList, IMDb datasets, Google Books) normalised to a per-source percentile, shrunk toward the mean at low vote counts, blended across sources.
   - Review-bomb damping: daily snapshots of aggregate scores (we mirror the catalog anyway) let us detect abrupt shifts around release or controversy and cap their weight.

### Links transfer interest, never quality

Applies to every edge: shared creator, franchise, adaptation, sequel.

- A link raises interest in the target only if the target passes its own quality bar. Below it, the item is suppressed or shown with a warning ("rated far below the manga").
- Negative feedback does not propagate back along a link: hating an adaptation does not penalise the source.
- `adaptation_of` edges store the quality delta between source and adaptation, and a fidelity tag (faithful, loose, original ending).
- Ratings exist per season/volume, so "great through S1, read the source after" is expressible.
- Franchise pages group linked items, rank by quality, and mark "start here" / best version.

### Bring-your-own LLM (optional)

The core recommender never needs an LLM. When a user connects one (OpenAI-compatible endpoint, Ollama, or in-browser WebGPU), it adds:

- natural-language requests,
- better-written explanations, and summaries of matched neighbours' or critics' reviews,
- tone/theme bridging across categories.

Keys stay on the device; requests go browser to provider. Deterministic fallbacks exist for all three.

## Foundations (built in v1 so later categories don't break things)

1. **History is an event log** (watch, read, play, listen). Status is derived. Imports are idempotent on `(source, external_id, occurred_at)`.
2. **Typed item relations**: `part_of`, `expansion_of`, `adaptation_of`, `in_franchise`. Covers episode/season/show, chapter/volume/series, track/album/artist, DLC, board game expansions.
3. **Franchise entity** above items, keyed by Wikidata QID.
4. **External IDs table** `(item, source, external_id)`. Wikidata cross-references link TMDB, AniList, MAL, Open Library, IGDB, BGG, MusicBrainz and Comic Vine IDs.
5. **Creators** as first-class entities with roles.
6. **Per-category variation keyed by category**, not columns: taste profiles, length measures, progress units, provider types.
7. **Embeddings keyed by `(item, model)`**, so models and dimensions can change.

## Later phases

- Trailer reels (TMDB YouTube keys; book cards with blurb or excerpt).
- Social: friends' ratings, shared watchlists, direct recs, group pick (everyone swipes the same deck, matches surface).
- New categories:

| Category | Catalog | Imports | Progress unit |
|---|---|---|---|
| Manga | AniList, MAL, MangaDex | AniList, MAL | chapters/volumes |
| Video games | IGDB | Steam, Backloggd | hours, completion |
| Board games | BoardGameGeek | BGG collection and plays | plays |
| Comics | Comic Vine, Metron | CSV at best | issues |
| Music (incl. tracks) | MusicBrainz, ListenBrainz, Last.fm | Last.fm, ListenBrainz, Spotify recent/top | listens |

Music caveat: Spotify restricted recommendations, related artists, audio features and previews for new apps in late 2024. Deezer previews are the likely audio source.

## Catalog spike

Done 2026-11-21. Results, sizes and terms findings: `spike/catalog/RESULTS.md`. Outcome is the "Data sources" section.

## Open questions

1. Auth: invite-only with magic links or passkeys?
2. Import matching policy for ambiguous titles (remakes, translated editions).
3. Shared instance for friends, or one per person?
4. Group pick mechanics.
5. Polarizing titles per category. Implemented: MovieLens rating spread (movies, TV), AniList score distribution (anime), Open Library ratings (books). TV coverage is thin (37 titles with spread).
6. Deploy target. Decided: Cloudflare free plan (Worker + Hyperdrive + Workers AI) with Prisma Postgres free (2 GB), declared in `cloudflare.run.ts`. Storage is the tightest limit: the catalog uses about 72% of it.

## References

- Slidebean, "yeah... Netflix only wants you to watch THEIR movies" (youtube.com/watch?v=0mMWQRRUcjY): crowd-rating bias, content-chaining failure modes, critic matching on polarizing films. Their tool: movies.slidebean.com.

## Name

Magpie. No media tracker or recommender found under that name. All obvious domains (magpie.app, .so, .fm, .watch, .club, .media) are registered; fine for a friends-only instance on a subdomain. Needs a trademark and domain decision before any public launch.
