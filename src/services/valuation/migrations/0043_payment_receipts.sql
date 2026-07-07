-- Receipt capture (P0 #2 phase A): the webhook resolves the payment intent's
-- latest charge and stores Stripe's hosted receipt URL so the UI can link it.
ALTER TABLE payments
  ADD COLUMN charge_id   text,
  ADD COLUMN receipt_url text;
