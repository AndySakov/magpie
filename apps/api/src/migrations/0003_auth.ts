import { Effect } from "effect"
import { SqlClient } from "effect/sql"

export default Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  yield* sql`ALTER TABLE app_user ADD COLUMN is_admin boolean NOT NULL DEFAULT false`
  yield* sql`
    CREATE TABLE invite (
      token_hash text PRIMARY KEY,
      user_id uuid REFERENCES app_user (id) ON DELETE CASCADE,
      is_admin boolean NOT NULL DEFAULT false,
      created_by uuid REFERENCES app_user (id) ON DELETE SET NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      expires_at timestamptz NOT NULL,
      used_at timestamptz
    )`
  yield* sql`
    CREATE TABLE passkey (
      id text PRIMARY KEY,
      user_id uuid NOT NULL REFERENCES app_user (id) ON DELETE CASCADE,
      public_key text NOT NULL,
      counter bigint NOT NULL,
      transports text[] NOT NULL DEFAULT '{}',
      created_at timestamptz NOT NULL DEFAULT now(),
      last_used_at timestamptz
    )`
  yield* sql`CREATE INDEX passkey_user ON passkey (user_id)`
  yield* sql`
    CREATE TABLE session (
      token_hash text PRIMARY KEY,
      user_id uuid NOT NULL REFERENCES app_user (id) ON DELETE CASCADE,
      created_at timestamptz NOT NULL DEFAULT now(),
      expires_at timestamptz NOT NULL
    )`
  yield* sql`
    CREATE TABLE auth_challenge (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      challenge text NOT NULL,
      invite_hash text,
      user_id uuid,
      name text,
      expires_at timestamptz NOT NULL
    )`
})
