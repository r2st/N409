import crypto from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createPayment, findPaymentBySessionId, listPayments } from '../../src/repos/payments.js';
import {
  EXPRESS_DELIVERY_CENTS,
  EXPRESS_DELIVERY_DAYS,
  QSBS_LETTER_CENTS,
  priceForKind,
} from '../../src/domain/pricing.js';
import { authHeader, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';

/**
 * Opening a Checkout Session, which no test had ever done.
 *
 * Everything downstream of Stripe — the webhook, the refunds, the receipt — has
 * had tests since it was written, because a webhook is easy to post at. The
 * *outbound* half never did: `POST …/payments/checkout` reaches Stripe over
 * `fetch`, so exercising it means standing something in for Stripe, and without
 * that the whole block was reachable only in production. That is the block that
 * decides what a client is charged.
 *
 * So the assertions here are mostly about the request we send rather than the
 * response we give back. The amount, the currency and the product description
 * are the parts a client sees on Stripe's own page and on their card statement,
 * and this service is the only thing that computes them: the browser sends
 * checkboxes, never a total. A checkout that posts the right JSON back to the
 * browser and the wrong `unit_amount` to Stripe looks correct from every other
 * test in the suite.
 *
 * The key is live-shaped because `checkoutAvailableTo` withholds checkout from
 * a client when the deployment holds a test key — correct, covered in
 * payments.test.ts, and it would mean everything below walked the ops path
 * instead of the client's. No request leaves the process: `fetch` is stubbed in
 * every test that gets as far as calling it.
 */

const dbUp = await isDbAvailable();

const SECRET_KEY = 'sk_live_checkout_stub';
const WEBHOOK_SECRET = 'whsec_checkout_stub';
const BASE_URL = 'https://app.n409.test';
const PRICE = priceForKind('409a');

function signedHeaders(payload: string): Record<string, string> {
  const t = Math.floor(Date.now() / 1000);
  const mac = crypto.createHmac('sha256', WEBHOOK_SECRET).update(`${t}.${payload}`).digest('hex');
  return { 'content-type': 'application/json', 'stripe-signature': `t=${t},v1=${mac}` };
}

describe.skipIf(!dbUp)('opening a checkout', () => {
  let ctx: TestApp;
  let ops: Awaited<ReturnType<typeof seedUser>>;
  let client: Awaited<ReturnType<typeof seedUser>>;
  let bystander: Awaited<ReturnType<typeof seedUser>>;

  /** A fresh unpaid engagement owned by `client`. */
  const newValuation = async (companyName: string, amountRaisedCents?: number): Promise<string> => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/valuations',
      headers: authHeader(client.token),
      payload: { kind: '409a', company_name: companyName },
    });
    expect(res.statusCode).toBe(201);
    const id = res.json().valuation.id as string;
    if (amountRaisedCents !== undefined) {
      await ctx.pool.query('UPDATE valuations SET amount_raised_cents = $2 WHERE id = $1', [
        id,
        amountRaisedCents,
      ]);
    }
    return id;
  };

  /** Stripe answering a Checkout Session create with a session. */
  const stubSession = (id: string, extra: Record<string, unknown> = {}) =>
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ id, url: `https://checkout.stripe.com/c/pay/${id}`, ...extra }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

  const checkout = (token: string, valuationId: string, payload: unknown = {}) =>
    ctx.app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${valuationId}/payments/checkout`,
      headers: authHeader(token),
      payload,
    });

  /** The form body of the one call we made to Stripe. */
  const sentForm = (spy: ReturnType<typeof stubSession>): URLSearchParams => {
    expect(spy).toHaveBeenCalledTimes(1);
    const [, init] = spy.mock.calls[0]!;
    return new URLSearchParams(String(init!.body));
  };

  beforeAll(async () => {
    ctx = await setupTestApp({
      STRIPE_SECRET_KEY: SECRET_KEY,
      STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
      PUBLIC_BASE_URL: BASE_URL,
      AUTO_PIPELINE: 'off',
      EMAIL_MODE: 'off',
    });
    ops = await seedUser(ctx, { roles: ['admin'] });
    client = await seedUser(ctx, { roles: ['valuation_user'] });
    bystander = await seedUser(ctx, { roles: ['valuation_user'] });
  });
  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => ctx?.teardown());

  it('charges the list price and tells Stripe which engagement it is for', async () => {
    const vid = await newValuation('Checkout Co');
    const spy = stubSession('cs_checkout_1');

    const res = await checkout(client.token, vid);
    expect(res.statusCode).toBe(201);
    expect(res.json().checkout_url).toBe('https://checkout.stripe.com/c/pay/cs_checkout_1');
    expect(res.json().quote.amount_cents).toBe(PRICE);

    const form = sentForm(spy);
    expect(form.get('mode')).toBe('payment');
    expect(form.get('line_items[0][price_data][unit_amount]')).toBe(String(PRICE));
    // Stripe wants the currency lower-cased; the column stores it upper.
    expect(form.get('line_items[0][price_data][currency]')).toBe('usd');
    // The two fields the webhook reconciles on. A session created without them
    // is money that arrives with no engagement attached to it.
    expect(form.get('client_reference_id')).toBe(vid);
    expect(form.get('metadata[valuation_id]')).toBe(vid);
    expect(form.get('success_url')).toBe(`${BASE_URL}/payment/success?valuation=${vid}`);
    expect(form.get('cancel_url')).toBe(`${BASE_URL}/payment/cancel?valuation=${vid}`);
    // What the client reads on the Stripe page and their statement.
    expect(form.get('line_items[0][price_data][product_data][name]')).toBe('409A valuation — Checkout Co');

    const [payment] = await listPayments(ctx.pool, vid);
    expect(payment?.session_id).toBe('cs_checkout_1');
    expect(payment?.status).toBe('pending');
    expect(payment?.created_by).toBe(client.id);
    expect(payment?.express).toBe(false);
    expect(payment?.qsbs_letter).toBe(false);
    expect(payment?.price_breakdown).toEqual([{ key: 'base', label: '409A valuation', amount_cents: PRICE }]);
  });

  it('prices the add-ons here, from the ticked boxes and never from a total', async () => {
    const vid = await newValuation('Add-on Co');
    const spy = stubSession('cs_checkout_addons');

    const res = await checkout(client.token, vid, { express: true, qsbs_letter: true });
    expect(res.statusCode).toBe(201);

    const total = PRICE + EXPRESS_DELIVERY_CENTS + QSBS_LETTER_CENTS;
    expect(sentForm(spy).get('line_items[0][price_data][unit_amount]')).toBe(String(total));
    // The description carries what was bought, because the card statement is
    // the only record a client keeps of which add-ons they agreed to.
    expect(sentForm(spy).get('line_items[0][price_data][product_data][name]')).toContain(
      'QSBS attestation letter',
    );

    const [payment] = await listPayments(ctx.pool, vid);
    expect(Number(payment?.amount_cents)).toBe(total);
    // Persisted as columns, not only inside the breakdown: express moves the
    // SLA once the money lands, and that is read from the row.
    expect(payment?.express).toBe(true);
    expect(payment?.qsbs_letter).toBe(true);
    expect(payment?.price_breakdown?.map((l) => l.key)).toEqual(['base', 'express', 'qsbs_letter']);
  });

  it('adds the raise band to the total and itemises it as its own line', async () => {
    // $30M raised → the top band. The band is a property of the company, so it
    // has to be recomputed at checkout rather than trusted from the pay screen.
    const vid = await newValuation('Series C Co', 30_000_000_00);
    const spy = stubSession('cs_checkout_band');

    const res = await checkout(client.token, vid);
    expect(res.statusCode).toBe(201);
    const quote = res.json().quote;
    expect(quote.band.key).toBe('over_20m');
    expect(quote.amount_cents).toBe(PRICE + quote.band_uplift_cents);
    expect(sentForm(spy).get('line_items[0][price_data][unit_amount]')).toBe(String(quote.amount_cents));

    const [payment] = await listPayments(ctx.pool, vid);
    expect(payment?.price_breakdown?.map((l) => l.key)).toEqual(['base', 'band']);
  });

  it('ignores an amount a client sends: the price is not a request parameter', async () => {
    const vid = await newValuation('Cheapskate Co');
    const spy = stubSession('cs_checkout_tamper');

    const res = await checkout(client.token, vid, { amount_cents: 100 });
    expect(res.statusCode).toBe(201);
    // Accepted as a request — the field is a valid ops override, and refusing
    // it would tell a caller probing for one that it exists — and then priced
    // exactly as if it had not been sent.
    expect(sentForm(spy).get('line_items[0][price_data][unit_amount]')).toBe(String(PRICE));
    expect(res.json().quote.amount_cents).toBe(PRICE);
  });

  it('lets ops replace the total, and records the agreed figure as the only line', async () => {
    // The band would otherwise add $2,309 on top of a number somebody
    // negotiated, which is the overcharge the override exists to prevent.
    const vid = await newValuation('Negotiated Co', 30_000_000_00);
    const spy = stubSession('cs_checkout_agreed');

    const res = await checkout(ops.token, vid, { amount_cents: 250_000 });
    expect(res.statusCode).toBe(201);
    expect(sentForm(spy).get('line_items[0][price_data][unit_amount]')).toBe('250000');

    const [payment] = await listPayments(ctx.pool, vid);
    expect(Number(payment?.amount_cents)).toBe(250_000);
    // Not the itemisation the quote produced: those lines add up to a different
    // number from the one charged, and an invoice that does not foot is worse
    // than one with a single line on it.
    expect(payment?.price_breakdown).toEqual([
      { key: 'agreed', label: 'Agreed price', amount_cents: 250_000 },
    ]);
  });

  it('refuses a malformed body before it reaches Stripe', async () => {
    const vid = await newValuation('Malformed Co');
    const spy = stubSession('cs_never');

    const res = await checkout(ops.token, vid, { amount_cents: -1, express: 'yes' });
    expect(res.statusCode).toBe(422);
    expect(res.json().errors?.length).toBeGreaterThan(0);
    // Nothing was created and nothing was sent: a 422 that had already opened a
    // Stripe session would leave a payable page nobody can reconcile.
    expect(spy).not.toHaveBeenCalled();
    expect(await listPayments(ctx.pool, vid)).toEqual([]);
  });

  it('refuses a second checkout once the engagement is paid', async () => {
    const vid = await newValuation('Already Paid Co');
    await ctx.pool.query("UPDATE valuations SET paid_status = 'paid' WHERE id = $1", [vid]);
    const spy = stubSession('cs_never_2');

    const res = await checkout(client.token, vid);
    expect(res.statusCode).toBe(409);
    expect(res.json().detail).toContain('already paid');
    expect(spy).not.toHaveBeenCalled();
  });

  /**
   * At most one live Checkout Session per engagement.
   *
   * A Session URL stays payable for 24 hours, and this route used to mint a
   * fresh one on every POST — so a double-click, a second tab, or a tab left
   * open that morning gave a client two live ways to be charged for one piece
   * of work. The duplicate barely surfaces on this side: the second webhook
   * finds the valuation already paid and leaves it alone, so all that remains
   * is a second charge on a card statement with nothing here to match it to.
   */
  describe('a checkout already open', () => {
    it('hands back the open session rather than minting a second one', async () => {
      const vid = await newValuation('Double Click Co');
      const first = stubSession('cs_reuse_1');
      expect((await checkout(client.token, vid)).statusCode).toBe(201);
      expect(first).toHaveBeenCalledTimes(1);
      vi.restoreAllMocks();

      const second = stubSession('cs_reuse_2');
      const res = await checkout(client.token, vid);
      expect(res.statusCode).toBe(200);
      expect(res.json().checkout_url).toBe('https://checkout.stripe.com/c/pay/cs_reuse_1');
      // Not a call to Stripe, and not a second payments row: reopening the URL
      // is exactly what a client returning to an abandoned checkout wants, and
      // if it has in fact been paid, Stripe's own page says so.
      expect(second).not.toHaveBeenCalled();
      expect(await listPayments(ctx.pool, vid)).toHaveLength(1);
    });

    it('expires the old session before opening one at a new price', async () => {
      const vid = await newValuation('Changed Mind Co');
      stubSession('cs_supersede_1');
      expect((await checkout(client.token, vid)).statusCode).toBe(201);
      vi.restoreAllMocks();

      // Expire answers 200, then the create answers with the new session.
      const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
        const url = String(input);
        if (url.endsWith('/expire')) return new Response('{}', { status: 200 });
        return new Response(
          JSON.stringify({ id: 'cs_supersede_2', url: 'https://checkout.stripe.com/c/pay/cs_supersede_2' }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      });

      const res = await checkout(client.token, vid, { express: true });
      expect(res.statusCode).toBe(201);
      expect(res.json().checkout_url).toBe('https://checkout.stripe.com/c/pay/cs_supersede_2');
      expect(String(spy.mock.calls[0]?.[0])).toContain('/checkout/sessions/cs_supersede_1/expire');

      const rows = await listPayments(ctx.pool, vid);
      expect(rows.find((r) => r.session_id === 'cs_supersede_1')?.status).toBe('expired');
      expect(rows.find((r) => r.session_id === 'cs_supersede_2')?.status).toBe('pending');
    });

    it('refuses to open a second session when Stripe will not close the first', async () => {
      const vid = await newValuation('In Flight Co');
      stubSession('cs_inflight_1');
      expect((await checkout(client.token, vid)).statusCode).toBe(201);
      vi.restoreAllMocks();

      // Stripe refuses to expire a session it has already *completed*. That is
      // a settlement whose webhook is in flight, and opening a second session
      // on top of it is precisely the double charge — so this must not fall
      // through to a create.
      const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
        if (String(input).endsWith('/expire')) {
          return new Response(JSON.stringify({ error: { message: 'session is not open' } }), {
            status: 400,
            headers: { 'content-type': 'application/json' },
          });
        }
        throw new Error('must not create a second session');
      });

      const res = await checkout(client.token, vid, { express: true });
      expect(res.statusCode).toBe(409);
      expect(res.json().detail).toMatch(/already in progress/i);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(await listPayments(ctx.pool, vid)).toHaveLength(1);
    });

    it('opens a fresh session once the old one has aged past Stripe’s 24 hours', async () => {
      const vid = await newValuation('Stale Session Co');
      stubSession('cs_stale_1');
      expect((await checkout(client.token, vid)).statusCode).toBe(201);
      vi.restoreAllMocks();
      // The session Stripe has already expired on its own. Nothing tells us it
      // did, so age is the only signal — and the row must not block a client
      // from paying a day later.
      await ctx.pool.query(
        "UPDATE payments SET created_at = now() - interval '25 hours' WHERE session_id = 'cs_stale_1'",
      );

      const spy = stubSession('cs_stale_2');
      const res = await checkout(client.token, vid);
      expect(res.statusCode).toBe(201);
      expect(res.json().checkout_url).toBe('https://checkout.stripe.com/c/pay/cs_stale_2');
      // Straight to the create — no expire call for a session Stripe has
      // already closed.
      expect(spy).toHaveBeenCalledTimes(1);
      expect(String(spy.mock.calls[0]?.[0])).not.toContain('/expire');
    });

    it('ignores a settled row — the reuse only applies to an open session', async () => {
      const vid = await newValuation('Settled Row Co');
      stubSession('cs_settled_1');
      expect((await checkout(client.token, vid)).statusCode).toBe(201);
      const [row] = await listPayments(ctx.pool, vid);
      await ctx.pool.query("UPDATE payments SET status = 'expired' WHERE id = $1", [row!.id]);
      vi.restoreAllMocks();

      const spy = stubSession('cs_settled_2');
      const res = await checkout(client.token, vid);
      expect(res.statusCode).toBe(201);
      expect(spy).toHaveBeenCalledTimes(1);
    });
  });

  it('turns a Stripe refusal into a 502 and creates nothing', async () => {
    const vid = await newValuation('Declined Co');
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: { message: 'No such price' } }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      }),
    );

    const res = await checkout(client.token, vid);
    expect(res.statusCode).toBe(502);
    expect(res.json().type).toBe('urn:n409:problem:stripe');
    // The upstream reason is passed through: "Bad Gateway" alone tells the
    // person reading the log nothing they can act on.
    expect(res.json().detail).toContain('No such price');
    expect(spy).toHaveBeenCalledTimes(1);
    // No pending row for a session that was never created — it would sit in the
    // payments list forever with a null checkout URL.
    expect(await listPayments(ctx.pool, vid)).toEqual([]);
  });

  /**
   * A transport failure, and the decision this test reverses.
   *
   * It used to assert a 500, on the reasoning that `fetch` rejecting is our
   * network, our DNS or our timeout, and that answering `urn:n409:problem:stripe`
   * would send whoever is on call to the Stripe status page for an outage on
   * this side of the connection. That concern is real. What it protected was
   * the diagnosis, and what it paid with was the answer: the person who pressed
   * "Pay now" got an empty 500, on a payment button, with no way to tell a blip
   * from a bug and no statement that they had not been charged.
   *
   * Both are available, because they are answered in different places. The
   * client gets a 502 whose `detail` is deliberately neutral about whose fault
   * it is — "Stripe could not be reached" is true whether the break is theirs
   * or ours — plus the one fact that decides what they do next, which is that
   * no money moved. The on-call engineer gets the log line, which now carries
   * `unreachable: true` and the original `getaddrinfo`/`ECONNREFUSED` on the
   * error's `cause`; before, it carried a stack and the word "fetch failed".
   *
   * So the misdirection the old assertion feared is answered by the log
   * distinguishing the two, not by the client body refusing to say anything.
   */
  it('answers a transport failure as an unreachable Stripe, and creates nothing', async () => {
    const vid = await newValuation('Broken Socket Co');
    const spy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(
      Object.assign(new TypeError('fetch failed'), {
        cause: Object.assign(new Error('getaddrinfo ENOTFOUND api.stripe.com'), { code: 'ENOTFOUND' }),
      }),
    );

    const res = await checkout(client.token, vid);
    expect(res.statusCode).toBe(502);
    expect(res.json().type).toBe('urn:n409:problem:stripe');
    expect(res.json().detail).toMatch(/Nothing has been charged/);
    // Neutral about whose network broke, and carrying none of the topology:
    // the host and the syscall stay in the log.
    expect(JSON.stringify(res.json())).not.toMatch(/ENOTFOUND|getaddrinfo/);
    // Not retried — a re-sent create is a second payable session.
    expect(spy).toHaveBeenCalledTimes(1);
    // And still no pending row for a session that was never created.
    expect(await listPayments(ctx.pool, vid)).toEqual([]);
  });

  it('404s an id that is not an id, without touching the database', async () => {
    const res = await checkout(client.token, 'not-a-ulid');
    expect(res.statusCode).toBe(404);
  });

  it("404s someone else's engagement rather than admitting it exists", async () => {
    const vid = await newValuation('Private Co');
    const res = await checkout(bystander.token, vid);
    expect(res.statusCode).toBe(404);
  });

  /**
   * The settlement details the delayed-payment tests never reached: the receipt
   * lookup (a second outbound call, best-effort by design) and the two fields
   * that a real Checkout Session may simply not carry.
   */
  describe('settling what the checkout opened', () => {
    const completed = (session: Record<string, unknown>) =>
      JSON.stringify({ type: 'checkout.session.completed', data: { object: session } });

    const deliver = (body: string) =>
      ctx.app.inject({
        method: 'POST',
        url: '/api/v1/stripe/webhook',
        headers: signedHeaders(body),
        payload: body,
      });

    const pending = async (vid: string, sessionId: string, express = false) =>
      createPayment(ctx.pool, {
        valuationId: vid,
        sessionId,
        amountCents: PRICE,
        currency: 'USD',
        createdBy: client.id,
        express,
      });

    it('resolves the receipt from the payment intent and stores it', async () => {
      const vid = await newValuation('Receipt Co');
      await pending(vid, 'cs_receipt_ok');
      const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(
          JSON.stringify({
            id: 'pi_receipt_ok',
            latest_charge: { id: 'ch_receipt_ok', receipt_url: 'https://pay.stripe.com/receipts/ok' },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      );

      const res = await deliver(
        completed({ id: 'cs_receipt_ok', payment_intent: 'pi_receipt_ok', amount_total: PRICE }),
      );
      expect(res.statusCode).toBe(200);

      // The charge, not the session, is where Stripe keeps the receipt, so this
      // is a second call — and it is made with the intent the event carried.
      expect(String(spy.mock.calls[0]![0])).toContain('pi_receipt_ok');
      const row = await findPaymentBySessionId(ctx.pool, 'cs_receipt_ok');
      expect(row?.charge_id).toBe('ch_receipt_ok');
      expect(row?.receipt_url).toBe('https://pay.stripe.com/receipts/ok');
    });

    it('settles anyway when the receipt lookup fails', async () => {
      // Best-effort on purpose: a 5xx back to Stripe here would have it
      // redeliver an event we have already applied, and the client would be
      // waiting on a report because a link could not be fetched.
      const vid = await newValuation('No Receipt Co');
      await pending(vid, 'cs_receipt_fail');
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(JSON.stringify({ error: { message: 'No such payment_intent' } }), {
          status: 404,
          headers: { 'content-type': 'application/json' },
        }),
      );

      const res = await deliver(
        completed({ id: 'cs_receipt_fail', payment_intent: 'pi_missing', amount_total: PRICE }),
      );
      expect(res.statusCode).toBe(200);
      const row = await findPaymentBySessionId(ctx.pool, 'cs_receipt_fail');
      expect(row?.status).toBe('succeeded');
      expect(row?.receipt_url).toBeNull();

      const valuation = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/valuations/${vid}`,
        headers: authHeader(ops.token),
      });
      expect(valuation.json().valuation.paid_status).toBe('paid');
    });

    it('makes no lookup at all for a session that carries no intent', async () => {
      const vid = await newValuation('Intentless Co');
      await pending(vid, 'cs_no_intent');
      const spy = vi.spyOn(globalThis, 'fetch');

      const res = await deliver(completed({ id: 'cs_no_intent', amount_total: PRICE }));
      expect(res.statusCode).toBe(200);
      expect(spy).not.toHaveBeenCalled();
      const row = await findPaymentBySessionId(ctx.pool, 'cs_no_intent');
      expect(row?.status).toBe('succeeded');
      expect(row?.payment_intent_id).toBeNull();
    });

    it('falls back to the quoted amount when the session states no total', async () => {
      // The amount written onto the valuation is what we bill from. Taking a
      // missing `amount_total` as zero would report the engagement as paid for
      // nothing, and the billing rollup sums that column.
      const vid = await newValuation('Totalless Co');
      await pending(vid, 'cs_no_total');

      const res = await deliver(completed({ id: 'cs_no_total' }));
      expect(res.statusCode).toBe(200);
      const valuation = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/valuations/${vid}`,
        headers: authHeader(ops.token),
      });
      expect(valuation.json().valuation.amount_cents).toBe(PRICE);
    });

    it('moves the SLA to next business day only once express money is in', async () => {
      const vid = await newValuation('Express Co');
      await pending(vid, 'cs_express', true);

      const before = await ctx.pool.query<{ delivery_days: number | null }>(
        'SELECT delivery_days FROM valuations WHERE id = $1',
        [vid],
      );
      // Not at checkout: an abandoned express order must not leave a
      // one-business-day due date on an engagement nobody paid for.
      expect(before.rows[0]?.delivery_days).toBeNull();

      const res = await deliver(completed({ id: 'cs_express', amount_total: PRICE }));
      expect(res.statusCode).toBe(200);
      const after = await ctx.pool.query<{ delivery_days: number | null }>(
        'SELECT delivery_days FROM valuations WHERE id = $1',
        [vid],
      );
      expect(after.rows[0]?.delivery_days).toBe(EXPRESS_DELIVERY_DAYS);
    });

    it('acknowledges a session we never issued instead of failing the delivery', async () => {
      // Stripe delivers every event on the account, including sessions opened
      // by another integration. A 4xx here would have it retry for days.
      const res = await deliver(completed({ id: 'cs_not_ours', amount_total: PRICE }));
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ received: true, ignored: 'unknown session' });
    });
  });

  /**
   * Bodies that are correctly signed and still not something we can act on.
   * The signature is the only authentication the endpoint has, so everything
   * past it has to survive a payload that verifies and then says nothing.
   */
  describe('signed but unusable payloads', () => {
    const deliver = (body: string) =>
      ctx.app.inject({
        method: 'POST',
        url: '/api/v1/stripe/webhook',
        headers: signedHeaders(body),
        payload: body,
      });

    it('rejects a body that is not JSON', async () => {
      const res = await deliver('not json at all');
      expect(res.statusCode).toBe(400);
      expect(res.json().detail).toContain('Invalid webhook payload');
    });

    it('ignores an event with no type rather than guessing one', async () => {
      const res = await deliver(JSON.stringify({ id: 'evt_typeless' }));
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ received: true, ignored: 'unknown' });
    });

    it('ignores an unrelated event type', async () => {
      const res = await deliver(
        JSON.stringify({ type: 'customer.created', data: { object: { id: 'cus_1' } } }),
      );
      expect(res.json()).toEqual({ received: true, ignored: 'customer.created' });
    });

    it('ignores a checkout event whose session has no id', async () => {
      // `id` is the only key we have back to a payments row; without it there
      // is nothing to reconcile, and treating it as absent is the honest answer.
      const res = await deliver(
        JSON.stringify({ type: 'checkout.session.completed', data: { object: { amount_total: 1 } } }),
      );
      expect(res.json()).toEqual({ received: true, ignored: 'checkout.session.completed' });
    });

    it('acknowledges a refund carrying neither a charge nor an intent', async () => {
      const res = await deliver(
        JSON.stringify({ type: 'charge.refunded', data: { object: { amount_refunded: 500 } } }),
      );
      expect(res.json()).toEqual({ received: true, ignored: 'unknown charge' });
    });

    it('acknowledges a dispute carrying neither a charge nor an intent', async () => {
      const res = await deliver(
        JSON.stringify({ type: 'charge.dispute.created', data: { object: { status: 'lost' } } }),
      );
      expect(res.json()).toEqual({ received: true, ignored: 'unknown charge' });
    });

    it('ignores a refund event that reports nothing refunded', async () => {
      // Stripe sends `charge.refunded` for a $0 refund on a partially captured
      // charge. Acting on it would revoke a paid engagement over no money.
      const vid = await newValuation('Zero Refund Co');
      const payment = await createPayment(ctx.pool, {
        valuationId: vid,
        sessionId: 'cs_zero_refund',
        amountCents: PRICE,
        currency: 'USD',
      });
      await ctx.pool.query("UPDATE payments SET charge_id = 'ch_zero', status = 'succeeded' WHERE id = $1", [
        payment.id,
      ]);

      const res = await deliver(
        JSON.stringify({
          type: 'charge.refunded',
          data: { object: { id: 'ch_zero', amount_refunded: 0 } },
        }),
      );
      expect(res.json()).toEqual({ received: true, ignored: 'no refunded amount' });
      expect((await findPaymentBySessionId(ctx.pool, 'cs_zero_refund'))?.status).toBe('succeeded');
    });

    it('does not re-alert on a redelivered dispute in the state we already hold', async () => {
      const vid = await newValuation('Redelivered Dispute Co');
      const payment = await createPayment(ctx.pool, {
        valuationId: vid,
        sessionId: 'cs_dispute_redeliver',
        amountCents: PRICE,
        currency: 'USD',
      });
      await ctx.pool.query(
        `UPDATE payments SET charge_id = 'ch_dispute_redeliver', status = 'succeeded',
           dispute_status = 'open', disputed_at = now() WHERE id = $1`,
        [payment.id],
      );

      const res = await deliver(
        JSON.stringify({
          type: 'charge.dispute.created',
          data: { object: { charge: 'ch_dispute_redeliver', status: 'needs_response' } },
        }),
      );
      expect(res.json()).toEqual({ received: true, dispute_status: 'open' });
      // The point of the guard: ops working a chargeback must not be paged
      // again every time Stripe retries the event that opened it.
      const { rows } = await ctx.pool.query<{ n: string }>(
        "SELECT count(*)::text AS n FROM notifications WHERE valuation_id = $1 AND type = 'payment_disputed'",
        [vid],
      );
      expect(rows[0]?.n).toBe('0');
    });
  });

  /**
   * A notification that cannot be written must not become a 5xx.
   *
   * Stripe reads a 5xx as "not delivered" and redelivers for days. On the
   * reversal paths the money has already moved and `patchValuation` has already
   * run by the time the alert is attempted, so failing the response would have
   * Stripe replay an event we have applied — while the thing that actually
   * broke is a notification insert. Both handlers therefore swallow and log.
   *
   * The failure is modelled by taking the table away for the duration, which is
   * the bluntest possible version of "the insert raised" and needs no seam in
   * the code to inject.
   */
  describe('when the alert cannot be written', () => {
    const deliver = (body: string) =>
      ctx.app.inject({
        method: 'POST',
        url: '/api/v1/stripe/webhook',
        headers: signedHeaders(body),
        payload: body,
      });

    const withoutNotifications = async <T>(fn: () => Promise<T>): Promise<T> => {
      await ctx.pool.query('ALTER TABLE notifications RENAME TO notifications_unavailable');
      try {
        return await fn();
      } finally {
        await ctx.pool.query('ALTER TABLE notifications_unavailable RENAME TO notifications');
      }
    };

    /** A settled payment on a paid engagement, resolvable by charge id. */
    const settled = async (company: string, key: string): Promise<string> => {
      const vid = await newValuation(company);
      const payment = await createPayment(ctx.pool, {
        valuationId: vid,
        sessionId: `cs_${key}`,
        amountCents: PRICE,
        currency: 'USD',
      });
      await ctx.pool.query(`UPDATE payments SET charge_id = $2, status = 'succeeded' WHERE id = $1`, [
        payment.id,
        `ch_${key}`,
      ]);
      await ctx.pool.query("UPDATE valuations SET paid_status = 'paid', paid_at = now() WHERE id = $1", [
        vid,
      ]);
      return vid;
    };

    const paidStatus = async (vid: string): Promise<string> => {
      const { rows } = await ctx.pool.query<{ paid_status: string }>(
        'SELECT paid_status FROM valuations WHERE id = $1',
        [vid],
      );
      return rows[0]!.paid_status;
    };

    it('still revokes a fully refunded engagement', async () => {
      const vid = await settled('Silent Refund Co', 'silent_refund');
      const res = await withoutNotifications(() =>
        deliver(
          JSON.stringify({
            type: 'charge.refunded',
            data: { object: { id: 'ch_silent_refund', amount_refunded: PRICE } },
          }),
        ),
      );
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ received: true, refunded: true });
      // The part that must survive: the client's money went back, so the
      // engagement is payable again whether or not anyone was told.
      expect(await paidStatus(vid)).toBe('unpaid');
    });

    it('still records an opened chargeback', async () => {
      const vid = await settled('Silent Dispute Co', 'silent_dispute');
      const res = await withoutNotifications(() =>
        deliver(
          JSON.stringify({
            type: 'charge.dispute.created',
            data: { object: { charge: 'ch_silent_dispute', status: 'needs_response' } },
          }),
        ),
      );
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ received: true, dispute_status: 'open' });
      // An opened dispute never revokes — the money is only held — so the
      // assertion is that the state was written and nothing was pulled.
      expect(await paidStatus(vid)).toBe('paid');
      const { rows } = await ctx.pool.query<{ dispute_status: string }>(
        'SELECT dispute_status FROM payments WHERE charge_id = $1',
        ['ch_silent_dispute'],
      );
      expect(rows[0]?.dispute_status).toBe('open');
    });
  });
});
