# Catalog spike results (2026-11-21)

Scripts in this folder reproduce the numbers. Raw data goes in `data/` (gitignored).

## Headline

A full mirror is not ruled out by cost. Terms of use rule it out for the obvious sources, and that changes the plan more than any size number.

- **TMDB** forbids caching longer than 6 months and forbids use "in connection with, or for training, a machine learning or artificial intelligence based Application" (API terms, last updated 2023-10-20, verified by direct fetch). Magpie is such an application. TMDB cannot be the catalog backbone, and even display-only use is a risk.
- **AniList** forbids "hoarding or mass collection" and, since 2026-08-18, any use in "anime and manga list or tracker services", covering both media and user data.
- **MyAnimeList** forbids storing user-generated content (lists, scores) server-side.
- **Trakt**: no mirroring, no redistributing other users' data. Importing a user's own history is explicitly allowed. Dev apps allow the owner plus 16 invitees, which fits a friends-only app.
- **Letterboxd**: no API for personal or recommendation projects. Own CSV export only.
- **MovieLens**: licensed for research. Other uses need GroupLens permission (they have a form).
- **IMDb datasets**: personal, non-commercial, "individual personal use" only. A multi-user app is doubtful.
- **Open Library**: dumps are the sanctioned bulk route. No new rights asserted.
- **Critic scores**: no free legitimate API. RT and Metacritic forbid scraping.

## Sizes

### Movies and TV

| Source | Movies | TV |
|---|---|---|
| TMDB daily ID export | 1,276,561 | 237,189 |
| TMDB popularity >= 1 | 44,176 | 86,272 |
| IMDb titles with >= 100 votes | 147,719 (+16,312 TV movies) | 43,876 (series + miniseries) |
| IMDb titles with >= 1,000 votes | 49,563 | 13,033 |
| Wikidata items with a TMDB ID | 291,305 | 68,148 (40,098 with enwiki) |

### Anime

| Source | Titles |
|---|---|
| manami-project anime-offline-database (ODbL + DbCL, release 2026-27) | 41,537 total: 10,891 TV, 7,046 movie, 6,847 ONA, 5,348 OVA, 11,235 special |
| ...with an aggregated score | 29,998 |
| ...with tags | 39,622 |
| Wikidata items with a MAL anime ID | 7,324 |

anime-offline-database has cross-IDs (MAL, AniList, Kitsu, AniDB, ANN, anime-planet), studios, tags, related-anime links and cross-source score aggregates. It has no synopses. Picture URLs point at MAL's CDN, so they must not be hotlinked.

### Books (Open Library dump 2026-10-31)

| Measure | Count |
|---|---|
| Works dump size | 4.08 GB gz (editions 12.63 GB, authors 0.78 GB) |
| Estimated works | ~41M (extrapolated from a 271k-record sample) |
| Works with a description > 80 chars | ~4% of sample, ~1.6M est. |
| Works with subjects | ~50% of sample |
| Works with any reading-log entry | 3,373,796 |
| ...>= 5 entries / >= 20 / >= 100 | 410,825 / 72,794 / 9,202 |
| Works with >= 5 ratings | 19,317 (ratings are sparse) |

The works sample is the start of the dump, so the 4% is indicative only.

### Later categories (Wikidata coverage)

| ID property | Items |
|---|---|
| IGDB game | 154,313 (29,313 with enwiki) |
| BoardGameGeek | 5,406 |
| MAL manga | 9,203 |
| MusicBrainz release group | 245,268 |

A few enwiki counts timed out on the public SPARQL endpoint.

## Storage estimate

- **Embedded tier** (items with text to embed and a popularity signal): movies ~150k, TV ~45k, anime ~30k, books ~75-400k. That's 300-650k items. At ~4 KB per item (metadata ~2 KB, 384-dim halfvec 768 B, HNSW index ~1-1.5 KB) it comes to **1.2-2.6 GB**.
- **Light tier** (IDs, title, year, popularity) for everything with any signal: ~4M items at ~300 B is **~1.2 GB**. Holding all 41M Open Library works would be ~12 GB+ and mostly noise.
- **Hosting:** free managed Postgres (~0.5 GB) does not fit. An Oracle always-free ARM VM (200 GB) fits easily, and so does any home box.
- **Embedding compute:** a small open model on CPU handles a few hundred items/s, so the embedded tier takes well under a day. (Estimate, not measured.)

## Proposed source plan

| Need | Source | Why |
|---|---|---|
| Catalog backbone + cross-IDs (all categories) | Wikidata | CC0. Has genres, cast/crew, based-on, franchise, country, sitelink counts (a popularity proxy), and IDs for every other source. |
| Text for embeddings | Wikipedia summaries / plot sections | CC BY-SA, attribution required. Covers the popular tier. |
| Anime catalog | anime-offline-database | ODbL. 41.5k titles with a relations graph. |
| Books catalog + popularity | Open Library dumps (works, reading log, ratings) | Sanctioned bulk route. Reading log is a good popularity signal. |
| Movie/TV popularity + quality | Wikidata sitelinks, Wikipedia pageviews; IMDb ratings only if personal-use terms are acceptable | Avoids TMDB. |
| User's own history | Trakt OAuth, Letterboxd CSV, IMDb CSV, Goodreads/StoryGraph CSV, MAL and AniList user-exported files | Own-data imports are allowed or outside API terms. AniList and MAL APIs avoided. |
| Borrowed neighbours | MovieLens (needs a permission request); friends otherwise | Every live-API option forbids it at any useful scale. |
| Polarizing titles | Per-title rating variance: MovieLens (if permitted), OL ratings (19k works), anime cross-source score spread | No critic data is available legitimately. |
| Posters, trailers, where-to-watch | **Open decision** | TMDB is the only good source, and its terms conflict with an ML app. |

## Open decisions

1. **TMDB for display.** The options:
   - (a) avoid it entirely: no posters or where-to-watch beyond Wikidata/Commons,
   - (b) use it for display only, kept strictly out of the recommender, accepting the risk,
   - (c) email TMDB for permission.
2. **MovieLens permission request**: needed for borrowed neighbours and movie rating variance.
3. **IMDb datasets**: accept the "individual personal use" risk for a friends-only instance, or skip.
4. **ODbL share-alike**: if the anime data is redistributed in modified form, the derived database must be ODbL too. That only matters if Magpie publishes its catalog.
