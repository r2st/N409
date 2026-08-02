-- Invoice numbers were sequenced by counting the month's existing rows
-- immediately before inserting the next one:
--
--   SELECT count(*) FROM invoices WHERE date_trunc('month', issued_at) = ...
--
-- That is a read followed by a write with no atomicity between them, and
-- `invoices.number` is UNIQUE. Two deliveries landing together both counted N
-- and both built INV-YYYYMM-000(N+1); the loser's insert raised a unique
-- violation, the billing webhook's catch-all swallowed it, and Stripe was told
-- 200 — so it never redelivered and a paid invoice was simply missing from the
-- billing record.
--
-- The trigger is not an unlikely interleaving. Subscriptions renew in bulk at a
-- period boundary and Stripe fans those invoice.paid events out concurrently,
-- so the widest window is the busiest moment of the billing month.
--
-- A counter row per period makes the allocation atomic: ON CONFLICT DO UPDATE
-- takes a row lock, so concurrent allocators serialise on it and each leaves
-- with its own number.
CREATE TABLE invoice_sequences (
  -- YYYYMM, matching the segment invoiceNumber() puts in the number itself.
  period text PRIMARY KEY,
  seq    integer NOT NULL CHECK (seq >= 0)
);

-- Seed from what has already been issued so numbering continues where the old
-- count(*) left off rather than restarting at 1 and colliding with live rows.
--
-- Seeded from the highest suffix actually present in `number`, not from
-- count(*). count(*) is what produced the collisions in the first place and it
-- is only equal to the highest number issued when nothing was ever deleted and
-- no gap was ever left — and this change exists precisely because gaps and
-- losses did occur. Taking the maximum guarantees the next allocation is
-- greater than every number already issued for that period.
--
-- Grouped by the period embedded in the number rather than by issued_at,
-- because those two could disagree: the number's month came from toISOString()
-- (UTC) while the old counting query bucketed with date_trunc(..., now()) in
-- the server's timezone, so either side of a month boundary on a non-UTC server
-- they named different months. The number is what has to stay unique, so the
-- number is what seeds the counter.
INSERT INTO invoice_sequences (period, seq)
SELECT substring(number from '^INV-([0-9]{6})-'),
       max(substring(number from '^INV-[0-9]{6}-([0-9]+)$')::integer)
FROM invoices
WHERE number ~ '^INV-[0-9]{6}-[0-9]+$'
GROUP BY 1;
