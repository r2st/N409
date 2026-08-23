-- Refunds against subscription invoices.
--
-- `invoices` had no way to record money going back out. Every row is created
-- 'paid' by the `invoice.paid` webhook branch and nothing ever writes to it
-- again, so the ops dashboard's "Collected" figure — sum(amount_cents) over
-- paid invoices — was gross of every refund ever issued and stayed that way
-- permanently. That is the same defect `payments` had before migration 0099,
-- and it is the one `domain/payments.collectedTotals` was rewritten to fix:
-- a revenue total a customer can disprove from their own card statement.
--
-- Modelled on `payments` rather than on the invoice status, deliberately. A
-- Stripe refund does not move an invoice's status — the invoice stays `paid`
-- and the money comes back off the charge — so recording it as a status change
-- would say something Stripe does not say, and would lose the partial case
-- entirely. `refunded_cents` is the running total refunded, assigned rather
-- than incremented, which is what makes a redelivered `charge.refunded`
-- idempotent.
--
-- No CHECK tying it to amount_cents: Stripe's refund total is authoritative and
-- a constraint here would turn a reconciliation problem into a rejected
-- webhook, which is the wrong end to fail at.
ALTER TABLE invoices
  ADD COLUMN refunded_cents integer NOT NULL DEFAULT 0,
  ADD COLUMN refunded_at    timestamptz;

-- The rollup nets over `status = 'paid'`, and the refunded rows are the ones it
-- has to subtract; partial indexes elsewhere in this schema follow the same
-- shape (see notifications_unread_idx).
CREATE INDEX invoices_refunded_idx ON invoices (user_id) WHERE refunded_cents > 0;
