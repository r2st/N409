-- Partner webhook delivery retries.
--
-- 0102 recorded one attempt per event and stopped there. A partner whose
-- receiver was down for the ninety seconds a publish happened to land in
-- learned about it only by reading their delivery log — the event itself was
-- gone. Every other durable send path in this service (the email outbox, 0095)
-- already claims, backs off and retries; deliveries were the one that did not.
--
-- The shape is deliberately the outbox's, because the failure modes are the
-- same ones and were solved there already:
--
--   * `attempts` is counted at CLAIM, not at settlement, so a delivery whose
--     POST hangs and never reports back still burns one. Counting on
--     settlement lets a receiver that always times out be retried forever.
--   * `claimed_at` is a lease, not a status. A sweeper that dies mid-POST
--     leaves the stamp behind and the row becomes claimable again when it
--     expires, so there is no wedged state needing its own reaper.
--   * `next_attempt_at` is the backoff. A row is invisible to the sweep until
--     its time comes, which is what makes exponential backoff a predicate
--     rather than a sleep somewhere.
--
-- Status now means: 'pending' = will be tried again (either never attempted, or
-- attempted and waiting on next_attempt_at); 'delivered' = done; 'failed' =
-- terminal, out of attempts. Rows written before this migration were terminal
-- the moment they were marked, so 'failed' keeps exactly the meaning it had for
-- them and no backfill can resurrect an event whose payload is now stale.

ALTER TABLE partner_webhook_deliveries
  -- When the sweep may next take this row. Set on insert to now() so a row the
  -- process crashed on between the INSERT and the POST is picked up on the very
  -- next pass rather than waiting out a backoff it never earned.
  ADD COLUMN next_attempt_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN claimed_at timestamptz,
  -- Per-row so a partner's ceiling can be raised for one troublesome endpoint
  -- without changing the default for everyone. 4 = the initial attempt plus the
  -- three backoff steps in domain/partnerWebhooks.ts (1 min, 5 min, 30 min).
  ADD COLUMN max_attempts integer NOT NULL DEFAULT 4 CHECK (max_attempts BETWEEN 1 AND 10);

-- Existing rows are history: they were settled under the one-shot rule and must
-- not become retryable now. A 'failed' row is already terminal by status; a
-- 'pending' row from before this migration is one a crash stranded, and those
-- SHOULD be swept — but their payload describes a transition that may be many
-- deploys old, so they are retired rather than replayed.
UPDATE partner_webhook_deliveries
   SET status = 'failed',
       last_error = coalesce(last_error, 'abandoned: predates delivery retries')
 WHERE status = 'pending';

-- The claim reads pending rows whose backoff has elapsed, oldest first. Leading
-- with status keeps the scan on the small live set; a partner's delivery log
-- grows without bound and is overwhelmingly 'delivered'.
CREATE INDEX partner_webhook_deliveries_claim_idx
  ON partner_webhook_deliveries (status, next_attempt_at, claimed_at)
  WHERE status = 'pending';
