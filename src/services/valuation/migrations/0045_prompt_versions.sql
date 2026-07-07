-- P1 #8 — AI prompt registry versioning (docs/n409-remaining-features-spec.md).
-- Append-only history of each prompt's content: every content edit (and every
-- revert) inserts the next numbered version; the live ai_prompts row stays the
-- single source of truth the AI service reads. Same conventions as 0001:
-- ULID PKs, timestamptz UTC.

CREATE TABLE ai_prompt_versions (
  id            ulid PRIMARY KEY,
  prompt_id     ulid NOT NULL REFERENCES ai_prompts(id) ON DELETE CASCADE,
  version       integer NOT NULL CHECK (version >= 1),
  system_prompt text NOT NULL,
  model         text,
  created_by    ulid REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (prompt_id, version)
);
CREATE INDEX ai_prompt_versions_prompt_idx ON ai_prompt_versions (prompt_id, version DESC);

-- Backfill version 1 from the live rows so history starts at today's content.
-- The version id is derived from the prompt id (prefix swapped to '01VERS'),
-- which keeps it unique and inside the ulid domain without an SQL ULID
-- generator; ids after this insert come from the application.
INSERT INTO ai_prompt_versions (id, prompt_id, version, system_prompt, model, created_by, created_at)
SELECT overlay(id placing '01VERS' from 1 for 6), id, 1, system_prompt, model, updated_by, updated_at
FROM ai_prompts;

-- Provenance: which prompt version an AI run used (NULL for runs that predate
-- versioning or pipelines without a registry row).
ALTER TABLE ai_jobs ADD COLUMN prompt_version integer;
