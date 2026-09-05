-- Two ILIKE arms 0149 did not reach, each one degrading a query beside it.
--
-- R435 (methodology M8) profiled the global search box and the document
-- search box on 20k-row tables. Both were sequential scans, and neither one
-- is new: 0149 indexed `company_name`, `email` and the full-name expression,
-- and its own comment called `company_name` out as the predicate reused by
-- "the global search (repos/search.ts), the firm dashboard's filter
-- (repos/firmDashboard.ts) and the shared inbox's (repos/inbox.ts)" — but
-- `searchValuations` (repos/search.ts) ORs `company_name ILIKE $1` with
-- `service_name ILIKE $2` in the very same WHERE clause, and an OR with one
-- unindexed arm cannot be served by a bitmap index scan at all: Postgres has
-- no access path for the disjunction as a whole, so it falls back to reading
-- every row and evaluating both arms in a filter. Measured on 20k rows,
-- seeded the same way 0149's own test seeds them: 24ms and 466 buffer reads
-- with the trigram index sitting right there unused, because the plan is
-- decided for the whole OR, not per arm.
--
-- `documents.filename` never had a query it could be indexed for at 0149 —
-- `searchDocuments` (repos/search.ts) is what R207 (see
-- n409-import-batch-surfaces) later added the search box for — and it has
-- been a sequential scan since. `filename ILIKE '%q%'` is the *only* text
-- predicate in that query, so this one is not even hidden behind an OR; every
-- keystroke into the document search box has read every row in the table.
-- Measured the same way: 5.6ms and 466 buffer reads on 20k documents for a
-- single hit.
--
-- Same GIN-over-trigram device as 0149, for the same reason: a leading
-- wildcard has no prefix a b-tree could use, cost tracks selectivity instead
-- of table size, and these columns are read far more than written.
--
-- Guarded the same way 0149 is, even though pg_trgm is already installed by
-- that migration in every environment that has run it: a database that took
-- 0149's warning path (extension absent, or insufficient privilege) recorded
-- 0149 as applied without creating the extension, and this migration must not
-- assume a later environment fixed that silently.
--
-- Not CONCURRENTLY: db/migrate.ts wraps each file in BEGIN/COMMIT and
-- CREATE INDEX CONCURRENTLY cannot run inside a transaction block. Same trade
-- as every index since 0056 — a SHARE lock that blocks writes to the table
-- while it builds and leaves reads alone.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm') THEN
        RAISE WARNING 'pg_trgm absent: service_name/filename search stays on sequential scans (see migration 0207)';
        RETURN;
    END IF;

    -- ── 1. Service name ─────────────────────────────────────────────────────
    --
    -- The second arm of `searchValuations`'s company/service disjunction.
    -- Not partial on `archived_at IS NULL` for the same reason 0149's
    -- `company_name` index is not: the predicate is applied by the caller, and
    -- the planner can still combine this index with it under a bitmap AND.
    EXECUTE 'CREATE INDEX IF NOT EXISTS valuations_service_name_trgm_idx
                 ON valuations USING gin (service_name gin_trgm_ops)';

    -- ── 2. Document filename ────────────────────────────────────────────────
    --
    -- `searchDocuments` filters `d.deleted_at IS NULL` before this predicate,
    -- but not partial for the same reason as above — the planner combines
    -- indexes rather than needing one that already encodes every predicate.
    EXECUTE 'CREATE INDEX IF NOT EXISTS documents_filename_trgm_idx
                 ON documents USING gin (filename gin_trgm_ops)';
END
$$;
