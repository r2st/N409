-- Per-valuation header counters (design §4.6, P2-17) — the "Pending files" half.
--
-- The catalog's detail header carries four counters: pending files, my tasks,
-- all tasks, chat. Three of them are queries over data that already exists.
-- "Pending files" is not: a document row records that a file arrived and
-- nothing records that an analyst has looked at it, so the only number the
-- platform could produce was "how many documents are there", which is not a
-- count of anything pending and would never fall to zero.
--
-- `reviewed_at` is that missing fact and nothing more. It is deliberately not
-- an approval, a status enum or a workflow: an analyst has either taken the
-- file into account or has not, and modelling that as a lifecycle would invite
-- a "rejected" state whose meaning — the file is wrong? the client must resend
-- it? — nothing downstream could act on.
--
-- Nullable and unset for everything already uploaded, on purpose. Backfilling
-- `now()` would say every file on the platform has been reviewed, which is
-- false for exactly the engagements where it matters; backfilling from
-- `created_at` would say the same thing in a way that also looks deliberate.
-- An open engagement's existing files show as pending because they are.
--
-- `reviewed_by` is kept even though `valuation_events` also records the actor:
-- the header renders the counter on every page load and joining an event
-- stream to answer "who cleared this" per row is a query nobody would write.

ALTER TABLE documents ADD COLUMN reviewed_at timestamptz;
ALTER TABLE documents ADD COLUMN reviewed_by ulid REFERENCES users(id);

-- The counter's query: live documents on one engagement that nobody has
-- cleared. Partial because the reviewed rows are the ones it never returns and
-- they are, over time, most of the table.
CREATE INDEX documents_pending_review_idx
  ON documents (valuation_id)
  WHERE deleted_at IS NULL AND reviewed_at IS NULL;
