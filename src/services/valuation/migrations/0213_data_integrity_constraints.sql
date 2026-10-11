-- Data integrity audit (R427, methodology M17).
--
-- Five gaps found by schema review, each one a constraint the application code
-- compensates for but the database does not enforce. A bug in any of those
-- paths — or a psql session that bypasses them — violates an invariant nobody
-- finds until something downstream reads the impossible value.
--
-- 1. orders.amount_cents: no CHECK.
--    payments.amount_cents has CHECK (amount_cents > 0) since migration 0041.
--    orders.amount_cents, added in 0209, has none. A negative order amount
--    would be accepted by the database and appear on the billing page.
--
-- 2. subscriptions.valuations_used: no CHECK >= 0.
--    repos/billing.ts guards the decrement with `AND s.valuations_used > 0`,
--    but nothing prevents a direct UPDATE from driving the counter negative.
--    A negative count would mean an extra free valuation on the next period,
--    because the limit check is `valuations_used < valuation_limit`.
--
-- 3. valuation_share_tokens.view_count: no CHECK >= 0.
--    The only writer is `view_count = view_count + 1`, but the column accepts
--    any integer, and a negative count would misrepresent traffic.
--
-- 4. email_subscribers: case-sensitive unique constraint.
--    UNIQUE (email) treats User@Example.com and user@example.com as two rows.
--    The users table (migration 0001) correctly uses UNIQUE INDEX ON
--    (lower(email)). The subscriber list does not normalise, so the same
--    address can appear twice, and the ON CONFLICT guard in the subscribe
--    route fails to deduplicate across case variants.
--
--    The fix replaces the constraint with a case-insensitive unique index,
--    after deduplicating any existing rows (keeping the earliest).
--
-- 5. valuation_share_tokens: view_count bumped for expired tokens.
--    The share-token summary route (routes/shareTokens.ts) bumps view_count
--    in a CTE before checking expires_at in application code. An expired
--    token therefore accumulates phantom views — the caller gets a 410 Gone,
--    but the counter moves anyway. The fix is in application code (the CTE
--    adds a WHERE expires_at > now() predicate), but a complementary partial
--    index here makes the expired-token read path faster and documents the
--    intent at the schema level.

-- ── 1. orders.amount_cents ───────────────────────────────────────────────────
ALTER TABLE orders ADD CONSTRAINT orders_amount_positive CHECK (amount_cents > 0);

-- ── 2. subscriptions.valuations_used ─────────────────────────────────────────
ALTER TABLE subscriptions
  ADD CONSTRAINT subscriptions_usage_non_negative CHECK (valuations_used >= 0);

-- ── 3. valuation_share_tokens.view_count ─────────────────────────────────────
ALTER TABLE valuation_share_tokens
  ADD CONSTRAINT share_tokens_views_non_negative CHECK (view_count >= 0);

-- ── 4. email_subscribers: case-insensitive dedup + index ─────────────────────
-- Remove duplicates, keeping the earliest row per normalised address.
DELETE FROM email_subscribers a
 USING email_subscribers b
 WHERE lower(a.email) = lower(b.email)
   AND a.id > b.id;

-- Normalise the surviving rows so the stored value is lowercase.
UPDATE email_subscribers SET email = lower(email) WHERE email <> lower(email);

-- Replace the case-sensitive constraint with a case-insensitive unique index,
-- matching the pattern on the users table (migration 0001). The app also
-- lowercases before insert (defense in depth), so ON CONFLICT targets the
-- stored value directly.
ALTER TABLE email_subscribers DROP CONSTRAINT email_subscribers_email_unique;
CREATE UNIQUE INDEX email_subscribers_email_key ON email_subscribers (lower(email));

-- ── 5. Share-token expiry: partial index for live tokens ─────────────────────
-- The summary route now filters expired tokens in SQL (see code change in
-- routes/shareTokens.ts). This index makes that predicate an index scan.
CREATE INDEX share_tokens_live_idx
  ON valuation_share_tokens (token) WHERE expires_at > now();
