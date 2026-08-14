-- Two read paths that had no index behind them.
--
-- Both were found by walking every WHERE and ORDER BY in `src/repos` against
-- `pg_indexes`, rather than from a slow query — which is the point: neither is
-- slow on a development database and both are linear in a table that only
-- grows.
--
-- Not CONCURRENTLY: db/migrate.ts wraps each file in BEGIN/COMMIT and
-- CREATE INDEX CONCURRENTLY cannot run inside a transaction block. Same trade
-- as every index since 0056 — a SHARE lock that blocks writes to the table
-- while it builds and leaves reads alone.


-- ── 1. Search by workflow id ────────────────────────────────────────────────
--
-- `buildValuationWhere` (repos/valuations.ts) matches the search box against
-- `workflow_id` on both of its branches:
--
--   (id = $1 OR workflow_id = $1)                       -- the query is a ULID
--   (company_name ILIKE $1 OR workflow_id = $2 OR ...)  -- anything else
--
-- `workflow_id` is the id the engagement carries in the *previous* platform,
-- so it is what an operator pastes when they are reconciling the two — and it
-- had no index at all, on either branch. The ULID branch is the one that
-- matters: `id = $1` alone is a primary-key lookup, and OR-ing an unindexed
-- column to it takes the whole disjunction off the index and onto a sequential
-- scan of `valuations`. So the cheapest lookup in the product was paying for
-- the most expensive one sitting next to it.
--
-- The text branch stays a scan regardless — `company_name ILIKE '%q%'` cannot
-- use a b-tree, and fixing that needs pg_trgm, which is a superuser-privileged
-- CREATE EXTENSION this runner is not in a position to promise. This index is
-- still the right half of it: a bitmap OR can serve the `workflow_id` arm from
-- the index while the ILIKE arm scans.
--
-- Partial, because the column is null for every engagement created on this
-- platform rather than migrated onto it. Equality never matches null, so the
-- excluded rows are rows no query using this index could want, and the index
-- stays sized by the migrated subset instead of by the table.
CREATE INDEX valuations_workflow_id_idx
    ON valuations (workflow_id)
 WHERE workflow_id IS NOT NULL;


-- ── 2. The admin console's user list ────────────────────────────────────────
--
-- `listUsers` (repos/adminUsers.ts) is `WHERE u.deleted_at IS NULL ORDER BY
-- u.created_at DESC LIMIT/OFFSET`, and `users` had no index on `created_at` in
-- either direction — only `users_email_key` and the two partial unique indexes
-- on provisioning ids. Every page of the console sorted the whole table.
--
-- Matching the default predicate makes it partial the same way 0140's does for
-- `valuations`: soft-deleted accounts are excluded from the list unless asked
-- for, they accumulate and are never removed, and they sort among the live
-- rows rather than after them. `include_deleted=true` drops the predicate and
-- falls back to a scan, which is correct — that view is an audit tool nobody
-- pages through, not the console's own list.
--
-- DESC in the definition to match the query, though it is not load-bearing: a
-- b-tree reads in either direction. It is here so the plan reads the way the
-- statement does.
--
-- The index alone was not enough. LIMIT cannot be pushed under the GROUP BY
-- that builds each row's role array, so the old single-statement form
-- aggregated every matching user before sorting and could not use this index
-- for the ordering at all. `listUsers` now pages `users` in a CTE and joins
-- the roles onto that page — see the comment there.
CREATE INDEX users_live_created_idx
    ON users (created_at DESC)
 WHERE deleted_at IS NULL;
