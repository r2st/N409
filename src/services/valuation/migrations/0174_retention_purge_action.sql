-- `purged` as a retention action.
--
-- Feature 10 shipped five configurable data types and a sweep that implemented
-- one of them. `email_outbox` was among the four that did nothing: an operator
-- could set an age, tick enabled, and watch the setting save — and the table
-- would keep every address, subject and body ever sent, for as long as the
-- database existed. That is the shape of control that is worse than an absent
-- one, because a saved setting reads as an enforced setting.
--
-- The outbox is now purged under its policy (`runRetentionSweep`), which is a
-- destructive action and therefore one the log has to be able to name. The
-- CHECK is widened rather than dropped for the reason 0165 gives: an action
-- name nobody spelled correctly should fail the INSERT instead of quietly
-- becoming a category no reader queries.
--
-- `purge_eligible` stays in the list and stays unwritten. It is the other half
-- of the original design — mark, then let a human decide — and it is still the
-- right answer for `valuation`, whose records are the working papers behind a
-- filed 409A. The distinction the two names now carry is real: `purge_eligible`
-- says a record has aged past its policy, `purged` says it is gone.

ALTER TABLE retention_actions DROP CONSTRAINT IF EXISTS retention_actions_action_check;
ALTER TABLE retention_actions ADD CONSTRAINT retention_actions_action_check
  CHECK (action IN ('archived', 'skipped_hold', 'purge_eligible', 'restored', 'purged'));
