-- Every clickable column header in the workspace list was a sequential scan.
--
-- `ValuationsPage` renders seven sortable headers, `SORTABLE_COLUMNS` accepts
-- eight, and `GET /api/v1/valuations?sort=` is public API surface besides. On
-- 40k valuations with 36k of them live, measured with EXPLAIN (ANALYZE):
--
--     ORDER BY                       before      after
--     created_at DESC (default)       0.47ms     0.47ms   (already indexed)
--     number      DESC NULLS LAST    22.0ms      0.09ms
--     created_at  DESC NULLS LAST    30.1ms      0.10ms
--     company_name ASC NULLS LAST    26.1ms      0.06ms
--     paid_status  ASC NULLS LAST    25.7ms      0.09ms
--     kind         ASC NULLS LAST    16.1ms      0.08ms
--     state        ASC NULLS LAST     7.6ms      0.11ms
--     due_date    DESC NULLS LAST    40.7ms      0.10ms
--     published_at ASC NULLS LAST    19.1ms      0.09ms
--
-- Two separate causes, and both had to go.
--
-- The first is in `orderBySql`, not here: it spelled every custom sort term
-- `col DIR NULLS LAST`, including on the six sortable columns that are NOT
-- NULL, where the clause cannot move a row but does take the statement off
-- every index in the schema (a btree is stored ASC NULLS LAST, so backwards it
-- is DESC NULLS FIRST). That is why the two `created_at DESC` rows above differ
-- by 64x for byte-identical output — the default branch never had the clause.
-- Fixed there; see `NULLABLE_SORT_COLUMNS`.
--
-- The second is that a leading-column index does not serve `col DIR, id ASC`
-- anyway. The tiebreaker makes it a *mixed* ordering, which no single btree
-- produces in either direction, so it costs a sort node even when the leading
-- column is indexed — that is the residual 7-16ms on `kind` and `state`, which
-- were reaching `valuations_kind_idx` and still sorting. `orderBySql` now runs
-- the tiebreaker in the sort's own direction, and these indexes carry `id` as
-- their second column so the whole ORDER BY is one scan.
--
-- Partial on `archived_at IS NULL` because `buildValuationWhere` puts that on
-- every list; `includeArchived` (retention's own reporting) falls back to a
-- scan, which is right for a view nobody pages through.
--
-- Not CONCURRENTLY: db/migrate.ts wraps each file in BEGIN/COMMIT and CREATE
-- INDEX CONCURRENTLY cannot run inside a transaction block. Same trade as every
-- index since 0056.
--
-- The cost is 1000 measured inserts at 0.1775ms/row before and 0.1985ms/row
-- with all eight in place: 11.8%, or 21 microseconds of write for 25-40ms of
-- read on a control an operator clicks all day. `number` and `created_at` need
-- nothing added — `valuations_number_key` and `valuations_live_created_idx`
-- already serve them once the no-op `NULLS LAST` is gone.

-- ── NOT NULL columns: one index serves both directions ──────────────────────
--
-- With the tiebreaker following the sort, `(col, id)` read forwards is
-- `col ASC, id ASC` and read backwards is `col DESC, id DESC`. Both branches
-- of a single-term sort, one index.

CREATE INDEX valuations_live_company_name_idx
    ON valuations (company_name, id)
 WHERE archived_at IS NULL;

CREATE INDEX valuations_live_kind_idx
    ON valuations (kind, id)
 WHERE archived_at IS NULL;

CREATE INDEX valuations_live_state_idx
    ON valuations (state, id)
 WHERE archived_at IS NULL;

CREATE INDEX valuations_live_paid_status_idx
    ON valuations (paid_status, id)
 WHERE archived_at IS NULL;

-- ── Nullable columns: two, because NULLS LAST is real on these ──────────────
--
-- `due_date` and `published_at` genuinely hold nulls, so `orderBySql` keeps
-- `NULLS LAST` on them — an engagement with no deadline belongs at the end of a
-- deadline list, not the head of it. That is the one case a single index cannot
-- cover: ASC NULLS LAST and DESC NULLS LAST are not each other's reverse (the
-- reverse of ASC NULLS LAST is DESC NULLS FIRST). Each direction gets its own,
-- declared exactly as the statement spells it.

CREATE INDEX valuations_live_due_date_idx
    ON valuations (due_date, id)
 WHERE archived_at IS NULL;

CREATE INDEX valuations_live_due_date_desc_idx
    ON valuations (due_date DESC NULLS LAST, id DESC)
 WHERE archived_at IS NULL;

CREATE INDEX valuations_live_published_at_idx
    ON valuations (published_at, id)
 WHERE archived_at IS NULL;

CREATE INDEX valuations_live_published_at_desc_idx
    ON valuations (published_at DESC NULLS LAST, id DESC)
 WHERE archived_at IS NULL;
