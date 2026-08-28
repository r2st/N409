-- The two foreign keys the outbox purge turned expensive.
--
-- 0174 made `email_outbox` a table something deletes from. That is the exact
-- event `foreignKeyIndexCensus.test.ts` was written to catch, and it caught it:
-- `auto_email_sends.outbox_id` and `email_suppressions.outbox_id` both
-- reference `email_outbox` with no index behind the column, so every purged row
-- asked Postgres to prove no send record and no suppression still pointed at
-- it, and Postgres read both tables end to end to answer. Once per row.
--
-- The scale is what makes this worth a migration rather than a note. The purge
-- runs in batches over a backlog that has been accumulating since the platform
-- started, so the first enforced `email_outbox` policy is not one delete — it
-- is thousands, each paying two sequential scans. `email_suppressions` is the
-- one that hurts twice over: it grows with every hard bounce and complaint, it
-- is never trimmed (a suppression is a permanent fact about an address), and it
-- is read on the send path, so the scans compete with outbound mail.
--
-- `email_suppressions.outbox_id` is `ON DELETE SET NULL`, so the scan is not
-- even the whole cost there: Postgres finds the referencing rows in order to
-- write them, and it was finding them by reading the table. `auto_email_sends`
-- has no action clause, so its scan exists only to prove a negative.
-- (`email_delivery_events.outbox_id` cascades and was indexed by 0163, which is
-- why the census names two crossings and not three.)
--
-- Indexes rather than an `EXEMPT` entry, for the reason 0171 gives: the census
-- keeps an empty exemption list on purpose. R92's conclusion — that 85
-- unindexed foreign keys are fine because this schema hard-deletes almost
-- nothing — is load-bearing and invisible, and it survives only while every
-- crossing is closed rather than excused. An exemption here would be the first
-- entry on a list whose emptiness is the whole guarantee.
--
-- Both are plain single-column indexes on a nullable FK. `outbox_id` is null on
-- a suppression an administrator added by hand and on a send that predates the
-- link, and neither index needs those rows — but a partial index would have to
-- be spelled identically in both places and gains a few pages at the cost of a
-- rule the next reader has to notice. Not worth it at this size.

CREATE INDEX IF NOT EXISTS auto_email_sends_outbox_id_idx
    ON auto_email_sends (outbox_id);

CREATE INDEX IF NOT EXISTS email_suppressions_outbox_id_idx
    ON email_suppressions (outbox_id);
