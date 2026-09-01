-- The three "which run is the calculation carrying" reads, taken off the
-- engagement's whole history.
--
-- `findCurrentVolatilityEstimate`, `findCurrentProjection` and
-- `findAppliedRollforwardRun` are one question asked of three tables: of all
-- the runs on this engagement, which one is the report allowed to describe.
-- Each returns a single row and each was reading, and sorting, every run the
-- engagement has ever recorded to find it.
--
-- ── Why no index could serve two of them ───────────────────────────────────
--
-- Both spellings led with a boolean expression:
--
--     ORDER BY (applied_at IS NOT NULL) DESC, applied_at DESC, created_at DESC, id DESC
--
-- which is 0181's shape — a sort key no btree on `applied_at` holds, so the
-- planner reads the whole set and top-N sorts it for one row. `test/support/
-- expressionSorts.ts` carried both as deliberate exemptions on the ground that
-- the WHERE bounds the sort to one valuation, and that mechanism is real: this
-- never scanned the table. What it does not bound is the *engagement's* history,
-- which is exactly the quantity R304 established is unbounded and is read from —
-- adopting is a POST on any run by id, the panels page at twenty and now say so
-- when there are more, and an engagement mid-review re-runs these tools all day.
--
-- The expression is also redundant. `(applied_at IS NOT NULL) DESC` puts the
-- adopted runs first and `applied_at DESC` orders them; a btree DESC is stored
-- NULLS FIRST, so `applied_at DESC NULLS LAST` is that pair of terms, exactly,
-- with the nulls falling through to `created_at DESC, id DESC` as before.
-- Verified as identical over 3,000 seeded engagements, ties and all-null
-- histories included, before either statement was changed.
--
-- `findAppliedRollforwardRun` never had the expression — it filters
-- `applied_at IS NOT NULL` in the WHERE and orders on the column — and was
-- reading the whole history anyway, for want of an index leading with
-- `(valuation_id, applied_at)`. It gets the partial index that predicate makes
-- available; the other two cannot use a partial one, because a null
-- `applied_at` is an answer there (the newest run of any kind, when nobody has
-- adopted).
--
-- ── Measured ───────────────────────────────────────────────────────────────
--
-- 160k rows in each table, 60k valuations, one engagement 300 runs deep
-- (EXPLAIN ANALYZE, warm):
--
--     findCurrentVolatilityEstimate  1.95 ms, 300 rows / 312 blocks -> 0.038 ms, 1 row / 4
--     findCurrentProjection          0.95 ms, 300 rows / 316 blocks -> 0.028 ms, 1 row / 4
--     findAppliedRollforwardRun      0.44 ms, 300 index rows / 305  -> 0.017 ms, 1 row / 4
--
-- The row count is the claim, not the millisecond: the old plans are O(runs on
-- this engagement) and the new ones are O(1). `adoptedRunPlan.test.ts` asserts
-- it as a difference — deepen every history and the rows read must not move —
-- and keeps the expression-led spelling as its discriminator.
--
-- All three are on the report render path, in the one `Promise.all` that
-- assembles a 409A (routes/reports.ts), and the first two are also behind the
-- volatility and projection panels.
--
-- The column order is copied from the statements rather than chosen, including
-- NULLS placement: 0170's rule is that a mixed ordering costs a sort node
-- however well the leading key is indexed, and `CREATE INDEX` takes a direction
-- and a NULLS placement per column so the whole list can be matched.
--
-- Not CONCURRENTLY: db/migrate.ts wraps each file in BEGIN/COMMIT. These three
-- tables hold one row per tool run on an engagement, which is the smallest
-- population of anything indexed since 0170.

CREATE INDEX IF NOT EXISTS volatility_estimates_adopted_idx
    ON volatility_estimates (valuation_id, applied_at DESC NULLS LAST, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS valuation_projections_adopted_idx
    ON valuation_projections (valuation_id, applied_at DESC NULLS LAST, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS rollforward_runs_adopted_idx
    ON rollforward_runs (valuation_id, applied_at DESC, id DESC)
    WHERE applied_at IS NOT NULL;
