import { Effect } from "effect"
import { SqlClient } from "effect/sql"

export default Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  yield* sql`
    CREATE TABLE trakt_connection (
      user_id uuid PRIMARY KEY REFERENCES app_user (id) ON DELETE CASCADE,
      username text,
      access_token text NOT NULL,
      refresh_token text NOT NULL,
      expires_at timestamptz NOT NULL,
      -- Trakt's /sync/last_activities from the last successful sync. Lists whose timestamp is unchanged are skipped.
      last_activities jsonb,
      synced_at timestamptz,
      checked_at timestamptz
    )`
  // One pending sign-in per user: the PKCE verifier and state for the authorize redirect.
  yield* sql`
    CREATE TABLE trakt_oauth (
      user_id uuid PRIMARY KEY REFERENCES app_user (id) ON DELETE CASCADE,
      state text NOT NULL,
      verifier text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    )`
})
