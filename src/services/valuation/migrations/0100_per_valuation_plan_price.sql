-- The per-valuation plan quoted a price nobody is ever charged.
--
-- `plan_limits` was seeded in 0080 with per_valuation at 200000 cents ($2,000).
-- Nothing charges that. The one-time flow in routes/payments.ts prices by
-- product kind — DEFAULT_PRICE_CENTS: 409A $1,190, SMB/FMV $990, ASC 718 and
-- ASC 820 $1,490, everything else the $990 fallback — and the public marketing
-- site quotes the same figures. Three sources agree; the plan seed was the
-- outlier, and it is the one the signed-in customer sees.
--
-- The damage is on the Billing screen. SubscriptionSection renders every row of
-- this table as a price card, so a customer with no subscription read "Per
-- valuation — $2,000.00" and was then charged $1,190 at the Stripe page. That
-- is a 68% overstatement on the flagship product, on the last screen before
-- checkout, and it surfaces on the first live charge — the REVISION note has
-- carried it as an open gap since the payments work landed.
--
-- The tier has no single true price: it is one row standing for a catalogue
-- whose prices differ by product. So the honest figure is the entry price, and
-- the UI reads a `one_time` interval as "From $X" rather than a flat quote —
-- which is accurate for every kind, since 99000 is both the cheapest listed
-- product and the fallback for kinds with no explicit price.
--
-- The seeded figure is asserted against priceForKind() by
-- test/integration/planPricing.test.ts, so the two cannot drift apart again
-- without a failing test naming this row.
UPDATE plan_limits
   SET price_cents = 99000
 WHERE tier = 'per_valuation'
   AND price_cents = 200000;
