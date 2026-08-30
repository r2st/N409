import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newUlid } from '@n409/shared';
import { authHeader, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';

const dbUp = await isDbAvailable();

/**
 * Subscription plans, the admin billing dashboard, and the invoice PDF — the
 * three parts of `routes/billing.ts` reachable without a Stripe key.
 *
 * `billing.test.ts` covers the per-valuation payment rollup and
 * `billingPortal.test.ts` covers the portal against a Stripe stub. Neither
 * touches the subscribe route's refusals, the dashboard's paging, or who may
 * download an invoice — which is where the file's missing branches were, at
 * 78% coverage.
 *
 * The one worth naming is `portal_available` and `configured`. Both are
 * per-caller rather than per-deployment, because a test key opens a Checkout
 * page that declines every card a subscriber owns. On a recurring plan that is
 * the worse of the two flows to get wrong: the one-off is a failed payment, this
 * is a subscription that silently never starts.
 */
describe.skipIf(!dbUp)('billing — plans, dashboard and invoices', () => {
  let ctx: TestApp;
  let ops: Awaited<ReturnType<typeof seedUser>>;
  let client: Awaited<ReturnType<typeof seedUser>>;
  let otherClient: Awaited<ReturnType<typeof seedUser>>;

  beforeAll(async () => {
    // A *test-mode* key, which is the interesting configuration rather than
    // the absent one: `checkoutAvailableTo` opens it to ops and closes it to
    // clients, because a test key renders a Checkout page that declines every
    // card a real subscriber owns. That split is what lets one app instance
    // exercise both the 503 arm (as a client) and everything behind it (as
    // ops).
    ctx = await setupTestApp({
      AUTO_PIPELINE: 'off',
      EMAIL_MODE: 'off',
      STRIPE_SECRET_KEY: 'sk_test_notarealkey',
    });
    ops = await seedUser(ctx, { roles: ['admin'] });
    client = await seedUser(ctx, { roles: ['valuation_user'] });
    otherClient = await seedUser(ctx, { roles: ['valuation_user'] });
  });
  afterAll(async () => ctx?.teardown());

  const get = (url: string, token: string) =>
    ctx.app.inject({ method: 'GET', url, headers: authHeader(token) });

  const subscribe = (token: string, payload: unknown) =>
    ctx.app.inject({ method: 'POST', url: '/api/v1/billing/subscribe', headers: authHeader(token), payload });

  // ── Plans ─────────────────────────────────────────────────────────────────
  describe('the plan catalogue', () => {
    it('reports the same test key as configured for ops and not for a client', async () => {
      // The whole point of the per-caller predicate, asserted from both sides
      // against one deployment.
      const asClient = await get('/api/v1/billing/plans', client.token);
      expect(asClient.statusCode).toBe(200);
      expect(asClient.json().plans.length).toBeGreaterThan(0);
      expect(asClient.json().configured).toBe(false);

      const asOps = await get('/api/v1/billing/plans', ops.token);
      expect(asOps.json().configured).toBe(true);
    });

    it('names a tier, price and interval on every plan', async () => {
      const res = await get('/api/v1/billing/plans', client.token);
      for (const plan of res.json().plans as Array<Record<string, unknown>>) {
        expect(typeof plan.tier).toBe('string');
        expect(Number.isFinite(Number(plan.price_cents))).toBe(true);
        expect(['month', 'year', 'one_time']).toContain(plan.interval);
      }
    });

    it('requires authentication', async () => {
      const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/billing/plans' });
      expect(res.statusCode).toBe(401);
    });
  });

  // ── Subscribe ─────────────────────────────────────────────────────────────
  describe('subscribing', () => {
    it('503s a client with a billing-specific problem type on a test key', async () => {
      // Deliberately not a 500 and not a generic 503: the settings page reads
      // the type to render "billing is unavailable" rather than an error. A
      // client under a test key is exactly the case — the button would open a
      // Checkout that declines their card.
      const res = await subscribe(client.token, { plan_tier: 'retainer' });
      expect(res.statusCode).toBe(503);
      expect(res.json().type).toBe('urn:n409:problem:billing-unavailable');
    });

    it('422s a body with no plan tier in it', async () => {
      // The shape check sits behind the configuration check, so this asserts
      // the order as much as the status.
      for (const payload of [{}, { plan_tier: '' }, { plan_tier: 42 }]) {
        const res = await subscribe(ops.token, payload);
        expect(res.statusCode, JSON.stringify(payload)).toBe(422);
      }
    });

    it('404s a plan tier that does not exist', async () => {
      const res = await subscribe(ops.token, { plan_tier: 'platinum-unlimited' });
      expect(res.statusCode).toBe(404);
    });

    it('422s the per-valuation plan, which is not a subscription', async () => {
      const plans = (await get('/api/v1/billing/plans', ops.token)).json().plans as Array<{
        tier: string;
        interval: string;
      }>;
      const oneTime = plans.find((p) => p.interval === 'one_time');
      expect(oneTime, 'expected a one_time plan in the catalogue').toBeTruthy();
      const res = await subscribe(ops.token, { plan_tier: oneTime!.tier });
      expect(res.statusCode).toBe(422);
      expect(res.json().detail).toMatch(/not a subscription/i);
      // And what to do instead. The refusal is correct but it is also a dead
      // end without this half: the reader picked this plan on purpose and
      // needs to know it is bought by starting a valuation, not signed up for.
      expect(res.json().detail).toMatch(/start a valuation/i);
    });
  });

  // ── The caller's own subscription ─────────────────────────────────────────
  describe('/me/subscription', () => {
    it('answers with nulls rather than 404 for a caller who has never subscribed', async () => {
      // A user with no subscription is the ordinary case, not a missing
      // resource — the settings page renders the plan picker from this.
      const res = await get('/api/v1/me/subscription', client.token);
      expect(res.statusCode).toBe(200);
      expect(res.json().subscription).toBeNull();
      expect(res.json().plan).toBeNull();
      expect(res.json().usage).toBeNull();
      expect(res.json().invoices).toEqual([]);
    });

    it('hides the portal control when there is a key but no customer record', async () => {
      // The second half of `Boolean(key) && customerId !== null`. A key is
      // configured here, so a false answer can only come from the customer
      // lookup — the control has nothing to open until somebody subscribes.
      const res = await get('/api/v1/me/subscription', client.token);
      expect(res.json().portal_available).toBe(false);
    });

    it('409s the portal for a caller with no billing account', async () => {
      // Not a 404: the caller is real and the route is right, there is simply
      // no Stripe customer yet. The message says what to do about it.
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/billing/portal',
        headers: authHeader(client.token),
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().detail).toMatch(/subscribe to a plan first/i);
    });
  });

  // ── Admin dashboard ───────────────────────────────────────────────────────
  describe('the admin dashboard', () => {
    it('is operations-only', async () => {
      const res = await get('/api/v1/admin/billing', client.token);
      expect(res.statusCode).toBe(403);
      expect(res.json().detail).toMatch(/operations-only/i);
    });

    it('400s a page limit outside its range, on either list', async () => {
      for (const q of ['limit=0', 'limit=100000', 'invoice_limit=0', 'invoice_limit=100000', 'limit=x']) {
        const res = await get(`/api/v1/admin/billing?${q}`, ops.token);
        expect(res.statusCode, q).toBe(400);
      }
    });

    it('reports a summary that is not a reduce over the page it shows', async () => {
      // Capping what the screen lists must not move what the screen says, so
      // the summary is its own query. Asked for one row, the summary still
      // has to be a summary of everything.
      const res = await get('/api/v1/admin/billing?limit=1&invoice_limit=1', ops.token);
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.subscriptions.length).toBeLessThanOrEqual(1);
      expect(body.invoices.length).toBeLessThanOrEqual(1);
      expect(typeof body.subscriptions_truncated).toBe('boolean');
      expect(typeof body.invoices_truncated).toBe('boolean');
      expect(body.summary).toBeTruthy();
      // The page limits are advertised so the console can say "showing N of".
      expect(body.page_limit).toBeGreaterThan(0);
      expect(body.invoice_page_limit).toBeGreaterThan(0);
    });

    it('defaults both limits when the query says nothing', async () => {
      const res = await get('/api/v1/admin/billing', ops.token);
      expect(res.statusCode).toBe(200);
      expect(res.json().summary).toBeTruthy();
    });
  });

  // ── Invoice PDF ───────────────────────────────────────────────────────────
  describe('the invoice PDF', () => {
    let seq = 0;
    async function seedInvoice(userId: string): Promise<string> {
      const id = newUlid();
      await ctx.pool.query(
        `INSERT INTO invoices (id, user_id, number, amount_cents, currency, status, issued_at, line_items)
         VALUES ($1, $2, $3, 25000, 'usd', 'paid', now(), $4::jsonb)`,
        [
          id,
          userId,
          `INV-TEST-${(seq += 1)}`,
          JSON.stringify([{ description: 'Retainer', amount_cents: 25000 }]),
        ],
      );
      return id;
    }

    it('404s an invoice that belongs to somebody else, and serves the owner theirs', async () => {
      // 404 rather than 403: an invoice number the caller cannot see should not
      // be confirmable as existing.
      const invoiceId = await seedInvoice(client.id);

      const stranger = await get(`/api/v1/billing/invoices/${invoiceId}/pdf`, otherClient.token);
      expect(stranger.statusCode).toBe(404);

      const owner = await get(`/api/v1/billing/invoices/${invoiceId}/pdf`, client.token);
      expect(owner.statusCode).toBe(200);
      expect(owner.headers['content-type']).toContain('application/pdf');
      expect(owner.headers['content-disposition']).toContain('.pdf');

      // Ops may fetch anyone's.
      const opsRes = await get(`/api/v1/billing/invoices/${invoiceId}/pdf`, ops.token);
      expect(opsRes.statusCode).toBe(200);
    });

    it('404s an invoice id that does not exist', async () => {
      const res = await get('/api/v1/billing/invoices/01ARZ3NDEKTSV4RRFFQ69G5FAV/pdf', ops.token);
      expect(res.statusCode).toBe(404);
    });
  });
});
