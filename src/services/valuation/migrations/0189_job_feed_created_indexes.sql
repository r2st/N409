-- The unified job feed sorted 60,000 rows on disk to draw twenty-five.
--
-- `listJobs` (repos/jobs.ts) is the Published Tasks page: a UNION ALL over five
-- queue tables, `ORDER BY j.created_at DESC LIMIT 25`. Postgres plans that well
-- when it can — it builds a Merge Append, walks each branch backwards on an
-- index, and stops as soon as the merge has a page. A branch with no index on
-- `created_at` cannot be walked backwards, so it is read in full and sorted
-- first, and one such branch is enough: the merge cannot produce its first row
-- until every input can.
--
-- One of the five had an index it could use. `email_outbox` gets there through
-- 0182's covering index, which leads with `created_at DESC` for a different
-- reader. The other four had `created_at` only as the *second* column of a
-- composite led by `valuation_id`, which answers "this engagement's history"
-- and not "the newest work anywhere".
--
-- Measured on 300k outbox rows and 60k AI jobs (EXPLAIN ANALYZE, warm):
--
--     before  37.3 ms   Seq Scan on ai_jobs, external merge sort, Disk: 8272kB
--     after    0.23 ms  Index Scan, 19 rows read from ai_jobs
--
-- The disk line is the shape of it: the sort spilled, so the page cost the
-- table plus a write. Both numbers are for the page query; the `count(*)` that
-- accompanies it is a full aggregate of the union either way (14.7 ms here) and
-- no index changes that — it is what `total` means.
--
-- All four rather than the one that was slow. The empty tables in that
-- measurement are not empty in production and grow the same way — a calculation
-- per engine run, a pipeline run per trigger, a delivery per partner event —
-- and the branch that stalls a Merge Append is whichever one is unindexed, not
-- whichever one is largest. Sizing them one at a time as they hurt would mean
-- rediscovering this plan four times.
--
-- DESC to match the ORDER BY exactly. A btree is readable in both directions,
-- so ASC would serve the scan; DESC is spelled out because it is also what the
-- merge needs to be told, and R166 is the standing lesson on sort spellings
-- that look equivalent and are not.
--
-- Not CONCURRENTLY: db/migrate.ts wraps each file in BEGIN/COMMIT and CREATE
-- INDEX CONCURRENTLY cannot run inside a transaction block. Same trade as every
-- index since 0056 — a SHARE lock that blocks writes while it builds. All four
-- are written by background workers rather than by a person's request, so a
-- build long enough to matter stalls a queue and not a page.

CREATE INDEX IF NOT EXISTS ai_jobs_created_idx
    ON ai_jobs (created_at DESC);

CREATE INDEX IF NOT EXISTS pipeline_runs_created_idx
    ON pipeline_runs (created_at DESC);

CREATE INDEX IF NOT EXISTS calculations_created_idx
    ON calculations (created_at DESC);

CREATE INDEX IF NOT EXISTS partner_webhook_deliveries_created_idx
    ON partner_webhook_deliveries (created_at DESC);
