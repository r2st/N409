-- The firm console's attention band read the whole platform to show twenty rows.
--
-- `attentionCandidates` (repos/firmDashboard.ts) is:
--
--     WHERE v.partner_id = $1 AND v.archived_at IS NULL AND v.state = ANY($2)
--     ORDER BY v.due_date ASC NULLS LAST, v.created_at ASC
--     LIMIT $3
--
-- and it is served on two endpoints, not one: `GET /api/v1/firm/attention` runs
-- it, and `GET /api/v1/firm/dashboard` runs it again as part of the console's
-- first paint. So a firm partner opening their console pays for it twice.
--
-- There was no index with `partner_id` in front of `due_date`, so Postgres took
-- the ordering from `valuations_due_date_idx` and filtered the partner out
-- afterwards — walking the whole book in due-date order and discarding the 87%
-- of it belonging to other firms before it could stop. Measured on 40k
-- valuations with 12k under the firm (EXPLAIN ANALYZE):
--
--     before   21.2ms   Index Scan valuations_due_date_idx, Rows Removed 34667
--     after     0.08ms  Index Scan valuations_live_partner_due_idx, Rows Removed 25
--
-- 265x, and the shape matters more than the number: the cost before scaled with
-- the *platform's* size, so every firm's console got slower as unrelated firms
-- signed up. After, it scales with the depth this firm's own book has to be
-- read to fill one screen.
--
-- No `NULLS LAST` in the index definition, deliberately, and it is not an
-- oversight of the kind 0170 was written about: a btree ASC is already stored
-- NULLS LAST, so `due_date ASC NULLS LAST` is the index's own order and the
-- clause is satisfied rather than defeated. (`due_date DESC NULLS LAST` is the
-- spelling that needs its own index, and 0170 added it.)
--
-- `state = ANY(...)` is left out of the index. It is a five-of-fourteen
-- disjunction that changes with `ACTIVE_STATES`, it filters roughly a third of
-- the rows, and putting it after the ordering columns would not let it be an
-- index condition anyway. As a residual filter it costs 25 discarded rows.

CREATE INDEX IF NOT EXISTS valuations_live_partner_due_idx
  ON valuations (partner_id, due_date, created_at)
  WHERE archived_at IS NULL;
