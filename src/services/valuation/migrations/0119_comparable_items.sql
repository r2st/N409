-- Network Items: the peer set behind a market approach, kept row by row.
--
-- Comparables have always been *computed* — `engine/comparables.py` scores the
-- reference universe on industry, size, growth and margin, names why each
-- candidate was screened out, and strikes the quartiles — and the result has
-- always been *summarised*: the sixteen `market_comparables` overwrite fields
-- hold the aggregate, and `market.multiples` on a calculation holds a bare list
-- of numbers. What nothing held was the set itself.
--
-- That is a defensibility gap before it is a feature gap. "Which companies were
-- in your peer set, and why was Acme excluded" is the first question an auditor
-- asks about a market approach, and until this table the honest answer was that
-- the platform did not keep the rows — only the median they produced.
--
-- Three decisions worth stating:
--
--   * An AI-sourced row is never deleted, only excluded. The agent's output is
--     evidence of what the model proposed; a set an analyst can silently prune
--     to the flattering half is not a screen, it is a conclusion with a table
--     under it. The route enforces this (`DELETABLE_SOURCES`); the schema keeps
--     `source` so the rule has something to stand on.
--
--   * `exclude_reason` is nullable in the schema and required in the route
--     whenever `included = false`. A CHECK would be stricter, but it would also
--     make the AI writer's bulk insert fail as a unit the first time the engine
--     screened something out without a reason string, and the failure mode of
--     that is "no peer set at all" — strictly worse than "one row an operator
--     has to annotate". See domain/comparables.ts.
--
--   * The metrics are stored, not just the multiples. EV/Revenue is a quotient,
--     and a quotient cannot be re-struck on a different horizon or re-checked
--     against a restated financial. Keeping EV and the four metric legs means a
--     reviewer can recompute every multiple in the exhibit from the row.

CREATE TABLE IF NOT EXISTS comparable_items (
  id             ulid PRIMARY KEY,
  valuation_id   ulid NOT NULL REFERENCES valuations(id) ON DELETE CASCADE,
  -- Null for a private comparable or a transaction comp; the unique index below
  -- is partial for exactly that reason.
  ticker         text,
  name           text NOT NULL,
  sic            text,
  source         text NOT NULL CHECK (source IN ('ai', 'analyst', 'market_feed')),
  included       boolean NOT NULL DEFAULT true,
  exclude_reason text,
  revenue_ltm    numeric(20, 2),
  revenue_ntm    numeric(20, 2),
  ebitda_ltm     numeric(20, 2),
  ebitda_ntm     numeric(20, 2),
  ev             numeric(20, 2),
  -- The screen's 0..1 score and the per-dimension breakdown that made it, as
  -- `engine/v1/comparables` returned them. Kept so the exhibit can print the
  -- reason a row scored what it did rather than just the number.
  score          numeric(6, 4),
  score_breakdown jsonb NOT NULL DEFAULT '{}',
  created_by     ulid REFERENCES users(id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

-- Every read is "the set for this engagement", and the market-approach feed
-- reads only the included half.
CREATE INDEX IF NOT EXISTS comparable_items_valuation_idx
  ON comparable_items (valuation_id, included);

-- One row per ticker per engagement: a re-screen that proposed AAPL twice, or
-- an analyst adding a peer the agent already found, is a duplicate observation
-- and would double that comp's weight in the median.
CREATE UNIQUE INDEX IF NOT EXISTS comparable_items_ticker_uq
  ON comparable_items (valuation_id, ticker) WHERE ticker IS NOT NULL;

COMMENT ON TABLE comparable_items IS
  'The guideline-company peer set per valuation: what was screened, what was kept, and why anything was excluded.';
COMMENT ON COLUMN comparable_items.source IS
  'ai = comp_selection agent, market_feed = engine/v1/market-feed, analyst = added by hand. AI rows are excluded, never deleted.';
COMMENT ON COLUMN comparable_items.exclude_reason IS
  'Required by the route whenever included = false. An exclusion without a reason is the row an auditor asks about.';
