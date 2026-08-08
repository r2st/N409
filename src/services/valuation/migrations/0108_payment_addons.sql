-- Payments record what was sold, not just what was charged.
--
-- The one-off checkout priced a flat DEFAULT_PRICE_CENTS[kind] and stored a
-- single `amount_cents`. The public pricing calculator, meanwhile, has always
-- offered express delivery (+$500) and a QSBS attestation letter (+$500) and
-- has always priced by capital raised — so a client configured an order on
-- /pricing that the checkout could not sell them, and the amount they were
-- charged had no recoverable relationship to the lines they picked.
--
-- Three things follow from one charge now having several lines:
--
--   `express` is a column and not a jsonb key because it is the one add-on
--   that changes what operations must DO. It moves the SLA from seven business
--   days to one, so the delivery queue has to sort on it, and a query that has
--   to reach into jsonb to find the engagements due tomorrow is the query that
--   eventually gets written wrong.
--
--   `qsbs_letter` sits beside it for symmetry and because the deliverable
--   checklist reads it — an engagement that bought the letter is not complete
--   until the letter exists.
--
--   `price_breakdown` holds the quote exactly as it was sold: entry price,
--   band uplift, each add-on. Prices move. A refund argued eighteen months
--   from now is about the ladder that was in force on the day, and recomputing
--   it from today's domain/pricing.ts would answer a different question. This
--   is also what the invoice PDF itemises, so the invoice and the charge
--   cannot drift.
--
-- Existing rows keep NULL breakdowns rather than a backfilled guess: they were
-- sold at a flat price with no add-ons, `amount_cents` is already the whole
-- truth about them, and a synthesised breakdown would be indistinguishable
-- from a real one.
ALTER TABLE payments
  ADD COLUMN express         boolean NOT NULL DEFAULT false,
  ADD COLUMN qsbs_letter     boolean NOT NULL DEFAULT false,
  ADD COLUMN price_breakdown jsonb;

-- The express delivery queue: succeeded express orders, newest first. Partial
-- because express is the rare case — most rows are false and indexing them
-- buys nothing.
CREATE INDEX payments_express_idx ON payments (created_at DESC) WHERE express;
