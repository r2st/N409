-- When a payment settled, as distinct from when its row was last touched.
--
-- `payments` has never carried a settlement timestamp. The receipt PDF —
-- `GET /valuations/:id/payments/:paymentId/receipt.pdf` — printed "Paid" from
-- `updated_at`, which is the row's mtime and is bumped by every writer on it:
-- `recordRefund`, `recordDispute` and `setPaymentReceipt` all set it to now().
--
-- So the one document a client keeps to say when they paid us restated its own
-- date whenever the money moved afterwards. A refund six weeks later redated
-- the receipt to the day of the refund; an opened chargeback did the same, on
-- the exact row whose receipt somebody is most likely to go back and read. The
-- figures on it were right and the date under them was the date of the event
-- that contradicted them.
--
-- Nullable and stamped by `markPayment` on the move to 'succeeded' only, with a
-- COALESCE so a redelivered settlement cannot re-date a payment that already
-- has one.
ALTER TABLE payments ADD COLUMN settled_at timestamptz;

-- The rows written before the column existed. `updated_at` is the wrong answer
-- for any of them that were later refunded or disputed — that is the whole
-- defect — but it is also the only instant these rows hold, and it is what
-- their receipts already print. Backfilling it changes no document and stops
-- the new reader falling back for every historical row; the ones it cannot fix
-- were unfixable before this migration too.
UPDATE payments
   SET settled_at = updated_at
 WHERE settled_at IS NULL AND status IN ('succeeded', 'refunded');
