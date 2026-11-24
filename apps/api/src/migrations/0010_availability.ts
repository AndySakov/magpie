import { Effect } from "effect"
import { SqlClient } from "effect/sql"

export default Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  yield* sql`
    CREATE TABLE watch_provider (
      id int PRIMARY KEY,
      name text NOT NULL,
      logo_path text
    )`
  // Subscription, free and ad-supported availability only. Rent and buy are fetched live per item.
  yield* sql`
    CREATE TABLE item_availability (
      region text NOT NULL,
      provider_id int NOT NULL,
      item_id bigint NOT NULL REFERENCES item (id) ON DELETE CASCADE,
      seen_at timestamptz NOT NULL,
      PRIMARY KEY (region, provider_id, item_id)
    )`
  yield* sql`CREATE INDEX item_availability_item ON item_availability (item_id)`
  // One row per (region, provider, media) that some user subscribes to. next_page is null between sweeps.
  yield* sql`
    CREATE TABLE availability_sweep (
      region text NOT NULL,
      provider_id int NOT NULL,
      media text NOT NULL CHECK (media IN ('movie', 'tv')),
      next_page int,
      started_at timestamptz,
      finished_at timestamptz,
      PRIMARY KEY (region, provider_id, media)
    )`
})
