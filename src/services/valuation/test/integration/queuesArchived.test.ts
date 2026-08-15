import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newUlid } from '@n409/shared';
import { authHeader, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';

const dbUp = await isDbAvailable();

/**
 * The two work queues that kept offering retired engagements, and the one
 * ledger that is supposed to keep them.
 *
 * `archived_at` is the platform's soft delete, and `buildValuationWhere`
 * (repos/valuations.ts) filters it out of the list, the counts, the buckets and
 * the export. The reviewer queue and the pay-now list each build their own
 * WHERE and inherited none of it, so retiring an engagement withdrew it from
 * everywhere the client could see and left it in two places that ask somebody
 * to act on it: a reviewer with something to sign off, and a payer with an
 * invoice for an engagement they can no longer open.
 *
 * The payments ledger is the deliberate exception, asserted here so the rule is
 * not applied to it by a later sweep. Those payments were really taken. Money
 * that left a customer's account does not stop having done so because the
 * engagement was later retired, and dropping settled payments from their own
 * history would be the more serious bug of the two.
 */
describe.skipIf(!dbUp)('work queues drop retired engagements, the ledger keeps them', () => {
  let ctx: TestApp;
  let ops: Awaited<ReturnType<typeof seedUser>>;
  let client: Awaited<ReturnType<typeof seedUser>>;
  let reviewer: Awaited<ReturnType<typeof seedUser>>;

  let liveId: string;
  let retiredId: string;

  const seedValuation = async (args: { company: string; archived: boolean }): Promise<string> => {
    const id = newUlid();
    await ctx.pool.query(
      `INSERT INTO valuations
         (id, kind, company_name, user_id, state, paid_status, assigned_reviewer_id, archived_at)
       VALUES ($1, '409a', $2, $3, 'review', 'unpaid', $4, $5)`,
      [id, args.company, client.id, reviewer.id, args.archived ? new Date() : null],
    );
    return id;
  };

  const seedSucceededPayment = async (valuationId: string) => {
    await ctx.pool.query(
      `INSERT INTO payments (id, valuation_id, session_id, amount_cents, currency, status)
       VALUES ($1, $2, $3, 119000, 'USD', 'succeeded')`,
      [newUlid(), valuationId, `cs_test_${newUlid()}`],
    );
  };

  const get = async (url: string, token: string) => {
    const res = await ctx.app.inject({ method: 'GET', url, headers: authHeader(token) });
    expect(res.statusCode).toBe(200);
    return res.json();
  };

  beforeAll(async () => {
    ctx = await setupTestApp();
    ops = await seedUser(ctx, { roles: ['admin'] });
    client = await seedUser(ctx, { roles: ['valuation_user'] });
    reviewer = await seedUser(ctx, { roles: ['analyst'] });

    // Identical rows but for `archived_at`: same state, same reviewer, same
    // unpaid status, so nothing else can account for a difference below.
    liveId = await seedValuation({ company: 'Halverson Optics', archived: false });
    retiredId = await seedValuation({ company: 'Bellweather Freight', archived: true });

    await seedSucceededPayment(liveId);
    await seedSucceededPayment(retiredId);
  });

  afterAll(async () => ctx?.teardown());

  it('does not hand a reviewer a retired engagement to sign off', async () => {
    const queue = await get('/api/v1/reviews', ops.token);
    const ids = queue.reviews.map((v: { id: string }) => v.id);

    expect(ids).toContain(liveId);
    expect(ids).not.toContain(retiredId);
    // The queue's count is a separate query against the same WHERE, so it can
    // report a depth the page does not show.
    expect(queue.total).toBe(queue.reviews.length);
  });

  it('does not invoice a client for an engagement it withdrew', async () => {
    const { billing } = await get('/api/v1/me/billing', client.token);
    const unpaid = billing.unpaid_valuations.map((v: { id: string }) => v.id);

    expect(unpaid).toContain(liveId);
    expect(unpaid).not.toContain(retiredId);
  });

  it('keeps the retired engagement’s settled payment in the ledger', async () => {
    // The deliberate exception. A payment that cleared is history, not a queue.
    const { billing } = await get('/api/v1/me/billing', client.token);
    const paidFor = billing.payments.map((p: { valuation_id: string }) => p.valuation_id);

    expect(paidFor).toContain(liveId);
    expect(paidFor).toContain(retiredId);
  });
});
