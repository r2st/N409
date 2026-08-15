-- An alert the ledger opened but nobody was ever told about.
--
-- 0120 built the alert ledger and `runJobAlertScan` notifies off the result of
-- reconciling it: `opened` and `resolved` are notified, `ongoing` is
-- deliberately silent because that silence is the whole anti-spam mechanism.
--
-- The two halves were not tied together. The reconcile transaction commits,
-- and only then does the scan loop over `opened` writing an admin event and a
-- notification per alert. Anything that throws in that loop — a transient
-- connection loss, a pool timeout while the database is under exactly the load
-- that stalled the queue in the first place — takes out the rest of the batch,
-- and the scan rejects. The schedule survives (`nonOverlapping` catches it),
-- but the ledger has already recorded those alerts as open, so the next scan
-- finds them `ongoing` and says nothing. The alert is not delayed; it is gone,
-- and the row in `job_alerts` says an operator was told.
--
-- That is the worst failure an alerting subsystem has, because it is silent and
-- it happens preferentially when the platform is already unwell.
--
-- The fix is to stop treating "reconciled" as "delivered" and give delivery its
-- own state. Notification is then driven off the ledger rather than off one
-- scan's return value: any open alert not yet announced is announced, whichever
-- scan gets to it, and the stamp below is written in the same transaction as
-- the admin event and the notification rows. Delivery becomes retriable and
-- idempotent instead of at-most-once.
--
-- `ongoing` stays silent for the reason it always was: an alert that has been
-- announced has `opened_notified_at` set, so it is not pending any more.

ALTER TABLE job_alerts
  ADD COLUMN IF NOT EXISTS opened_notified_at   timestamptz,
  ADD COLUMN IF NOT EXISTS resolved_notified_at timestamptz;

-- Backfill, and it has to be here rather than left to NULL.
--
-- Every row that exists when this migration runs was already handled by the old
-- at-most-once path, which left no record of what it delivered. Leaving these
-- NULL would make the first scan after deploy read the entire history of the
-- table as undelivered and re-announce all of it — one notification per
-- recipient per historical alert, which is the notification storm this
-- subsystem is otherwise designed to avoid. Assuming they were delivered can at
-- worst lose an alert that was already lost; assuming they were not re-sends
-- every alert the platform has ever fired.
UPDATE job_alerts SET opened_notified_at = opened_at
 WHERE opened_notified_at IS NULL;

UPDATE job_alerts SET resolved_notified_at = resolved_at
 WHERE resolved_at IS NOT NULL AND resolved_notified_at IS NULL;

-- The scan reads both of these every five minutes and they are empty almost
-- always, which is exactly the shape a partial index serves: the index holds
-- only the rows still owed an announcement, so the common case is a scan of
-- nothing rather than of the whole ledger.
CREATE INDEX IF NOT EXISTS job_alerts_pending_open_notify_idx
  ON job_alerts (opened_at) WHERE opened_notified_at IS NULL;

CREATE INDEX IF NOT EXISTS job_alerts_pending_resolved_notify_idx
  ON job_alerts (resolved_at) WHERE resolved_at IS NOT NULL AND resolved_notified_at IS NULL;

COMMENT ON COLUMN job_alerts.opened_notified_at IS
  'When the opening announcement was durably delivered; NULL means still owed, and the next scan will send it.';
COMMENT ON COLUMN job_alerts.resolved_notified_at IS
  'When the recovery announcement was durably delivered; NULL on a resolved alert means still owed.';
