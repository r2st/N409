-- The seven corporate document buckets — 0105's six were the finance half.
--
-- 0105 built the category axis around the intake checklist's arithmetic: cap
-- table, monthly P&Ls, annual P&Ls, balance sheets, projections, and a
-- catch-all. That is the right shape for "can we model this company yet",
-- because those are the buckets a model is blocked on. It is the wrong shape
-- for everything a client actually sends. The charter, the bylaws, the
-- operating agreement, the shareholder agreement, the option plan, the board
-- resolutions, the IP schedule and the prior 409A all landed in `uploads`
-- together, which meant the one bucket that was never asked for by name held
-- most of the corporate record, and an analyst looking for the option plan
-- read filenames.
--
-- These seven are not blocking — a valuation can be modelled without any of
-- them, and every one is `required: false` in domain/documentCategories.ts.
-- They exist so a file has somewhere to be filed that is not "miscellaneous",
-- which is what makes the deliverable's evidence list legible and what lets
-- the workspace filter by what an analyst is actually looking for.
--
-- `uploads` survives and keeps its meaning: genuinely uncategorised. It is
-- still the default, and nothing is backfilled out of it — a file already
-- filed there was filed by somebody who saw the choices available at the time,
-- and guessing at its bucket from a filename would be exactly the silent
-- reclassification 0105 exists to prevent. Ops re-file them by hand or they
-- stay where they are.
--
-- Values are appended rather than positioned: unlike 0107's lifecycle state,
-- nothing orders document categories by pg_enum — the display order is
-- DOCUMENT_CATEGORY_DEFS, which is explicit and puts the finance buckets
-- first.
--
-- Adds values and nothing else, for the reason 0107 gives: Postgres permits
-- ALTER TYPE ... ADD VALUE inside the runner's transaction but forbids using
-- the new value in it, so any backfill or default referencing these has to
-- wait for a later migration.

ALTER TYPE document_category ADD VALUE IF NOT EXISTS 'corporate_documents';
ALTER TYPE document_category ADD VALUE IF NOT EXISTS 'shareholder_agreements';
ALTER TYPE document_category ADD VALUE IF NOT EXISTS 'stock_option_plan';
ALTER TYPE document_category ADD VALUE IF NOT EXISTS 'board_resolutions';
ALTER TYPE document_category ADD VALUE IF NOT EXISTS 'pitch_deck';
ALTER TYPE document_category ADD VALUE IF NOT EXISTS 'intellectual_property';
ALTER TYPE document_category ADD VALUE IF NOT EXISTS 'prior_valuations';
