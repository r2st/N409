# Billing activation — what is built, and what production still needs

Billing is **code-complete and unconfigured**. Nothing here is a feature request:
every endpoint, webhook handler, plan row and UI surface exists and is tested.
What is missing is two secrets and one webhook registration, and until they land
every client who reaches the pay step sees:

> Online payment is not available yet — we will invoice you instead.

That message is the designed fallback (`configured: false` from
`GET /api/v1/valuations/:id/payments/quote`), not a bug. It is also, today, the
only way N409 collects money.

## What is already built

| Surface | Where | State |
|---|---|---|
| One-off per-valuation Checkout | `routes/payments.ts` | Built, tested |
| Recurring subscription Checkout | `routes/billing.ts` | Built, tested |
| Webhook: payment lifecycle | `POST /api/v1/stripe/webhook` | Built, signature-verified |
| Webhook: subscription + invoice lifecycle | `POST /api/v1/billing/webhook` | Built, signature-verified |
| Usage vs. plan limit | `domain/billing.ts` | Built, tested |
| Generated invoice PDFs | `GET /api/v1/billing/invoices/:id/pdf` | Built, tested |
| Ops billing dashboard (MRR, collected) | `GET /api/v1/admin/billing` | Built, tested |
| Client billing page | `BillingPage.tsx`, `SubscriptionSection.tsx` | Built |
| Plan rows | migration `0080_subscriptions_invoices.sql` | **Seeded in production** |

Verified on the host: `plan_limits` holds `per_valuation`, `annual_retainer`
and `enterprise`. No data work is outstanding.

## What production is missing

`/opt/N409/.env` currently defines `DATABASE_URL`, `REDIS_URL`, `JWT_SECRET`,
`SMTP_*`, `OPENROUTER_API_KEY`, `DOCUMENTS_ENCRYPTION_KEY`, `MFA_ENCRYPTION_KEY`,
`INTERNAL_SERVICE_TOKEN`, `PUBLIC_BASE_URL` and the observability vars. It does
**not** define:

```
STRIPE_SECRET_KEY=sk_live_...
STRIPE_WEBHOOK_SECRET=whsec_...           # the /api/v1/stripe/webhook endpoint
STRIPE_BILLING_WEBHOOK_SECRET=whsec_...   # the /api/v1/billing/webhook endpoint
```

All three are read by the valuation service only. `PUBLIC_BASE_URL` is already set
and is what the Checkout success/cancel URLs are built from.

`STRIPE_BILLING_WEBHOOK_SECRET` exists because Stripe issues a **separate signing
secret per registered endpoint** — you cannot ask it to reuse one. The two
handlers live at different paths, so they are two endpoints with two secrets. Left
unset it falls back to `STRIPE_WEBHOOK_SECRET`, which is correct only for a
deployment that registers a single endpoint or that has not enabled subscriptions.

## Activation, in order

1. **Create the Stripe account / use the existing one** and take a live secret key.
2. **Register two webhook endpoints** — they are separate handlers with separate
   concerns, and both must exist:

   | Endpoint | Events |
   |---|---|
   | `https://n409.aiknol.com/api/v1/stripe/webhook` | `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`, `checkout.session.expired` |
   | `https://n409.aiknol.com/api/v1/billing/webhook` | `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.paid`, `invoice.payment_succeeded` |

   The two `async_payment_*` events are not optional. Any delayed-notification
   method — ACH direct debit, SEPA, Bacs, boleto, OXXO, Konbini — completes its
   Checkout Session **before** the money moves, and these are the only events
   that say whether it ever arrived. Without them subscribed, an ACH payment
   stays `pending` forever and the client never gets their report.

3. **Put all three secrets in `/opt/N409/.env`** — the live key, and each
   endpoint's own signing secret — then restart the valuation service:

   ```bash
   ssh -i keys/hetzner_ustradingbot root@204.168.241.124
   # edit /opt/N409/.env
   systemctl restart n409-valuation
   ```

4. **Confirm** the quote endpoint now reports `configured: true`:

   ```bash
   curl -s -H "Authorization: Bearer $TOKEN" \
     https://n409.aiknol.com/api/v1/valuations/$VID/payments/quote
   ```

5. **Send a test event** from the Stripe dashboard to each endpoint and confirm a
   `200`. A `400 Invalid Stripe signature` means that endpoint's variable does not
   hold that endpoint's signing secret: `/api/v1/stripe/webhook` verifies against
   `STRIPE_WEBHOOK_SECRET`, `/api/v1/billing/webhook` against
   `STRIPE_BILLING_WEBHOOK_SECRET`. Test both — a signature failure is visible
   only in the Stripe dashboard's failed-delivery list, and the events being
   dropped are the ones that record a subscription starting and an invoice paid.

## Open decision: two prices disagree

This is a business call, not a bug, but it will surface the moment billing goes
live:

- `plan_limits.per_valuation` (the plans table, shown on the subscription UI):
  **$2,000.00**
- `DEFAULT_PRICE_CENTS['409a']` (`routes/payments.ts`, what per-valuation
  Checkout actually charges): **$1,190.00**

A client who reads the plan table and then pays will be charged $810 less than
the page quoted. The other kinds (`fmv` $990, `718`/`820` $1,490) have no plan-table
counterpart at all. Pick the authoritative source before the first live charge —
whichever way, one of the two numbers has to move.

## Known behaviour worth reading before the first live charge

- The **webhook is the source of truth**, never the browser redirect. A client
  who closes the tab after paying is still marked paid.
- **Fulfilment waits for settlement.** `checkout.session.completed` only releases
  the valuation when the session reports `payment_status: paid` (or
  `no_payment_required`); an `unpaid` session stays `pending` until
  `async_payment_succeeded` arrives. See `isSettled` in `routes/payments.ts`.
- **Webhook failures return 5xx on purpose**, so Stripe redelivers. Handlers are
  idempotent (`findInvoiceByStripeId`, `ON CONFLICT`, upsert), so a redelivery of
  a partly-applied event is safe.
- **Ops can override the amount** on a per-valuation checkout; clients always pay
  list price.
