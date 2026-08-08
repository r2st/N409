-- Four unrelated columns and one table, all of them the missing half of
-- something already shipped.

-- ── 1. Template categories ───────────────────────────────────────────────────
--
-- 0051 gave templates a `key` and nothing else to sort by, so twelve of them
-- listed alphabetically: `draft_ready` between `changes_requested` and
-- `email_verification`, with no way to see that the first and third belong to
-- two different halves of the product. The question an operator opens this
-- page asking is "what do we send a client who has stalled at payment", and
-- the answer is a group, not a key.
--
-- The categories are the lifecycle groups from domain/operations.ts, plus
-- `account` for the templates that are not about a valuation at all — password
-- reset, email verification, the seat invitation. Those three always deliver
-- (they bypass the notification-preference matrix, see emailWorkflows.ts), and
-- filing them under a lifecycle state would suggest a state gates them.
--
-- Deliberately a CHECK over text and not an enum: this is a display grouping
-- that will move as the product's pages move, and the enum-extension dance in
-- 0107/0111 is a high price for a column nothing joins on.
ALTER TABLE communication_templates
  ADD COLUMN category text NOT NULL DEFAULT 'account'
    CHECK (category IN ('account', 'open', 'in_review', 'drafted', 'published', 'closed'));

-- Backfill the six workflow keys to the state whose entry sends them (the
-- RULES map in domain/emailWorkflows.ts), and leave everything else on the
-- `account` default. `changes_requested` fires when a client rejects a draft,
-- which is a `draft_changes` transition — still the drafted group.
UPDATE communication_templates SET category = CASE key
  WHEN 'valuation_started'   THEN 'open'
  WHEN 'review_needed'       THEN 'in_review'
  WHEN 'draft_ready'         THEN 'drafted'
  WHEN 'changes_requested'   THEN 'drafted'
  WHEN 'valuation_completed' THEN 'published'
  WHEN 'valuation_cancelled' THEN 'closed'
  ELSE category
END;

-- The listing groups by category and orders inside it.
CREATE INDEX communication_templates_category_idx ON communication_templates (category, key);

-- ── 2. Partner commercial terms ──────────────────────────────────────────────
--
-- Two facts about a partner that ops currently keep somewhere this system
-- cannot see.
--
-- `prepaid` says the firm has already paid for its engagements in bulk, so a
-- valuation arriving under it must never be shown a payment link — it is the
-- partner-level form of `paid_by_partner`, decided once per firm rather than
-- once per file.
--
-- `cc_emails` is the firm's shared mailbox. A white-label firm's client
-- correspondence goes to the client; the firm needs a copy of it, and today
-- the only way they get one is a mail rule on somebody's personal account.
-- Text array rather than a joined table: it is a handful of addresses per
-- firm, edited as a block on one form, and never queried by address.
ALTER TABLE partners
  ADD COLUMN prepaid boolean NOT NULL DEFAULT false,
  ADD COLUMN cc_emails text[] NOT NULL DEFAULT '{}';

-- ── 3. Comment read state ────────────────────────────────────────────────────
--
-- `valuations.last_comment_at` records when a thread last moved. What it
-- cannot say is whether *this* reader has seen it, which is the only question
-- an inbox asks. Per (reader, valuation) rather than per comment: a thread is
-- read as a thread, and a row per comment per reader would grow with the
-- product of both for an answer nobody asks at that resolution.
--
-- Deleting the user deletes their read marks; deleting the valuation deletes
-- everyone's. Neither is data anyone can miss.
CREATE TABLE valuation_comment_reads (
  user_id      ulid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  valuation_id ulid NOT NULL REFERENCES valuations(id) ON DELETE CASCADE,
  last_read_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, valuation_id)
);

-- "Which threads have moved since I last looked" — the inbox's own query,
-- driven from the reader's side.
CREATE INDEX valuation_comment_reads_user_idx
  ON valuation_comment_reads (user_id, last_read_at DESC);

-- The inbox lists comments across every valuation in reverse chronological
-- order, which 0020's per-valuation index cannot serve.
CREATE INDEX valuation_comments_recent_idx ON valuation_comments (created_at DESC);
