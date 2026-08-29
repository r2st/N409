-- The covering index that stopped covering.
--
-- 0163 built `email_outbox_delivery_stats_idx` for one reader: the email
-- dashboard, which calls `deliveryStats` and `deliveryStatsByTemplate` side by
-- side under one `Promise.all`. Both aggregate the same `created_at >= now() -
-- N days` window, and the index was written to answer them from itself —
-- `(created_at DESC) INCLUDE (status, delivered_at, bounced_at,
-- first_opened_at)`, the range in the key and every column the counts needed
-- along for the ride.
--
-- Then the counts grew two columns the INCLUDE list did not. `deliveryStats`
-- gained `complained` and split `bounced` away from it, both reading
-- `bounce_kind`; `deliveryStatsByTemplate` groups by `template_key`. Neither is
-- in the index, so Postgres could still use it to *find* the window and then
-- had to visit the heap for every row in it. The plan still says
-- "Index Scan using email_outbox_delivery_stats_idx" — which is why nothing
-- looked wrong — but it is no longer an *Index Only* Scan, and the heap it
-- visits is the whole window.
--
-- This is the failure mode of a covering index generally: it degrades when the
-- query changes, not when the index does, and it degrades quietly, because the
-- index is still named in the plan and the answers stay correct. Only the block
-- count moves.
--
-- Measured at 200k rows over ~139 days, 43k of them inside the default 30-day
-- window (EXPLAIN ANALYZE, warm, shared blocks):
--
--     deliveryStats            1282 blk  ->  317 blk   4.0x
--     deliveryStatsByTemplate  1065 blk  ->  318 blk   3.3x
--
-- Times move less — 11.2 ms -> 7.3 ms on the grouped one, and the ungrouped one
-- is within noise — because on a database small enough to measure on, the heap
-- those blocks name is already in shared buffers. The blocks are the honest
-- number here: `email_outbox` is 29 MB at this size against an 11 MB index, it
-- is the table on this schema that grows fastest, and the dashboard reading it
-- is not the workload the cache is being kept warm for.
--
-- The cost is 12% on the index — 9816 kB to 11 MB — paid on every queued mail.
-- Both added columns are narrow (`bounce_kind` is an enum, `template_key` is a
-- short identifier from a fixed vocabulary), and INCLUDE columns are not part
-- of the search key, so no existing plan can change shape because of them: the
-- index answers exactly what it answered before, plus these two.
--
-- Not CONCURRENTLY: db/migrate.ts wraps each file in BEGIN/COMMIT and CREATE
-- INDEX CONCURRENTLY cannot run inside a transaction block. `email_outbox` is
-- written by the mail sweep and by request handlers enqueueing notifications,
-- so the SHARE lock while this rebuilds does hold up writes — but an enqueue is
-- a background side effect of a request, never the thing the request returns,
-- and the sweep retries. Dropped and recreated rather than reindexed because
-- the INCLUDE list is part of the definition.

DROP INDEX IF EXISTS email_outbox_delivery_stats_idx;

CREATE INDEX IF NOT EXISTS email_outbox_delivery_stats_idx
    ON email_outbox (created_at DESC)
    INCLUDE (status, delivered_at, bounced_at, bounce_kind, first_opened_at, template_key);
