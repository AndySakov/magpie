import { Effect } from "effect"
import { SqlClient } from "effect/sql"

export default Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  const statements = `
    CREATE EXTENSION IF NOT EXISTS vector;
    CREATE EXTENSION IF NOT EXISTS pg_trgm;
    CREATE EXTENSION IF NOT EXISTS unaccent;

    CREATE TYPE category AS ENUM ('movie', 'tv', 'anime', 'book', 'manga', 'game', 'boardgame', 'comic', 'music');
    CREATE TYPE relation_kind AS ENUM ('part_of', 'expansion_of', 'adaptation_of', 'in_franchise', 'sequel_of', 'related');
    CREATE TYPE item_status AS ENUM ('want', 'in_progress', 'finished', 'dropped');
    CREATE TYPE event_kind AS ENUM ('interested', 'not_interested', 'rated', 'status', 'progress');

    CREATE TABLE item (
      id bigserial PRIMARY KEY,
      category category NOT NULL,
      title text NOT NULL,
      original_title text,
      year int,
      synopsis text,
      genres text[] NOT NULL DEFAULT '{}',
      tags text[] NOT NULL DEFAULT '{}',
      length_value int,
      length_unit text CHECK (length_unit IN ('minutes', 'episodes', 'pages')),
      is_adult boolean NOT NULL DEFAULT false,
      language text,
      image_url text,
      popularity real NOT NULL DEFAULT 0,
      quality real,
      quality_votes int NOT NULL DEFAULT 0,
      polarization real,
      meta jsonb NOT NULL DEFAULT '{}',
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX item_category_popularity ON item (category, popularity DESC);
    CREATE INDEX item_title_trgm ON item USING gin (lower(title) gin_trgm_ops);
    CREATE INDEX item_genres ON item USING gin (genres);

    CREATE TABLE item_external_id (
      source text NOT NULL,
      external_id text NOT NULL,
      item_id bigint NOT NULL REFERENCES item (id) ON DELETE CASCADE,
      PRIMARY KEY (source, external_id)
    );
    CREATE INDEX item_external_id_item ON item_external_id (item_id);

    CREATE TABLE item_embedding (
      item_id bigint NOT NULL REFERENCES item (id) ON DELETE CASCADE,
      model text NOT NULL,
      embedding vector(384) NOT NULL,
      PRIMARY KEY (item_id, model)
    );
    CREATE INDEX item_embedding_hnsw ON item_embedding USING hnsw (embedding vector_cosine_ops);

    CREATE TABLE creator (
      id bigserial PRIMARY KEY,
      source text NOT NULL,
      external_id text NOT NULL,
      name text NOT NULL,
      UNIQUE (source, external_id)
    );
    CREATE TABLE item_creator (
      item_id bigint NOT NULL REFERENCES item (id) ON DELETE CASCADE,
      creator_id bigint NOT NULL REFERENCES creator (id) ON DELETE CASCADE,
      role text NOT NULL,
      PRIMARY KEY (item_id, creator_id, role)
    );
    CREATE INDEX item_creator_creator ON item_creator (creator_id);

    CREATE TABLE franchise (
      id bigserial PRIMARY KEY,
      wikidata_qid text UNIQUE,
      name text NOT NULL
    );
    CREATE TABLE item_relation (
      from_item bigint NOT NULL REFERENCES item (id) ON DELETE CASCADE,
      to_item bigint NOT NULL REFERENCES item (id) ON DELETE CASCADE,
      kind relation_kind NOT NULL,
      fidelity text,
      PRIMARY KEY (from_item, to_item, kind)
    );
    CREATE INDEX item_relation_to ON item_relation (to_item);

    CREATE TABLE app_user (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      name text NOT NULL UNIQUE,
      preferences jsonb NOT NULL DEFAULT '{}',
      created_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE event (
      id bigserial PRIMARY KEY,
      user_id uuid NOT NULL REFERENCES app_user (id) ON DELETE CASCADE,
      item_id bigint NOT NULL REFERENCES item (id) ON DELETE CASCADE,
      kind event_kind NOT NULL,
      value real,
      status item_status,
      source text NOT NULL DEFAULT 'app',
      source_event_id text,
      occurred_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (user_id, source, source_event_id)
    );
    CREATE INDEX event_user_time ON event (user_id, occurred_at DESC);

    CREATE TABLE user_item (
      user_id uuid NOT NULL REFERENCES app_user (id) ON DELETE CASCADE,
      item_id bigint NOT NULL REFERENCES item (id) ON DELETE CASCADE,
      interest smallint,
      status item_status,
      rating real,
      progress int,
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (user_id, item_id)
    );

    CREATE TABLE ml_rating (
      ml_user int NOT NULL,
      item_id bigint NOT NULL REFERENCES item (id) ON DELETE CASCADE,
      rating real NOT NULL,
      PRIMARY KEY (item_id, ml_user)
    );
    CREATE INDEX ml_rating_user ON ml_rating (ml_user);
  `.split(/;\s*$/m).map((s) => s.trim()).filter((s) => s.length > 0)
  for (const statement of statements) {
    yield* sql.unsafe(statement)
  }
})
