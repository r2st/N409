-- The outbox retried on a fixed cadence, so every attempt landed in one outage.
--
-- `claimRetryableEmails` takes any 'failed' row under the attempt ceiling, and
-- `settleClaimedEmail` clears `claimed_at` the moment a send fails — released
-- on purpose, with a comment saying the row is then "picked up by the next
-- sweep instead of waiting one out". Nothing else spaces the attempts, so the
-- retry schedule is the sweep interval and nothing more.
--
-- EMAIL_RETRY_SCAN_MINUTES defaults to 30 and EMAIL_RETRY_MAX_ATTEMPTS to 5, so
-- a message went terminal about two hours after the first attempt, with all
-- five attempts inside the same two hours. Against the failure this sweep was
-- written for — a relay that is down, not an address that is wrong — that is
-- five attempts at one outage and then the message is gone. It is the same
-- fault 0139 found in the webhook ladder ("every incident longer than half an
-- hour ... dropped the partner's events permanently"), on the path that carries
-- the client's report-is-ready mail rather than a partner's event feed.
--
-- `next_attempt_at` is when the row may be claimed again. NULL means now: that
-- is what a fresh row carries, what a 'queued' row stranded by a crash carries,
-- and what every row already in the table carries after this migration — so the
-- backlog stays claimable and the ladder starts applying from the next failure
-- rather than retroactively grounding anything.
--
-- A row that has spent its ladder is stamped NULL as well, and stays out of the
-- claim on the attempt ceiling alone, as before. Terminal is expressed once, by
-- `attempts >= max_attempts`, so a raised ceiling still lets an old row be
-- retried rather than leaving it pinned behind a schedule nothing will revisit.

ALTER TABLE email_outbox
  ADD COLUMN next_attempt_at timestamptz;

COMMENT ON COLUMN email_outbox.next_attempt_at IS
  'Earliest time a retry sweep may claim this row again. NULL means no wait — a '
  'fresh row, or one whose retry ladder is spent (the attempt ceiling holds it).';

-- The claim's WHERE, restated with the new column in it. The old index led on
-- (status, created_at, claimed_at); the schedule is now the most selective term
-- of the three for a backlog under an outage — every failed row shares one
-- status and they are claimable one ladder step at a time — so it leads here,
-- and `created_at` stays as the ORDER BY the claim reads oldest-first on.
CREATE INDEX email_outbox_retry_idx
  ON email_outbox (next_attempt_at, status, created_at)
  WHERE status IN ('failed', 'queued');
