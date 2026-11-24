# Magpie

Friends-only discovery for movies, TV, anime and books. Product spec: `SPEC.md`.

## Run locally

Needs Docker, Node 22+, pnpm.

```sh
cp .env.example .env          # set POSTGRES_PASSWORD, DATABASE_URL, DATA_DIR
pnpm install
pnpm db:up                    # Postgres 18 + pgvector via Alchemy (Docker provider)
pnpm migrate
```

Load the catalog. API responses from AniList and Open Library search are cached in `DATA_DIR` on first run.

```sh
scripts/fetch-data.sh         # IMDb, MovieLens ml-32m, anime-offline-database, Open Library ratings into DATA_DIR
pnpm ingest                   # anime, screen, books, tmdb, languages, finalize, availability (or name steps: pnpm ingest books finalize)
pnpm embed                    # embeddings for anything missing one; resumable
```

A full ingest takes about 10 minutes, mostly API rate limits. Embedding about 190k items takes about 40 minutes on an M-series CPU. The `tmdb` step only runs when `TMDB_API_TOKEN` is set. Run `pnpm embed` after it, because changed synopses drop their embeddings.

```sh
pnpm dev:api                  # http://localhost:3000/api, OpenAPI at /api/openapi.json
pnpm dev:web                  # proxies /api to the API
```

## Sign in

Magpie is invite-only and uses passkeys. Mint the first invite from the CLI, open the link, and pick a name:

```sh
pnpm --filter @magpie/api invite --admin           # new admin account
pnpm --filter @magpie/api invite --user Temi       # new passkey for an existing account (lost device)
```

Admins create further invites from Settings. `RP_ID` and `ORIGIN` must match the domain the app is served from, so passkeys made on localhost don't work in production.

## Tests

```sh
pnpm test                                        # unit tests
API_URL=http://localhost:3000 pnpm --filter @magpie/api test   # adds end-to-end and passkey tests against a running API
```

## Deploy

Production runs on Cloudflare's free plan: one Worker serves the web app and the API, Hyperdrive pools connections
to Prisma Postgres, and Workers AI embeds titles found by "search further". `cloudflare.run.ts` declares it all.
`APP_DOMAIN` sets the hostname. Passkeys are bound to it, so changing it locks out existing passkeys.

```sh
DATABASE_URL="$PROD_DATABASE_URL" pnpm migrate     # schema first
2password run \
  --env "CLOUDFLARE_API_TOKEN=op://Automation/Cloudflare Workers API Key/credential" \
  --env "CF_ANALYTICS_TOKEN=op://Automation/Cloudflare Analytics API Key/credential" \
  -- pnpm run deploy
```

Use `pnpm run deploy`: plain `pnpm deploy` is a pnpm built-in and does nothing here.

The deploy token needs, account-wide: Workers Scripts, Hyperdrive and Email Routing Addresses (edit); on the
`APP_DOMAIN` zone: DNS, Zone Settings and Email Routing Rules (edit), Zone (read); on all zones: Workers Routes (edit).
`CF_ANALYTICS_TOKEN` is a separate token with only Account Analytics Read. It ships to the Worker as a secret, so it
must never be the deploy token.

To sign in to a fresh database, mint an admin invite and open the printed link:

```sh
cd apps/api
DATABASE_URL="$PROD_DATABASE_URL" ORIGIN="https://$APP_DOMAIN" RP_ID="$APP_DOMAIN" pnpm invite --admin
```

Only catalog tables go to production (item, item_external_id, creator, item_creator, item_relation, item_embedding,
franchise, ml_rating), never user data.

### Scheduled jobs and alerts

An hourly cron checks free-tier usage: account-wide Workers requests, Hyperdrive queries and Workers AI neurons per
day, Magpie's p99 CPU and cut-off requests, Prisma operations per month (counted from Hyperdrive queries) and database
size. It emails `ALERT_EMAIL_TO` from `ALERT_EMAIL_FROM` when a metric reaches 80%, 95% or 100% of its limit, or is
on pace to before the limit resets, and repeats every three days while it stays there. The sender must be on a zone
in this account; the deploy enables Email Routing on it, and Cloudflare only delivers to a destination address after
its verification link is clicked. Without the token or the addresses, the check only logs warnings.

At 03:00 UTC the same job embeds and ranks titles that "search further" added.

Every run also advances the where-to-watch sweep by 30 TMDB requests, for each country and service someone picked in
Settings. A big catalogue such as Netflix in one country takes about 400 requests, so a new service fills in within a
day. `DATABASE_URL="$PROD_DATABASE_URL" pnpm ingest availability` does the whole sweep at once from your machine.
