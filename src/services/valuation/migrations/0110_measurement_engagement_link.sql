-- Link a fund portfolio / debt instrument to the engagement it is measured for.
--
-- Follows 0109, which added the `fund` and `debt` values to valuation_kind.
-- This migration deliberately does not USE either value — no backfill, no
-- constraint naming them — because Postgres forbids using an enum value added
-- in the same transaction, and the runner wraps each migration in one.
--
-- 0086 and 0087 built the two measurement domains as standalone ops tools:
-- a fund is marked to NAV, an instrument is priced, and both live in their own
-- tables keyed to nothing. That was right for the tool and wrong for the
-- deliverable. `fund` and `debt` are two of the fifteen valuation kinds, and a
-- client who commissions one gets an engagement with a lifecycle, a reviewer,
-- an invoice and a report — a report that, until now, could not print a single
-- figure, because nothing connected the engagement to the portfolio whose NAV
-- it is about. Both kinds fell back to the generic skeleton (domain/report.ts,
-- TEMPLATE_BY_KIND) and rendered with no exhibits at all.
--
-- The link is nullable in both directions on purpose. Ops mark funds and price
-- instruments without an engagement all the time — a prospect's portfolio, a
-- sanity check on a covenant — and requiring an engagement would make the
-- measurement tools unusable for the thing they were built for. What the link
-- adds is: when it IS set, the report knows what to read.
--
-- ON DELETE SET NULL rather than CASCADE. A valuation is soft-deleted and its
-- measurement history is the evidence behind opinions we have already issued;
-- deleting the engagement must never take the marks with it.

ALTER TABLE fund_portfolios
  ADD COLUMN valuation_id ulid REFERENCES valuations(id) ON DELETE SET NULL;

ALTER TABLE debt_instruments
  ADD COLUMN valuation_id ulid REFERENCES valuations(id) ON DELETE SET NULL;

-- At most one measurement subject per engagement, enforced rather than assumed:
-- the report renderer reads "the" fund for a valuation, and two would make the
-- deliverable depend on row order. Partial, because unlinked rows are the norm.
CREATE UNIQUE INDEX fund_portfolios_valuation_uniq
  ON fund_portfolios (valuation_id) WHERE valuation_id IS NOT NULL;

CREATE UNIQUE INDEX debt_instruments_valuation_uniq
  ON debt_instruments (valuation_id) WHERE valuation_id IS NOT NULL;
