-- Every call this service makes to the engine and AI tiers, per engagement
-- (409.ai §11, "Network Items").
--
-- What this answers that nothing else does
-- ----------------------------------------
-- The platform records the *results* of upstream work — a calculation row, a
-- research row, an extraction — and each of those is written only when the call
-- succeeded. A call that failed, timed out, or was retried leaves no row at
-- all. So the questions asked during an incident ("did we ever ask the engine
-- for this?", "what did the AI tier actually send back before we rejected
-- it?", "how long was that pipeline taking before it stopped?") are answerable
-- today only from stdout, on the host, inside the retention window of whatever
-- collects it — and not per engagement, which is how the question is always
-- framed.
--
-- Scope, stated honestly
-- ---------------------
-- This records the calls *this service issues*: valuation → engine-wrapper and
-- valuation → ai. It does not record the calls the AI service then makes to
-- OpenRouter or to the search provider, because those happen inside another
-- process and this table is written at our own HTTP boundary. 409.ai's tabs
-- listed those onward providers by name; reproducing that would mean the AI
-- service reporting its own upstream calls back to us, which is a separate
-- change. `service` is therefore the tier we called, not the vendor it used.
--
-- Payload bounds
-- --------------
-- `request` and `response` are the real payloads, bounded before insert (see
-- `domain/boundedJson.ts`) rather than stored whole. An engine compute request
-- carries the entire cap table and every projection period; kept verbatim on
-- every call, this table would outgrow the data it describes within a week.
-- The bound keeps the head of long lists and records what it dropped, which is
-- what a reader needs to know a tail existed.
--
-- Diagnostic only. Nothing reads this to produce a figure, and no report cites
-- it. That is what lets it be pruned (see `pruneNetworkItems`) without the
-- append-only argument that governs `market_research` and `qa_reviews`.
CREATE TABLE IF NOT EXISTS network_items (
  id            text PRIMARY KEY,
  valuation_id  text NOT NULL REFERENCES valuations(id) ON DELETE CASCADE,
  -- The tier called: 'engine' or 'ai'. Not a CHECK constraint — a new internal
  -- service should start being recorded the day it is added, not the day
  -- someone remembers to ship a migration widening an enum.
  service       text NOT NULL,
  -- The logical operation, supplied by the call site: 'engine compute',
  -- 'ai extract', 'engine sensitivity'. This is the column the list is read by,
  -- so it is the call site's job to name the call the way an operator would
  -- ask about it, rather than deriving something from the URL path.
  name          text NOT NULL,
  request       jsonb,
  response      jsonb,
  -- HTTP status, or NULL when there was never a response to have one: a refused
  -- connection or our own deadline firing. `error` says which.
  status        integer,
  error         text,
  duration_ms   integer NOT NULL,
  -- The same id sent as `x-request-id`, so a row here joins to the engine's and
  -- the AI service's own log lines for the same call.
  request_id    text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- The list view: one engagement, newest first, optionally filtered to a tier.
CREATE INDEX IF NOT EXISTS network_items_valuation_created_idx
  ON network_items (valuation_id, created_at DESC);

COMMENT ON TABLE network_items IS
  'Outbound engine/AI calls per engagement: request, response, status, duration. Diagnostic only — never read to produce a figure, and prunable.';
