-- Five operator lists that were capped but not bounded.
--
-- R187 put a `LIMIT` on every list endpoint that lacked one, and R166 fixed the
-- `ORDER BY` spellings that took the valuation list off its indexes. Between
-- them they leave a shape neither was looking at: a list with a perfectly good
-- cap, ordered by a column that no index leads with. The cap makes the
-- *response* small. It does nothing to the work — Postgres still reads the whole
-- table and sorts it to find out which rows the cap keeps — so the endpoint's
-- cost is the table's size and its output is a screenful, and it degrades
-- invisibly because nothing about the response changes as it does.
--
-- Five of them, all on tables that only ever grow, measured at 40k valuations /
-- 30k users / 20k invoices / 15k subscriptions (EXPLAIN ANALYZE, warm, shared
-- blocks):
--
--     listAllInvoices        11.9 ms  2102 blk  ->  0.68 ms  1007 blk   17x
--     listActiveEngagements  18.2 ms  2895 blk  ->  1.34 ms  1813 blk   13x
--     listInvitations         7.1 ms  1857 blk  ->  1.08 ms  1459 blk    7x
--     listAllSubscriptions    3.0 ms  2050 blk  ->  0.71 ms  1003 blk    4x
--     SCIM GET /Users         2.6 ms  1561 blk  ->  0.001 ms    1 blk  876x
--
-- The residual blocks in the first four are the join to `users` — one primary
-- key probe per row returned, which is the cost of a page rather than the cost
-- of the table, and is what the number was supposed to be all along.
--
-- ## invoices, subscriptions, user_invitations
--
-- Three admin ledgers, all `ORDER BY <a timestamp> DESC LIMIT`. `invoices` has
-- `(user_id, issued_at DESC)`, which serves one customer's history and cannot
-- serve the platform-wide ledger — a leading column the query does not
-- constrain is a leading column the planner cannot use. `subscriptions` and
-- `user_invitations` had nothing on their sort column at all.
--
-- One caveat these three share, learned the expensive way while measuring: an
-- index that supplies the ordering turns a hash join into a nested loop, and a
-- nested loop under a `LIMIT` walks until it has found *n joinable* rows. If the
-- join can fail it can walk the whole index and be slower than the seq scan it
-- replaced — which is what happens on a database where `subscriptions.plan_tier`
-- names a plan that is not in `plan_limits`. It is safe here because all three
-- joins are on `NOT NULL` foreign keys or are `LEFT JOIN`s, so every row of the
-- driving table produces a row. That is a property of these queries, not a
-- general licence: a sixth list joining on a nullable, unconstrained column
-- wants measuring rather than an index by analogy.
--
-- ## engagements
--
-- The firm pipeline board is `WHERE v.archived_at IS NULL AND e.current_stage <>
-- 'complete' ORDER BY e.stage_entered_at ASC, e.id ASC LIMIT`. `engagements_stage_idx
-- (current_stage)` cannot serve `<>` — an inequality on a low-cardinality column
-- is not a range a btree can seek — so the board hash-joined every engagement
-- against every live valuation and sorted the result to take 200 rows off the
-- front.
--
-- Partial on the board's own predicate rather than an index on `current_stage`,
-- because `<> 'complete'` is the whole selection and a partial index expresses
-- it exactly while also shrinking with every engagement that finishes: the index
-- holds open work, and open work is bounded by how much a firm can have in
-- flight, where the table is bounded by how long the firm has existed.
--
-- `(stage_entered_at, id)` in that order, matching the board's tiebreaker, both
-- ascending — 0170's rule, that a mixed-direction ordering costs a sort node
-- however well the leading column is indexed, applies to a two-term ordering as
-- much as to the eight it was written about.
--
-- Nothing is added for `eachActiveEngagement`, the overdue sweep that reads the
-- same join. It pages on `e.id` and already reaches `engagements_pkey`
-- (measured: 226 index rows for a 200-row page), so the sweep was never the
-- reader with the problem.
--
-- ## SCIM
--
-- `GET /scim/v2/Users` unfiltered lists the directory-provisioned accounts, and
-- there is no index on `provisioned_by`, so an IdP's periodic reconciliation read
-- every user row on the platform to find them. Partial rather than plain: SCIM
-- accounts are a small minority of `users` in any deployment and zero in most,
-- so the whole index is a handful of pages and costs nothing to maintain on the
-- overwhelming majority of user writes, which never set the column.
--
-- The `created_at DESC` term is what makes it a lookup rather than a scan of the
-- partial index — the route takes the 200 newest — and it is deliberately *not*
-- restricted to live accounts. The route selects `deleted_at` and returns
-- deprovisioned accounts as `active: false`, which is what SCIM's own model asks
-- for; a `WHERE deleted_at IS NULL` here would be the third index on `users`
-- that the query cannot use.

CREATE INDEX IF NOT EXISTS invoices_issued_at_idx
    ON invoices (issued_at DESC);

CREATE INDEX IF NOT EXISTS subscriptions_created_at_idx
    ON subscriptions (created_at DESC);

CREATE INDEX IF NOT EXISTS user_invitations_created_at_idx
    ON user_invitations (created_at DESC);

CREATE INDEX IF NOT EXISTS engagements_open_stage_entered_idx
    ON engagements (stage_entered_at, id)
    WHERE current_stage <> 'complete';

CREATE INDEX IF NOT EXISTS users_scim_provisioned_idx
    ON users (created_at DESC)
    WHERE provisioned_by = 'scim';
