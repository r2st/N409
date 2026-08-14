-- Engagement tags, and the `tagging` agent that proposes them.
--
-- 409.ai parity gap #23 (`AI:FindRelevantTags`), the last of the thirty-one and
-- the one that stayed open longest. The comparison document is precise about
-- why: there was no `valuation_tags` table *and no consumer for one*. That is
-- the right order to have refused it in — a tag nothing reads is a field an
-- analyst fills in and never sees again — so this migration lands with the
-- consumer: `GET /valuations?tags=` filters the engagement list on accepted
-- tags, and the same predicate answers "what did we conclude last time we
-- valued a company like this one".
--
-- Three decisions the schema follows from.
--
--   * `slug` is text and the vocabulary lives in code (domain/valuationTags.ts),
--     not in an enum or a lookup table. Enums cannot drop a value, and a
--     vocabulary that can only ever grow is how a tag list becomes unusable;
--     a lookup table would invite per-row editing of the one thing that has to
--     be identical across every engagement to be worth querying. The catalogue
--     is code, changing it is a deployment, and a row whose slug has left the
--     catalogue is presented as unknown rather than silently honoured.
--
--   * `status`, and `rejected` is stored rather than deleted. This is what
--     makes re-running the agent safe: a rejected tag deleted is a tag the next
--     run proposes again, so an analyst who declined `dual_class_common` last
--     month declines it again this month, forever. Same argument
--     `replaceMachineComparables` makes for carrying include/exclude decisions
--     forward by ticker.
--
--   * Every row carries `rationale`, `confidence` and `evidence`. A tag is a
--     claim, and `going_concern_doubt` on an engagement is a serious one. A
--     reviewer has to be able to see what it was read from before acting on it,
--     which is also why an AI tag lands as `suggested` and never as `accepted`.

CREATE TYPE valuation_tag_source AS ENUM ('manual', 'ai');
CREATE TYPE valuation_tag_status AS ENUM ('suggested', 'accepted', 'rejected');

CREATE TABLE IF NOT EXISTS valuation_tags (
  id           ulid PRIMARY KEY,
  valuation_id ulid NOT NULL REFERENCES valuations(id) ON DELETE CASCADE,
  slug         text NOT NULL,
  source       valuation_tag_source NOT NULL,
  status       valuation_tag_status NOT NULL,
  -- The model's own 0-1 confidence. NULL on a manual tag, where the concept
  -- does not apply: an analyst who tags an engagement is not 70% sure.
  confidence   numeric(4,3),
  rationale    text,
  -- Filenames or field names the tag was read from, as the agent reported them.
  -- A citation an analyst can check, not free-form notes.
  evidence     jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_by   ulid REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  -- Who last moved the row between suggested / accepted / rejected. Separate
  -- from `created_by` because "the model proposed it" and "a named human
  -- accepted it" are the two facts an audit of this table is asking for.
  decided_by   ulid REFERENCES users(id),
  decided_at   timestamptz,
  -- One row per (engagement, tag). A re-run updates the row it already wrote
  -- rather than stacking a second suggestion behind the first.
  UNIQUE (valuation_id, slug)
);

-- The list filter's predicate: slug first, because it selects far harder than
-- the engagement does — `going_concern_doubt` is a handful of rows across the
-- whole book, and the query that matters is "every engagement carrying it".
CREATE INDEX valuation_tags_slug_idx ON valuation_tags (slug, valuation_id) WHERE status = 'accepted';
CREATE INDEX valuation_tags_valuation_idx ON valuation_tags (valuation_id);

-- The agent. Seeding its ai_prompts row is 0154, not this file: Postgres
-- forbids using a new enum value in the transaction that adds it — the same
-- constraint 0060/0061, 0107, 0116/0117 and 0151/0152 already document.
ALTER TYPE ai_pipeline ADD VALUE IF NOT EXISTS 'tagging';
