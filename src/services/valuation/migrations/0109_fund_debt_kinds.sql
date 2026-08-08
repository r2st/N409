-- The `fund` and `debt` valuation kinds.
--
-- domain/valuation.ts has listed fifteen VALUATION_KINDS since the measurement
-- domains landed (0086 fund portfolios, 0087 debt instruments). The database
-- enum has carried thirteen since 0001. Nothing reconciled them, so the two
-- newest kinds existed in the type system, in the intake registry
-- (intakeKinds.ts maps `fund` to the portfolio sections), in the selector and
-- in the pricing table — and could not be written to the `valuations` table at
-- all. `POST /api/v1/valuations` with kind `fund` did not 422; it reached
-- Postgres and came back as `invalid input value for enum valuation_kind`,
-- a 500. Every downstream feature for those kinds was unreachable behind it.
--
-- Appended rather than inserted mid-list: enum sort order is what `ORDER BY
-- kind` uses, and the thirteen existing kinds are in the order features.md
-- lists the product catalogue. Two measurement kinds sorting last is right.
--
-- Alone in its own migration on purpose, and for the same reason 0107 added
-- `paid` alone. Postgres permits ALTER TYPE ... ADD VALUE inside a transaction
-- (the runner wraps every migration in one) but forbids *using* the new value
-- there. Anything that needs to write one of these kinds — a backfill, a
-- constraint naming it, a seed — has to be a later migration. 0110 adds the
-- engagement link and is careful to touch only columns, never these values.

ALTER TYPE valuation_kind ADD VALUE IF NOT EXISTS 'fund';
ALTER TYPE valuation_kind ADD VALUE IF NOT EXISTS 'debt';
