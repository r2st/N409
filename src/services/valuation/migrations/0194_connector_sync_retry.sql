-- A scheduled connector that failed once stopped syncing forever.
--
-- `recordSyncError` writes `status = 'error'`, and both scheduled connectors
-- find their work with `WHERE status = 'connected' AND next_sync_at <= now()`.
-- Nothing moves a connection back. So a single 503 from Carta at three in the
-- morning, a thirty-second timeout, a provider's brief rate limit — any of them
-- ended the daily sync permanently, and the only thing that could restart it
-- was a person pressing "Import now" or reconnecting.
--
-- Nothing said so. The panel drew the card as "Connected", with the cadence
-- select still reading "Daily", above one line of small red text quoting a
-- status code from an hour or a month ago. Both halves of that are being fixed
-- in this round; this column is the server half.
--
-- WHY A COUNTER AND NOT JUST A RETRY TIME. Retrying a failing connection on its
-- ordinary cadence is the wrong shape in both directions: fifteen-minute ticks
-- against a provider that is down is how a rate limit becomes a longer one, and
-- waiting a full week to retry a weekly sync that failed on a blip is a week of
-- stale data. A count of consecutive failures gives the backoff something to
-- grow from — 15m, 30m, 1h, 2h, 4h, then 8h — and success resets it.
--
-- The authorisation failures are deliberately *not* retried at all: a refresh
-- token the provider has refused will be refused identically forever, so those
-- clear `next_sync_at` and wait for a human. That distinction is made in code
-- (`ReconnectRequiredError`), not here.
--
-- Additive and defaulted, per the estate's rollback rule: the previous release
-- neither reads nor writes this column, and a row that predates the migration
-- starts at zero, which is what "has not failed since it last succeeded"
-- means.

ALTER TABLE hris_connections
    ADD COLUMN IF NOT EXISTS sync_failures integer NOT NULL DEFAULT 0;

ALTER TABLE cap_table_connections
    ADD COLUMN IF NOT EXISTS sync_failures integer NOT NULL DEFAULT 0;
