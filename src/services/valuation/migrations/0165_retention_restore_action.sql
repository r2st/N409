-- `restored` as a retention action.
--
-- `archived_at` is the platform's soft delete for an engagement, and until now
-- nothing ever set it back to NULL. Two things stamp it: the retention sweep
-- when a policy period runs out, and `retireValuations` when a firm withdraws
-- a piece of work. R89 guarded all 86 writes against a stamped row and wrote
-- the consequence down: with no way back, every one of those refusals is
-- permanent, so an engagement archived by a mistyped id or by a policy set too
-- aggressively is gone from the product for good. Users have `restoreUser` and
-- partners have their own unarchive; the aggregate that actually holds a
-- client's work had neither.
--
-- `valuationPurge.ts` had claimed the reverse in a comment since it was
-- written — "It is also reversible, which a delete is not" — which was true of
-- the schema and false of the codebase.
--
-- The action log is what makes a restore reviewable. `retention_actions` is
-- append-only by construction (nothing updates or deletes it) and already
-- records every archival, so a restore recorded beside its archival is the
-- whole story of the row in one place, in order. The CHECK is widened rather
-- than dropped: the point of the constraint is that a typo'd action name fails
-- the INSERT instead of becoming a category nothing queries.

ALTER TABLE retention_actions DROP CONSTRAINT IF EXISTS retention_actions_action_check;
ALTER TABLE retention_actions ADD CONSTRAINT retention_actions_action_check
  CHECK (action IN ('archived', 'skipped_hold', 'purge_eligible', 'restored'));
