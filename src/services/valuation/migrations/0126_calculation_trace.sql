-- The step-by-step record of what an engine run did, for the inspector.
--
-- `calculations` already stores the two ends of a run: `inputs` is the exact
-- payload posted to the engine and `results` is the document it returned. What
-- has never been stored is the middle. When a reviewer disputes a concluded
-- FMV — which is the job — answering "why is the market approach $4M when the
-- multiples say 8x" means reading compute.py alongside the stored payload and
-- redoing the arithmetic by hand.
--
-- `trace` is the engine's own account of each stage: what it consumed, what it
-- produced, and — the part neither `inputs` nor `results` can express — whether
-- it ran at all. An approach with zero weight and an approach carried over from
-- a previous per-approach recalculation are both simply absent from
-- `results.approaches`, identically, and they mean opposite things: one was
-- excluded on purpose, the other is a number older than the inputs beside it.
--
-- Recorded on every run rather than on request, because the run worth
-- inspecting is always one that already happened. A trace you have to ask for
-- in advance is one you never have when it matters.
--
-- Nullable rather than DEFAULT '[]': every row written before this migration
-- has no trace and never will, and an empty array would claim it ran no steps.
-- Nothing reads this to make a number — it is diagnostic only, and the API
-- serves it on its own endpoint so an ordinary calculation list stays small.
ALTER TABLE calculations
  ADD COLUMN IF NOT EXISTS trace jsonb;

COMMENT ON COLUMN calculations.trace IS
  'Ordered engine pipeline steps [{seq, key, label, status, inputs, outputs, note, elapsed_ms}]. Diagnostic only — never read to produce a figure. NULL on runs predating the column.';
