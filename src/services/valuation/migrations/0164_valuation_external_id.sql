-- The partner's own identifier for an engagement.
--
-- A partner integration has a record of its own for every valuation it creates
-- — a deal id, a client id, a row in their CRM — and until now the only way to
-- tie the two together was to store our ULID on their side. That is workable
-- and it is fragile in one specific way: the ULID is only knowable from the
-- *response*, so any create whose response the partner never saw leaves an
-- engagement they cannot name. `Idempotency-Key` (0102, 0160) makes the retry
-- safe; it does not make the result findable, because the key is a per-request
-- value the partner is told to vary, not a durable handle on the thing created.
--
-- `external_id` is that handle. It travels *in* the request, so it is known
-- before the answer exists and survives never receiving one.
--
-- Unique per partner, not globally: it is the partner's namespace, and two
-- firms both calling their first engagement `1` is not a collision anyone
-- should have to think about. A partial index rather than a plain unique
-- constraint, because NULL is the overwhelmingly common case — every valuation
-- created through the web app has no external id, and a unique constraint over
-- a column that is NULL for most rows indexes them all for nothing. Postgres
-- treats NULLs as distinct under a unique index anyway, so the partial form
-- changes no semantics; it only stops the index carrying rows no query will
-- ever look for.
--
-- Nothing enforces this for valuations with no partner: `partner_id` is
-- nullable on this table, and a row with an external id and no partner would
-- sit outside the uniqueness rule entirely. The route is the only writer that
-- sets the column and it always has a partner, so the index condition names
-- both — a row that somehow arrived without a partner is then plainly outside
-- the guarantee rather than quietly inside a broken one.

ALTER TABLE valuations ADD COLUMN IF NOT EXISTS external_id text;

CREATE UNIQUE INDEX IF NOT EXISTS valuations_partner_external_id_idx
  ON valuations (partner_id, external_id)
  WHERE partner_id IS NOT NULL AND external_id IS NOT NULL;
