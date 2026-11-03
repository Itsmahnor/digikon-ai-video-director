-- Phase 1 foundation: pgvector, the template library, retrieval and model-call logs.
-- Additive only: nothing here is read by an existing flow, and every table can be dropped without touching the rest of the system.

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS template_categories (
  id          text PRIMARY KEY,
  name        text NOT NULL,
  parent_id   text REFERENCES template_categories (id),
  description text NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS templates (
  id           text PRIMARY KEY,
  category_id  text REFERENCES template_categories (id),
  title        text NOT NULL,
  family       text,
  variant_of   text REFERENCES templates (id),
  archetype    text,
  tags         text[] NOT NULL DEFAULT '{}',
  status       text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'reviewed', 'approved', 'retired')),
  body         jsonb NOT NULL,
  content_hash text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS templates_category_idx ON templates (category_id);
CREATE INDEX IF NOT EXISTS templates_family_idx ON templates (family);
CREATE INDEX IF NOT EXISTS templates_tags_idx ON templates USING gin (tags);

-- `vector` has no fixed dimension here on purpose: the embedding model is configuration. Add an HNSW index per (model, dimension) once one is chosen.
CREATE TABLE IF NOT EXISTS template_embeddings (
  id            bigserial PRIMARY KEY,
  template_id   text NOT NULL REFERENCES templates (id) ON DELETE CASCADE,
  kind          text NOT NULL CHECK (kind IN ('text', 'look')),
  model         text NOT NULL,
  model_version text NOT NULL,
  vector        vector NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (template_id, kind, model, model_version)
);

CREATE TABLE IF NOT EXISTS template_usage (
  id          bigserial PRIMARY KEY,
  template_id text NOT NULL REFERENCES templates (id) ON DELETE CASCADE,
  film_id     text,
  scene_id    text,
  outcome     jsonb NOT NULL DEFAULT '{}',
  used_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS template_review (
  id          bigserial PRIMARY KEY,
  template_id text NOT NULL REFERENCES templates (id) ON DELETE CASCADE,
  reviewer    text NOT NULL,
  verdict     text NOT NULL CHECK (verdict IN ('approved', 'rejected', 'needs_changes')),
  notes       text NOT NULL DEFAULT '',
  reviewed_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS capability_index (
  capability_id text PRIMARY KEY,
  snapshot_hash text NOT NULL,
  status        text NOT NULL,
  body          jsonb NOT NULL,
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS retrieval_log (
  id         bigserial PRIMARY KEY,
  film_id    text,
  query      text NOT NULL,
  collection text,
  hits       jsonb NOT NULL DEFAULT '[]',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS model_calls (
  id            bigserial PRIMARY KEY,
  film_id       text,
  provider      text NOT NULL,
  model         text NOT NULL,
  name          text NOT NULL,
  input_tokens  integer NOT NULL DEFAULT 0,
  output_tokens integer NOT NULL DEFAULT 0,
  cost_usd      numeric(12, 6) NOT NULL DEFAULT 0,
  attempts      integer NOT NULL DEFAULT 1,
  outcome       text NOT NULL CHECK (outcome IN ('ok', 'error', 'budget_stop')),
  error_code    text,
  duration_ms   integer NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS model_calls_film_idx ON model_calls (film_id);

CREATE TABLE IF NOT EXISTS render_jobs (
  id          text PRIMARY KEY,
  film_id     text,
  status      text NOT NULL,
  engine      text,
  input       jsonb NOT NULL DEFAULT '{}',
  output      jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
