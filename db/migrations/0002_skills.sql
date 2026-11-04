-- Phase A2: skills with licences. Additive only. No row can be saved without a recorded licence and a source.

CREATE TABLE IF NOT EXISTS skill_sources (
  id          text PRIMARY KEY,
  repo        text NOT NULL,
  url         text NOT NULL,
  licence     text NOT NULL CHECK (btrim(licence) <> ''),
  attribution text,
  checked_on  date NOT NULL
);

CREATE TABLE IF NOT EXISTS skills (
  id           text PRIMARY KEY,
  category     text NOT NULL,
  funnel_stage text NOT NULL,
  platform     text[] NOT NULL DEFAULT '{}',
  grade        text NOT NULL,
  status       text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'reviewed', 'approved', 'retired')),
  title        text NOT NULL,
  body         jsonb NOT NULL,
  content_hash text NOT NULL,
  source_id    text NOT NULL REFERENCES skill_sources (id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS skills_category_idx ON skills (category);
CREATE INDEX IF NOT EXISTS skills_source_idx ON skills (source_id);
CREATE INDEX IF NOT EXISTS skills_platform_idx ON skills USING gin (platform);

CREATE TABLE IF NOT EXISTS skill_embeddings (
  id            bigserial PRIMARY KEY,
  skill_id      text NOT NULL REFERENCES skills (id) ON DELETE CASCADE,
  model         text NOT NULL,
  model_version text NOT NULL,
  vector        vector NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (skill_id, model, model_version)
);

CREATE TABLE IF NOT EXISTS assets_library (
  id          text PRIMARY KEY,
  kind        text NOT NULL CHECK (kind IN ('font', 'sound', 'music')),
  file        text NOT NULL,
  licence     text NOT NULL CHECK (btrim(licence) <> ''),
  source      text NOT NULL CHECK (btrim(source) <> ''),
  created_at  timestamptz NOT NULL DEFAULT now()
);
