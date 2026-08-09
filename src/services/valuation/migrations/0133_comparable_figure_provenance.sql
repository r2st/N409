-- Where a peer row's figures actually came from, and when.
--
-- `comparable_items.source` says who put the row in the set — an AI agent, an
-- analyst, or the screen. It has never said where the *numbers* came from, and
-- for every row on the platform the answer is the same one: the engine's
-- curated static snapshot in `market_data.py`, which describes itself as "an
-- illustrative reference point, not a real-time quote".
--
-- That is defensible data to screen against and indefensible data to conclude
-- on without saying so. The screen writes those figures under the source name
-- `market_feed`, the UI labels them "Screen", and nothing anywhere tells a
-- reviewer that the EV/Revenue in Exhibit D-1 is a hand-maintained reference
-- figure of unknown vintage rather than an observed market multiple. Meanwhile
-- `engine/v1/market-feed` has served live yfinance figures, with a graceful
-- documented fallback, since it was written — and no caller.
--
-- So: two columns, not one. `figures_source` names the origin, and
-- `figures_as_of` timestamps it, because a live multiple is only live at a
-- moment and a report published in March quoting January's observation is the
-- same misstatement as quoting the snapshot. Both are needed for a reviewer to
-- know what they are reading; either alone still leaves them guessing.
--
-- NULL means the snapshot, which is what every existing row is. Not backfilled
-- to the literal 'snapshot' because NULL is honest about the second column: we
-- know where those figures came from and we do not know when they were
-- current, and writing a timestamp we do not have would be the exact claim
-- this migration exists to stop anyone making.

ALTER TABLE comparable_items ADD COLUMN IF NOT EXISTS figures_source text;
ALTER TABLE comparable_items ADD COLUMN IF NOT EXISTS figures_as_of timestamptz;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'comparable_items_figures_source_check'
  ) THEN
    ALTER TABLE comparable_items
      ADD CONSTRAINT comparable_items_figures_source_check
      CHECK (figures_source IS NULL OR figures_source IN ('snapshot', 'live', 'analyst'));
  END IF;
END $$;

-- A live figure is only meaningful with the moment it was observed, and a
-- timestamp with no origin names nothing. The pair travels together or not at
-- all.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'comparable_items_figures_pair_check'
  ) THEN
    ALTER TABLE comparable_items
      ADD CONSTRAINT comparable_items_figures_pair_check
      CHECK ((figures_source IS NULL) = (figures_as_of IS NULL));
  END IF;
END $$;
