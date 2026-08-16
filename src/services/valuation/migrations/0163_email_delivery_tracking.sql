-- The outbox knows what it handed to the relay, and nothing after that.
--
-- `status` is the *send attempt's* outcome: 'sent' means the relay answered 250
-- after DATA. That is a handoff, not a delivery, and the two are routinely
-- different — a 250 from the smarthost followed by an asynchronous DSN half a
-- minute later is the ordinary way a wrong address fails. Nothing in this
-- service ever reads that DSN, so every such message sits in the table marked
-- 'sent' forever and the operator's only evidence that the client never got
-- their report is the client saying so.
--
-- Worse, it is not inert. 0159 gave failed rows a retry ladder with a reach of
-- ~8.5 hours, and the ladder cannot tell "the relay was down" from "this
-- mailbox does not exist". A permanently dead address that fails *at* the relay
-- burns all six attempts over most of a working day, and the next message to
-- the same address starts the whole ladder again. The ladder is right for an
-- outage and wrong for a bad address, and it has no way to know which it has.
--
-- So: keep `status` as the attempt outcome — the ladder's SQL switches on it,
-- and overloading it with 'bounced' would put a delivery fact into a column
-- that means "what happened when we tried" — and add the delivery track beside
-- it. A message is sent *and then* delivered, or sent *and then* bounced, or
-- delivered *and then* opened. Those are not alternative values of one state,
-- and modelling them as one enum is how you end up unable to say that a
-- delivered message was later marked as spam.

-- Hard is terminal and suppresses the address; soft is the ladder's business
-- (a full mailbox, a greylist, a temporary DNS failure) and must keep retrying;
-- a complaint is a human pressing "spam" — not a delivery failure at all, and
-- the one signal that must stop us sending hardest of all.
CREATE TYPE email_bounce_kind AS ENUM ('hard', 'soft', 'complaint');

CREATE TYPE email_delivery_event_kind AS ENUM (
  'delivered',
  'bounced',
  'complained',
  'deferred',
  'opened'
);

ALTER TABLE email_outbox
  ADD COLUMN delivered_at    timestamptz,
  ADD COLUMN bounced_at      timestamptz,
  ADD COLUMN first_opened_at timestamptz,
  ADD COLUMN last_opened_at  timestamptz,
  ADD COLUMN open_count      integer NOT NULL DEFAULT 0,
  ADD COLUMN bounce_kind     email_bounce_kind,
  ADD COLUMN bounce_detail   text;

COMMENT ON COLUMN email_outbox.delivered_at IS
  'When a downstream signal confirmed mailbox delivery. NULL on a row that was '
  'merely accepted by the relay — sent_at is that, and the two are not the same '
  'fact. Only a provider webhook or an inbound DSN can set this.';

COMMENT ON COLUMN email_outbox.bounce_kind IS
  'Set from the delivery ledger. hard/complaint are terminal: the retry claim '
  'skips such a row and the address goes on email_suppressions. soft leaves the '
  '0159 ladder alone, because a full mailbox is exactly what it is for.';

COMMENT ON COLUMN email_outbox.open_count IS
  'Tracking-pixel fetches. A floor, not a count: image blockers hide real opens '
  'and caching proxies invent ones. Never present it as a per-person figure.';

-- The append-only record every column above is derived from.
--
-- Derived rather than authoritative because the columns answer "what is true of
-- this message now" and a provider will happily send the same event twice, out
-- of order, or contradict itself (delivered, then a bounce from a forwarding
-- hop). Keeping the raw events means the current state can be recomputed and an
-- argument with a provider can be settled from what they actually sent.
CREATE TABLE email_delivery_events (
  id                ulid PRIMARY KEY,
  outbox_id         ulid NOT NULL REFERENCES email_outbox(id) ON DELETE CASCADE,
  kind              email_delivery_event_kind NOT NULL,
  -- When the provider says it happened, which is not when we heard about it.
  -- A webhook retried across an outage of ours can arrive hours late, and
  -- ordering the ledger by arrival would reorder the story.
  occurred_at       timestamptz NOT NULL,
  received_at       timestamptz NOT NULL DEFAULT now(),
  -- 'webhook:<provider>', 'dsn', or 'pixel'. Part of the idempotency key
  -- because two providers' event ids share no namespace.
  source            text NOT NULL,
  -- The provider's own id for this event. NULL for signals that have none
  -- (a pixel fetch), and NULLs do not collide in a UNIQUE — which is correct
  -- here: every pixel fetch is a distinct real event, while a redelivered
  -- webhook carrying an id we have already stored is the same one twice.
  provider_event_id text,
  bounce_kind       email_bounce_kind,
  detail            text,
  UNIQUE (source, provider_event_id)
);

CREATE INDEX email_delivery_events_outbox_idx
  ON email_delivery_events (outbox_id, occurred_at DESC);

-- The stats endpoint aggregates by kind over a window.
CREATE INDEX email_delivery_events_kind_idx
  ON email_delivery_events (kind, occurred_at DESC);

-- Addresses we will not send to again until a human says otherwise.
--
-- This is the half that makes bounce tracking worth having. Recording that a
-- message bounced only documents the failure; refusing to send the *next* one
-- is what stops a dead address quietly eroding the sending reputation that
-- every other client's mail depends on.
--
-- The column is `to_email` rather than the more natural `address` so that it
-- inherits the pino redaction path the outbox column already has. fc4e43c found
-- fourteen role-named address columns logging in the clear; a fifteenth named
-- something new would be the same bug with a new name.
CREATE TABLE email_suppressions (
  to_email    text PRIMARY KEY,
  reason      email_bounce_kind NOT NULL,
  detail      text,
  -- The message that caused it, for the operator who has to judge whether the
  -- suppression is right. SET NULL rather than CASCADE: retention deleting the
  -- offending message must not silently un-suppress the address.
  outbox_id   ulid REFERENCES email_outbox(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  -- A release is a row that stays, so the history of "this was suppressed and
  -- an admin lifted it" survives the lifting.
  released_at timestamptz,
  released_by ulid REFERENCES users(id) ON DELETE SET NULL
);

COMMENT ON TABLE email_suppressions IS
  'Addresses that hard-bounced or complained. Checked at enqueue; a suppressed '
  'address yields a skipped row rather than a send. A released row (released_at '
  'set) no longer suppresses but is kept for the trail.';

-- The claim in claimRetryableEmails now also has to exclude terminally bounced
-- rows. Adding bounce_kind to the retry index keeps that predicate on the index
-- rather than making the planner fetch the heap to discard a dead row.
CREATE INDEX email_outbox_deliverable_idx
  ON email_outbox (next_attempt_at, status, created_at)
  WHERE status IN ('failed', 'queued') AND bounce_kind IS NULL;

-- Delivery-rate reporting reads sent rows over a window and left-joins the
-- delivery columns; without this it is a seq scan over the whole outbox.
CREATE INDEX email_outbox_delivery_stats_idx
  ON email_outbox (created_at DESC)
  INCLUDE (status, delivered_at, bounced_at, first_opened_at);
