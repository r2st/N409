-- The six sections of an Art. 15 export that read a whole table to find one
-- person's rows.
--
-- `buildPersonalExport` (repos/dataExport.ts) fans out ~20 section queries
-- under a single `Promise.all`. Each one asks the same question of a different
-- table — "which of these rows are about this subject" — and fourteen of them
-- answer it from an index. Six did not, because nothing indexed the column the
-- subject is named in:
--
--     documents.uploaded_by            no index (FK to users)
--     valuation_comments.author_id     no index (FK to users)
--     valuation_signatures.signer_user_id  no index (FK to users)
--     email_outbox.to_user_id          no index (FK to users)
--     contact_submissions.email        reached by lower(email), no index
--     user_invitations.email           reached by lower(email); the only index
--                                      on it is partial to still-open invites
--
-- Those six are also, not coincidentally, the largest tables the export
-- touches. `email_outbox` holds every message the platform has ever sent,
-- `documents` every file ever uploaded, `valuation_comments` every note and
-- every ingested inbound email. So a subject access request scanned the four
-- biggest tables in the schema end to end, and did it *concurrently* — the
-- `Promise.all` means all six scans are in flight at once against a pool of
-- ten connections (`DB_POOL_MAX`), so one export can hold six of them for the
-- length of the longest scan while ordinary requests queue behind it.
--
-- Measured at 40k valuations / 30k users / 60k outbox rows (EXPLAIN ANALYZE,
-- shared blocks, warm):
--
--     documents by uploader           2.31 ms  2106 blk  ->  0.01 ms  20 blk
--     comments by author              1.34 ms  1225 blk  ->  0.01 ms  18 blk
--     signatures by signer            0.63 ms   540 blk  ->  0.01 ms   9 blk
--     outbox by recipient             2.60 ms  1863 blk  ->  0.01 ms   4 blk
--     contact submissions by address  6.76 ms   260 blk  ->  0.01 ms   6 blk
--     invitations by address          1.30 ms   248 blk  ->  0.01 ms   6 blk
--
-- The milliseconds are small because the tables are small; the block counts are
-- the number that matters, because they are what grows. Every one of these was
-- reading the entire table to return a handful of rows, so the cost of an export
-- was the size of the platform rather than the size of the subject's footprint.
--
-- Each index carries the section's own `ORDER BY` column as its second term, so
-- the sort goes away with the scan rather than being left behind as a top-N over
-- whatever the index returned. `created_at DESC` in the index rather than ASC:
-- a btree is readable in both directions, but spelling it the way the query asks
-- for it keeps the two side by side for the next reader, and 0170's lesson is
-- that a sort clause which *looks* satisfied is exactly the one that is not.
--
-- Four of the six are foreign keys to `users`, which crosses R92's standing
-- conclusion that 85 unindexed foreign keys are fine here. That conclusion is
-- untouched: it is an argument about the cost of *deleting a parent*, and
-- `foreignKeyIndexCensus.test.ts` enforces it against the tables something
-- actually deletes from — a set these four are not in and are not joining.
-- These are indexed for the other reason an unindexed foreign key can cost
-- something, the one R154 went looking for: the column is also a filter
-- predicate, and a predicate is a sequential scan whatever the delete story is.
-- R154 checked seven candidates for that and found seven false positives, so
-- the conclusion recorded from it was "clean" rather than "clean, as far as the
-- scan reached". These six are what the scan did not reach.
--
-- Which is why the census added alongside this migration asks the question from
-- the other end rather than repeating the sweep. `personalExportIndexCensus`
-- reads the export's own source for the predicates it actually issues and
-- requires the catalog to have an index leading with each one, so a seventh
-- section added to `dataExport.ts` is under the obligation on the day it is
-- written instead of on the day somebody next goes looking.

CREATE INDEX IF NOT EXISTS documents_uploaded_by_idx
    ON documents (uploaded_by, created_at DESC);

CREATE INDEX IF NOT EXISTS valuation_comments_author_idx
    ON valuation_comments (author_id, created_at DESC);

CREATE INDEX IF NOT EXISTS valuation_signatures_signer_idx
    ON valuation_signatures (signer_user_id, signed_at DESC);

CREATE INDEX IF NOT EXISTS email_outbox_to_user_idx
    ON email_outbox (to_user_id, created_at DESC);

-- `lower(email)` rather than `email`: the join folds both sides, and an index on
-- the bare column cannot serve a folded comparison. (`email_suppressions` is the
-- counter-example already in the tree — its `to_email` is normalised on write,
-- so the export compares it bare and reaches the primary key.)
CREATE INDEX IF NOT EXISTS contact_submissions_email_idx
    ON contact_submissions (lower(email), created_at DESC);

-- `user_invitations_pending_email_key` already indexes `lower(email)`, but only
-- `WHERE accepted_at IS NULL AND revoked_at IS NULL` — that is the uniqueness
-- rule for open invitations, and it excludes every invitation that was accepted,
-- which is precisely the one an account holder's export is looking for.
CREATE INDEX IF NOT EXISTS user_invitations_email_idx
    ON user_invitations (lower(email), created_at DESC);
