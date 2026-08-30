-- Which of the two failures a connector is in.
--
-- R252 split `status = 'error'` into two situations that call for opposite
-- things from the person reading the card:
--
--   * the provider was briefly unwell — a 503, a timeout, a rate limit — and
--     the connection is on a backoff with a time to try again. Nothing is
--     asked of anybody; it will resume by itself.
--   * the authorisation has ended. A refresh token the provider has refused
--     will be refused identically forever, so this one is deliberately never
--     retried and stays stopped until somebody redoes the OAuth hop.
--
-- 0194 recorded that distinction nowhere and said so: "made in code
-- (`ReconnectRequiredError`), not here". What reached the row was
-- `next_sync_at`, cleared for the second case — which is not the same fact.
-- A connection whose cadence is `manual` has no next-sync time in *either*
-- case, so for those the two states are indistinguishable on the row; and the
-- panel, which draws from the connection the API returns, had only `status` to
-- read. It drew every failure as "Not syncing" with a Reconnect button beside
-- it: told that, an analyst redoes an OAuth hop to fix a provider hiccup that
-- was going to clear on its own in fifteen minutes.
--
-- So the state is stored rather than inferred. Every failure states what it
-- knows — a transient refusal sets this false, because the request reached the
-- provider and came back with something other than a refusal of our
-- authorisation — and both a successful sync and a reconnect clear it.
--
-- Additive and defaulted, per the estate's rollback rule: the previous release
-- neither reads nor writes this column, and `false` is what "no reconnect has
-- been asked for" means for every row that predates the migration.

ALTER TABLE hris_connections
    ADD COLUMN IF NOT EXISTS reconnect_required boolean NOT NULL DEFAULT false;

ALTER TABLE cap_table_connections
    ADD COLUMN IF NOT EXISTS reconnect_required boolean NOT NULL DEFAULT false;
