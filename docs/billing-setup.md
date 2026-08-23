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
| Tiered pricing by capital raised | `domain/pricing.ts` | Built, tested |
| Express delivery / QSBS letter add-ons | `domain/pricing.ts`, migration `0108` | Built, tested |
| Recurring subscription Checkout | `routes/billing.ts` | Built, tested |
| Webhook: payment lifecycle | `POST /api/v1/stripe/webhook` | Built, signature-verified |
| Webhook: subscription + invoice lifecycle | `POST /api/v1/billing/webhook` | Built, signature-verified |
| Refunds, chargebacks, dunning | `routes/payments.ts`, `routes/billing.ts` | Built, tested |
| Self-serve cancel / card update | `POST /api/v1/billing/portal` | Built, tested — needs the portal enabled in Stripe |
| Usage vs. plan limit | `domain/billing.ts` | Built, tested |
| Generated invoice PDFs | `GET /api/v1/billing/invoices/:id/pdf` | Built, tested |
| Ops billing dashboard (MRR, collected) | `GET /api/v1/admin/billing` | Built, tested |
| Client billing page | `BillingPage.tsx`, `SubscriptionSection.tsx` | Built |
| Plan rows | migration `0080_subscriptions_invoices.sql` | **Seeded in production** |

Verified on the host: `plan_limits` holds `per_valuation`, `annual_retainer`
and `enterprise`. No data work is outstanding.

## How a one-off engagement is priced

`domain/pricing.ts` is the only place a one-off price is computed. Both the
public calculator and the checkout read it, so the figure a prospect configures
on `/pricing` is by construction the figure Stripe is asked to charge.

```
price = entry price for the kind
      + uplift for the capital-raised band
      + £/$500 express delivery, if bought
      + £/$500 QSBS attestation letter, if bought and not already a QSBS engagement
```

| Band (`valuations.amount_raised_cents`) | Uplift | 409A |
|---|---|---|
| Under $1M — *and any engagement whose raise we do not know* | — | $1,190 |
| $1M – $5M | +$500 | $1,690 |
| $5M – $10M | +$1,100 | $2,290 |
| $10M – $20M | +$1,700 | $2,890 |
| $20M+ | +$2,309 | **$3,499** |

One uplift ladder applies to every product: the increment is a property of the
company (more securities, more rounds, more diligence), not of the deliverable,
so a new report type is priced correctly the day it is added with a single
entry in `DEFAULT_PRICE_CENTS`.

**An unknown raise is the entry band, not the top one.** Most engagements have
no `amount_raised_cents` at the point of payment. Guessing high overcharges a
seed company for a fact we failed to collect; guessing low undercharges a
late-stage one who can be re-quoted once the cap table lands.

**409.ai's published ladder starts at $899; ours starts at $1,190.** That is
deliberate, not an oversight — $1,190 is what this deployment has always
charged for a 409A, it is what `plan_limits` is seeded with, it is what the
marketing copy quotes, and `test/integration/planPricing.test.ts` asserts the
three agree. Dropping the flagship entry price 24% is a commercial decision.
To make it, change `DEFAULT_PRICE_CENTS['409a']` to `89_900`, move the
`plan_limits` seed and the marketing figures with it, and re-tune the top band
uplift if $3,499 is still the intended ceiling.

Ops can still override the total per checkout (`amount_cents` on the checkout
body, ops-only). An override **replaces** the whole quote rather than adding to
it — an agreed price is a negotiated figure, and stacking a band uplift on top
of one would silently overcharge — and it is recorded as a single
`Agreed price` line in `payments.price_breakdown` so the itemisation still adds
up to what was charged.

Express delivery moves `valuations.delivery_days` to 1, and it does so **on
settlement, not at checkout**: an abandoned or bounced express order must not
leave a one-business-day due date on an unpaid engagement.

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

## Test keys are handled, not merely tolerated

A `sk_test_…` key is the state every deployment passes through on its way to
taking money, and it is the more dangerous of the two failure modes — more so
than no key at all, because it *works*. It opens a real Checkout Session at a
real `checkout.stripe.com` URL with a real card form. That form accepts
`4242 4242 4242 4242` and declines every card a client actually holds, and
nothing on either end says why: the client reads a decline they will blame on
their bank, and our records show a session that expired.

So the mode is read off the key prefix (`payments/stripe.ts`, `stripeKeyMode`)
and the routes apply one rule (`routes/payments.ts`, `checkoutAvailableTo`):

