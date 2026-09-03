-- R395 — the retention sweep could not delete a drip campaign's mail.
--
-- `auto_email_sends.outbox_id` (0051) was declared `ulid REFERENCES
-- email_outbox(id)` with no delete action, which is NO ACTION: the referenced
-- row cannot be deleted while the reference stands. `auto_email_sends` is
-- append-only — it is the campaign ledger `sendsForValuations` reads to honour
-- `max_sends` and `repeat_hours`, so deleting from it would re-send drips —
-- and nothing has ever deleted from it.
--
-- `purgeExpiredOutbox` deletes settled `email_outbox` rows older than the
-- operator's retention policy. A drip send is settled the moment it leaves, so
-- the first campaign message to age past the window makes that DELETE raise
--
--   update or delete on table "email_outbox" violates foreign key constraint
--   "auto_email_sends_outbox_id_fkey" on table "auto_email_sends"
--
-- and the sweep's whole transaction — the held count, the delete and the
-- retention action log, which R289 put in one — rolls back with it.
--
-- IT DOES NOT RECOVER ON THE NEXT PASS. The DELETE takes `ORDER BY
-- e.created_at ASC LIMIT $3`, so the batch it tries is always the oldest
-- eligible messages, which is exactly where the blocked rows are. One aged
-- drip send stops the outbox purge permanently: the backlog then grows without
-- limit, and the retention policy an operator set stops being enforced for
-- every message behind it, including the ones a subject asked to have removed.
--
-- SET NULL rather than CASCADE. The send record is the fact "this campaign
-- fired for this engagement at this time", and it has to outlive the message —
-- CASCADE would delete the ledger row and re-arm a drip that has already been
-- sent. The column is a pointer to the mail for tracing, nullable since 0051,
-- written null by `recordAutoEmailSend` whenever the enqueue produced no row,
-- and read by nothing. A purged message's pointer becoming NULL says what is
-- true: the message is gone.
--
-- This is the reading `email_delivery_events` and `email_suppressions` (0163)
-- were given the day they were written — CASCADE for the events that are only
-- about the message, SET NULL for the suppression that outlives it. This table
-- predates both and never got the question asked of it.

ALTER TABLE auto_email_sends
  DROP CONSTRAINT IF EXISTS auto_email_sends_outbox_id_fkey;

ALTER TABLE auto_email_sends
  ADD CONSTRAINT auto_email_sends_outbox_id_fkey
    FOREIGN KEY (outbox_id) REFERENCES email_outbox(id) ON DELETE SET NULL;
