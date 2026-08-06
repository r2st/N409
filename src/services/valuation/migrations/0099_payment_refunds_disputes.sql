-- Refunds and chargebacks (payment lifecycle, phase C).
--
-- The webhook in routes/payments.ts only ever listened to `checkout.session.*`.
-- Every event that moves money back OUT — `charge.refunded`, and the dispute
-- pair `charge.dispute.created` / `charge.dispute.closed` — fell through the
-- `event.type.startsWith('checkout.session.')` guard and was acknowledged with
-- `{received: true, ignored: ...}`.
--
-- So a refund was invisible in every place that matters. The payments row
-- stayed 'succeeded'; `valuations.paid_status` stayed 'paid', which is the flag
-- the unpaid-work queue and the client's pay-now call-to-action both read; the
-- account billing rollup kept the refunded amount in `paid_cents`; and no
-- notification went anywhere, so the first anyone learned of a chargeback was
-- the Stripe dashboard. A client could pay for a 409A, receive it, charge the
-- card back, and remain a paid, published engagement in our own records.
--
-- This is the same shape as the ACH bug in 0ab53d6 — money that did not end up
-- with us, recorded as if it had — and it needs the same thing: the state to
-- write it down in.
--
-- 'refunded' is a terminal payment state, added to the enum rather than
-- inferred from refunded_cents so a query for "what did we actually keep" is
-- one predicate and not an arithmetic comparison. PG 12+ permits ADD VALUE
-- inside a transaction as long as the value is not used in the same one; it is
-- not used here, only by later runtime statements.
ALTER TYPE payment_status ADD VALUE IF NOT EXISTS 'refunded';

ALTER TABLE payments
  -- Cumulative, because Stripe refunds are partial and repeatable: a charge can
  -- be refunded in several goes and each `charge.refunded` event carries the
  -- running `amount_refunded`, not the delta. Storing the total means a
  -- redelivered event is idempotent by assignment rather than by arithmetic.
  ADD COLUMN refunded_cents bigint NOT NULL DEFAULT 0 CHECK (refunded_cents >= 0),
  ADD COLUMN refunded_at    timestamptz,
  -- A dispute is not a refund. The money is held, not returned, and the case
  -- can still be won — so it is tracked beside `status` instead of inside it,
  -- and only a LOST dispute promotes the row to 'refunded'. Recording it at all
  -- is what lets ops see an open chargeback in time to answer it.
  ADD COLUMN dispute_status text CHECK (dispute_status IN ('open', 'won', 'lost')),
  ADD COLUMN disputed_at    timestamptz;

-- Refund and dispute events identify the payment by charge or payment intent —
-- never by the Checkout Session id these rows are keyed on — so both need to be
-- lookup keys. Partial because most rows have neither until they settle.
CREATE INDEX payments_payment_intent_idx ON payments (payment_intent_id)
  WHERE payment_intent_id IS NOT NULL;
CREATE INDEX payments_charge_idx ON payments (charge_id)
  WHERE charge_id IS NOT NULL;

-- The ops view of money that needs a human: open chargebacks have a Stripe
-- response deadline, so they are worth an index of their own.
CREATE INDEX payments_open_dispute_idx ON payments (disputed_at DESC)
  WHERE dispute_status = 'open';
