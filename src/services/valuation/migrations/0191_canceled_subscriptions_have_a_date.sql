-- The terminal state without the date it was reached.
--
-- `canceled_at` was stamped by the two writers that *move* a subscription into
-- 'canceled' and by neither of the two that can *create* one already there. A
-- `customer.subscription.updated` carrying `status: 'canceled'` for a
-- subscription this platform holds no row for inserts one — deliberately, see
-- SUBSCRIPTION_INITIAL_STATUSES — and it inserted it with a null date. So the
-- one status the whole machine treats as an ending could exist with nothing
-- saying when it ended, and `canceled_at` is what the Art. 15 export and any
-- final-period reconciliation read to answer "when did this customer leave".
--
-- The writers stamp it now. This backfills the rows written before they did,
-- from `created_at` — for a row born cancelled those are the same instant, and
-- for any other row that reached this state undated it is the earliest date the
-- table can honestly claim.
UPDATE subscriptions
   SET canceled_at = created_at
 WHERE status = 'canceled' AND canceled_at IS NULL;
