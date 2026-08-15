-- The retry guard that let the retry through.
--
-- `partner_api_idempotency` (0102) exists so a partner client whose POST timed
-- out can send it again without creating a second engagement. It recorded the
-- response *after* the work: look the key up, miss, run, then
-- `INSERT … ON CONFLICT DO NOTHING`.
--
-- That closes the sequential retry and leaves the concurrent one wide open,
-- which is the one the feature is named after. A timeout is not a signal that
-- the request finished — it is a signal that the client stopped waiting — so
-- the retry routinely goes out while the original is still running. Both
-- requests look the key up, both miss, both create a valuation, and then the
-- second `INSERT` hits the primary key and DOES NOTHING: the collision that is
-- the only evidence anything went wrong is swallowed by the clause written to
-- swallow it. Two engagements, one invoice dispute — the exact outcome 0102's
-- own comment describes — and the ledger holds one row, so nothing downstream
-- can tell it happened. A double-clicked submit behind a partner's own UI is
-- the same shape.
--
-- The fix is to make the key a *claim* taken before the work rather than a
-- receipt written after it. The row is inserted first with no response on it;
-- the winner of the insert runs the request and fills the response in; anyone
-- else finds the row already there and is told either the stored answer (if it
-- has one) or that the original is still in flight. Postgres's primary key is
-- what arbitrates, which is what makes it a decision rather than a reading.
--
-- Two columns' worth of schema change:
--
--   * `response_status` / `response_body` become nullable, because a claimed
--     key has no response yet. NULL is precisely "in flight" and needs no
--     separate state column to say so.
--
--   * `completed_at` stamps when the response arrived. Nullable for the same
--     reason, and it is what the housekeeping sweep ages a spent record on:
--     `created_at` now means "when this claim was taken", which a takeover
--     moves.
--
-- A claim whose process dies mid-request would otherwise hold the key forever.
-- It is reclaimable instead: an unfinished claim older than the takeover window
-- can be taken over by a later request, so a crash costs that key a few minutes
-- rather than permanently burning it. The window has to be longer than any
-- request can legitimately take and short enough that a partner is not stuck —
-- `PARTNER_IDEMPOTENCY_STALE` in repos/partnerWebhooks.ts holds the value.
--
-- Existing rows are completed by definition: every one of them was written from
-- a finished response.

ALTER TABLE partner_api_idempotency
  ALTER COLUMN response_status DROP NOT NULL,
  ALTER COLUMN response_body DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS completed_at timestamptz;

UPDATE partner_api_idempotency
   SET completed_at = created_at
 WHERE completed_at IS NULL;

-- The housekeeping sweep's access path: every record older than the retention
-- window, across all partners. Without it that is a sequential scan of a table
-- nothing else ever reads in bulk.
CREATE INDEX IF NOT EXISTS partner_api_idempotency_created_idx
  ON partner_api_idempotency (created_at);
