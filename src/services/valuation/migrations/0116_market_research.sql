-- Web-grounded market research: storage for what Perplexity Sonar answered,
-- and the pipeline vocabulary for the questions we are allowed to ask it.
--
-- `ai/app/perplexity.py` has been a complete, fenced Sonar client since before
-- this table existed, and nothing called it: no route, no storage, no UI, no
-- thread into drafting. The consequence was that industry-conditions and
-- market-outlook paragraphs were written from the uploaded corpus and analyst
-- knowledge alone, which is the weakest part of a generated draft and the one
-- an auditor is most likely to ask for a source on.
--
-- Two decisions worth stating, because both are load-bearing:
--
--   * Append-only. A re-run supersedes the prior row rather than updating it.
--     A report cites the research it was drafted from; overwriting the answer
--     while the citation stays behind makes the citation a lie. Same reasoning
--     as `qa_reviews`, which is append-only for the same reason.
--
--   * `question` is stored alongside `answer`. The question is assembled from a
--     fixed template plus a whitelist of public fields (domain/research.ts), so
--     keeping it is what lets a reviewer confirm — a year later, in an audit —
--     that no client text ever reached a search provider. The placeholder check
--     inside perplexity.py is the second line of defence; this row is the
--     evidence.

CREATE TABLE IF NOT EXISTS market_research (
  id            ulid PRIMARY KEY,
  valuation_id  ulid NOT NULL REFERENCES valuations(id) ON DELETE CASCADE,
  -- One of domain/research.ts RESEARCH_TOPICS. Text rather than an enum: the
  -- topic registry is a product decision that moves faster than the schema,
  -- and an unknown topic here is inert data rather than a broken insert.
  topic         text NOT NULL,
  -- 'us','uk','au','si','ca','un' — set only for region-scoped topics.
  -- 409.ai ships six separate market_* prompts; this is the same question with
  -- the market named, because six rows is six places to fix a wording change.
  region        text,
  -- What was actually asked, verbatim. See the note above.
  question      text NOT NULL,
  answer        text NOT NULL,
  -- [{url, title, date}] in the order Sonar ranked them. An answer with an
  -- empty list is ungrounded and must not be quoted in a report.
  citations     jsonb NOT NULL DEFAULT '[]',
  model         text NOT NULL,
  requested_by  ulid REFERENCES users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  -- Set when a later run of the same (valuation, topic, region) replaced this.
  superseded_at timestamptz
);

-- The current set for one engagement — every read the tab and the narrative
-- agent make is "the live rows for this valuation".
CREATE INDEX IF NOT EXISTS market_research_valuation_idx
  ON market_research (valuation_id, topic) WHERE superseded_at IS NULL;

COMMENT ON TABLE market_research IS
  'Append-only web-grounded research (Perplexity Sonar) per valuation; a re-run supersedes rather than updates.';
COMMENT ON COLUMN market_research.question IS
  'The assembled question, kept as evidence that only whitelisted public fields reached the search provider.';

-- ── Research pipelines ───────────────────────────────────────────────────────
--
-- The eleven prompts 409.ai has and N409 did not, collapsed onto six topics:
-- the six regional market_* variants are one region-parameterised topic, and
-- `industry_finder` covers both Industry_finder and AI:FindRelevantTags.
--
-- Seeding the ai_prompts rows for these is 0117, not this file: Postgres
-- forbids using a new enum value in the transaction that adds it, the same
-- constraint 0060/0061 and 0107 already document.
ALTER TYPE ai_pipeline ADD VALUE IF NOT EXISTS 'market_research';
ALTER TYPE ai_pipeline ADD VALUE IF NOT EXISTS 'industry_overview';
ALTER TYPE ai_pipeline ADD VALUE IF NOT EXISTS 'industry_outlook';
ALTER TYPE ai_pipeline ADD VALUE IF NOT EXISTS 'competitor_analysis';
ALTER TYPE ai_pipeline ADD VALUE IF NOT EXISTS 'company_overview';
ALTER TYPE ai_pipeline ADD VALUE IF NOT EXISTS 'industry_finder';