| | Live key | Test key | No key |
|---|---|---|---|
| Client sees | Pay now | *Invoice fallback* | Invoice fallback |
| Ops see | Pay now | Pay now + test-mode warning | Invoice fallback |
| `configured` in the quote | `true` | `false` for clients, `true` for ops | `false` |
| `test_mode` in the quote | absent | `true`, ops only | absent |

The quote and the checkout apply the *same* predicate, so the pay panel never
offers a button the POST would refuse. A client who cannot be charged is told
the one sentence an unconfigured deployment already tells them; which Stripe
account this deployment holds is not something to print on a payment screen.

An unrecognised prefix counts as live. A malformed key fails loudly at the
first API call, which beats silently withholding checkout from every paying
client because Stripe issued a prefix the regex predates.

**This deployment currently holds a test key**, so nothing above is theoretical:
online payment is live for ops rehearsal and clients are still being invoiced.
Going live is one variable — replace `STRIPE_SECRET_KEY` with the `sk_live_…`
key and restart; no code changes.

## Activation, in order

1. **Create the Stripe account / use the existing one** and take a live secret key.
2. **Register two webhook endpoints** — they are separate handlers with separate
   concerns, and both must exist:

   | Endpoint | Events |
   |---|---|
   | `https://n409.aiknol.com/api/v1/stripe/webhook` | `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`, `checkout.session.expired`, `charge.refunded`, `charge.dispute.created`, `charge.dispute.closed` |
   | `https://n409.aiknol.com/api/v1/billing/webhook` | `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.paid`, `invoice.payment_succeeded`, `invoice.payment_failed` |

   The two `async_payment_*` events are not optional. Any delayed-notification
   method — ACH direct debit, SEPA, Bacs, boleto, OXXO, Konbini — completes its
   Checkout Session **before** the money moves, and these are the only events
   that say whether it ever arrived. Without them subscribed, an ACH payment
   stays `pending` forever and the client never gets their report.

   Nor are `charge.refunded` and the dispute pair. Those are the only signal
   that money went back *out*: without them a refunded or charged-back
   engagement stays `paid` in our records, keeps counting toward revenue on the
   billing page, and nobody is told — and a chargeback in particular runs
   against a Stripe evidence deadline that starts whether we noticed or not.

   `charge.refunded` covers subscriptions too, which is why it stays on the
   payment endpoint rather than moving to the billing one. A renewal is charged
   against a Stripe *invoice* and has no `payments` row, so the handler falls
   through to the invoice when the charge matches no engagement; there is one
   place refunds are recorded and one endpoint to subscribe it on.

   `invoice.payment_failed` is the dunning signal. A subscription renewal that
   fails is almost always an expired card rather than a decision, and it is
   recoverable only if the subscriber is told; unsubscribed, the account drifts
   past due and Stripe cancels it weeks later with no warning to anyone.

3. **Enable the Stripe Billing Portal** (Settings → Billing → Customer portal)
   and save a configuration. `POST /api/v1/billing/portal` is what a subscriber
   clicks to cancel, change plan, or replace a card — without it, the only way
   out of a subscription is to email support. Stripe returns
   `No configuration provided` until this is saved once, which the endpoint
   surfaces as a `502` with that message.

4. **Put all three secrets in `/opt/N409/.env`** — the live key, and each
   endpoint's own signing secret — then restart the valuation service:

   ```bash
   ssh -i keys/hetzner_ustradingbot root@204.168.241.124
   # edit /opt/N409/.env
   systemctl restart n409-valuation
   ```

5. **Confirm** the quote endpoint now reports `configured: true`:

   ```bash
   curl -s -H "Authorization: Bearer $TOKEN" \
     https://n409.aiknol.com/api/v1/valuations/$VID/payments/quote
   ```

6. **Send a test event** from the Stripe dashboard to each endpoint and confirm a
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
- **A full refund or a lost chargeback takes the valuation back to `unpaid`**,
  which puts it back in the pay-now list and the unpaid work queue. The detail —
  how much came back, when, and whether it was a refund or a dispute — stays on
  the `payments` row, and the transition is written to the valuation's audit
  trail attributed to `system`/`stripe`. A **partial** refund is recorded but
  does not revoke: the client still bought the report and still holds it.
- **An opened dispute never revokes.** The money is only held and the case is
  answerable, so it raises an ops notification and waits for
  `charge.dispute.closed`.
- **Billing totals are net.** `/api/v1/me/billing` reports `gross_cents`,
  `refunded_cents` and a `paid_cents` that nets them — the figure a client can
  check against their own card statement.
