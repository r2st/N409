-- R264 — which authorisation a sync's bookkeeping belongs to.
--
-- A pull is a long round trip against a third party, and a person reconnecting
-- is a thing that happens *during* one — often because the sync is what looked
-- wrong. `upsertConnection` installs new tokens, clears `sync_failures` and
-- `reconnect_required` and puts the schedule back; the in-flight pull, still
-- carrying the superseded credential, then lands afterwards and writes its
-- outcome over all of it.
--
-- The likely version is the damaging one: many providers invalidate the old
-- refresh token when a user re-authorises, so the credential the old pull holds
-- is refused *because of* the reconnect. That is terminal — `reconnect_required
-- = true`, `next_sync_at = NULL` — on a connection whose authorisation is
-- seconds old and working. The card reads "Reconnect required" over a healthy
-- connection and the schedule is dead until somebody reconnects again, which
-- can lose the same race again.
--
-- `status <> 'revoked'` cannot express this: it asks whether the connection has
-- ended, not whether this is still the same connection. `connected_at` is the
-- boundary in principle — only a reconnect moves it — but it cannot be the pin
-- in practice: a `timestamptz` holds microseconds and a JS Date holds
-- milliseconds, so a value read out and sent back never compares equal.
--
-- So the generation is counted rather than timed. `upsertConnection` bumps it;
-- a token refresh deliberately does not, because refreshing is the same
-- authorisation continuing. `recordSync` and `recordSyncError` carry the value
-- their pull started under and match on it.
--
-- Only the two scheduled families. `accounting_connections` is manual-import
-- only — no standing pull, no sync bookkeeping writers — so it has no in-flight
-- outcome that can outlive a reconnect.
ALTER TABLE hris_connections
  ADD COLUMN IF NOT EXISTS auth_generation integer NOT NULL DEFAULT 1;

ALTER TABLE cap_table_connections
  ADD COLUMN IF NOT EXISTS auth_generation integer NOT NULL DEFAULT 1;
