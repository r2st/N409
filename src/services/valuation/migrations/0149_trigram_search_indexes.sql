-- The `%q%` half of the search box, which no b-tree could ever serve.
--
-- 0148 indexed the `workflow_id` arm of the engagement search and said what it
-- was leaving behind: "`company_name ILIKE '%q%'` cannot use a b-tree, and
-- fixing that needs pg_trgm, which is a superuser-privileged CREATE EXTENSION
-- this runner is not in a position to promise." The first half of that is still
-- true. The second half stopped being true in PostgreSQL 13, which made pg_trgm
-- a *trusted* extension: the database owner can install it without superuser,
-- and `n409` owns the database in every environment (`createdb -O n409`, see
-- infra/backup/README.md). This runs as that owner.
--
-- A leading-wildcard ILIKE is the one pattern a b-tree cannot help with at all
-- — there is no prefix to descend on, so every row is read and matched. Every
-- search box in the product is a leading-wildcard ILIKE, so every one of them
-- was a sequential scan whose cost grew with the platform.
--
-- A GIN index over trigrams inverts that: the pattern is cut into three-
-- character grams, each gram is a key, and the rows that contain all of them
-- are the candidate set the recheck runs on. Cost tracks the selectivity of the
-- query rather than the size of the table. GIN rather than GiST because these
-- columns are read far more than they are written and GIN's lookups are the
-- faster of the two; the write cost is bounded by `fastupdate`, which is on by
-- default.
--
-- Not CONCURRENTLY: db/migrate.ts wraps each file in BEGIN/COMMIT and CREATE
-- INDEX CONCURRENTLY cannot run inside a transaction block. Same trade as every
-- index since 0056 — a SHARE lock that blocks writes to the table while it
-- builds and leaves reads alone.


-- ── The extension ───────────────────────────────────────────────────────────
--
-- Guarded rather than bare. Being trusted means the owner *may* install it; it
-- does not mean the binary is on disk (pg_trgm ships in postgresql-contrib,
-- which a minimal image can omit) or that a future environment will connect as
-- the owner. Either of those turns a bare CREATE EXTENSION into a migration
-- that throws, and a migration that throws on boot is an outage — for an index
-- whose absence only ever costs latency.
--
-- So the two failures that mean "this database cannot have pg_trgm" are caught
-- and warned about, and the indexes below are skipped rather than attempted.
-- Everything else still propagates. The searches stay correct either way: the
-- predicates in `src/repos` are unchanged by this file, they just keep the plan
-- they have today.
--
-- To recover a database that took the warning path: install the extension by
-- hand (`CREATE EXTENSION pg_trgm;` as a role that can), then run the indexes
-- from this file. They are `IF NOT EXISTS`, so re-running is safe, and
-- 0149_trigram_search_indexes is already recorded either way — this file will
-- not run itself again.
DO $$
BEGIN
    CREATE EXTENSION IF NOT EXISTS pg_trgm;
EXCEPTION
    -- 42501: connected as a role that is neither superuser nor the owner.
    WHEN insufficient_privilege THEN
        RAISE WARNING 'pg_trgm: not permitted for %, trigram indexes skipped', current_user;
    -- 58P01: the control file is not on disk (contrib not installed).
    WHEN undefined_file THEN
        RAISE WARNING 'pg_trgm: not installed on this server, trigram indexes skipped';
END
$$;


DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm') THEN
        RAISE WARNING 'pg_trgm absent: search stays on sequential scans (see migration 0149)';
        RETURN;
    END IF;

    -- ── 1. Company name ─────────────────────────────────────────────────────
    --
    -- The most-reused predicate in the product: `company_name ILIKE '%q%'` is
    -- the engagement search (repos/valuations.ts), the global search
    -- (repos/search.ts), the firm dashboard's filter (repos/firmDashboard.ts)
    -- and the shared inbox's (repos/inbox.ts). Four call sites, one column, and
    -- a scan behind every one of them.
    --
    -- Not partial on `archived_at IS NULL`, though three of the four callers
    -- add that predicate. A partial index would exclude the archive from the
    -- one search that deliberately includes it, and the planner can combine
    -- this index with the `archived_at` condition under a bitmap AND anyway.
    EXECUTE 'CREATE INDEX IF NOT EXISTS valuations_company_name_trgm_idx
                 ON valuations USING gin (company_name gin_trgm_ops)';

    -- ── 2. User email ───────────────────────────────────────────────────────
    --
    -- `users_email_key` is a unique b-tree and serves an exact address. It
    -- cannot serve `email ILIKE '%q%'`, which is what every user search
    -- actually sends — an operator types the local part, or the customer's
    -- domain, not the whole address.
    EXECUTE 'CREATE INDEX IF NOT EXISTS users_email_trgm_idx
                 ON users USING gin (email gin_trgm_ops)';

    -- ── 3. User full name ───────────────────────────────────────────────────
    --
    -- An expression index, because the thing searched is two columns joined by
    -- a space: nobody types a last name into a box expecting only the last name
    -- to be matched, so "ada lovelace" has to match across the pair.
    --
    -- The expression is the `coalesce(…) || ' ' || coalesce(…)` form rather
    -- than `concat_ws(' ', …)`, and that is not a style choice: concat_ws is
    -- STABLE, not IMMUTABLE — it takes `any` and has to call each type's output
    -- function — so an index cannot be built on it at all. `||` and `coalesce`
    -- over two text columns are immutable, so this form can be. Three call
    -- sites were on concat_ws and have been moved onto this one; see
    -- `userFullNameSql` in src/db/like.ts for what that changed.
    --
    -- It has to match the query expression structurally for the planner to use
    -- it, which is why both come from that one helper rather than being written
    -- out twice.
    EXECUTE 'CREATE INDEX IF NOT EXISTS users_full_name_trgm_idx
                 ON users USING gin (
                     (coalesce(first_name, '''') || '' '' || coalesce(last_name, ''''))
                     gin_trgm_ops
                 )';
END
$$;
