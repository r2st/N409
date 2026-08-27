-- Two reads that scanned a whole table to answer a question about one engagement.
--
-- `market_research` had one index: (valuation_id, topic) WHERE superseded_at IS
-- NULL. `listMarketResearch` takes an `includeSuperseded` flag, and the
-- evidence bundle passes it — which makes the index predicate false and leaves
-- no index at all. Measured on 50k rows: a sequential scan discarding 49,975
-- rows to return 25. The live-only path was not right either: the partial index
-- orders by topic, so the ORDER BY created_at DESC was always a sort.
--
-- `board_signoffs` is keyed by resolution everywhere except the onboarding
-- progress card, which counts a user's signed resolutions by joining on
-- valuation_id — the one column with no index. Measured on 40k rows: a full
-- sequential scan reading every signed row on the estate to return a count of
-- the caller's own, which is usually zero.
--
-- Both are per-engagement tables, so the scans get slower for every customer
-- each time any customer adds a row.

CREATE INDEX IF NOT EXISTS market_research_valuation_created_idx
  ON market_research (valuation_id, created_at DESC);

CREATE INDEX IF NOT EXISTS board_signoffs_valuation_idx
  ON board_signoffs (valuation_id);
