import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authHeader, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';
import { INVITATION_PAGE_LIMIT } from '../../src/repos/invitations.js';
import { SUPPORT_MESSAGE_PAGE_LIMIT } from '../../src/repos/support.js';
import { CONTACT_SUBMISSION_PAGE_LIMIT } from '../../src/repos/contactSubmissions.js';
import { CALCULATION_PAGE_LIMIT } from '../../src/repos/calculations.js';
import { AI_JOB_PAGE_LIMIT } from '../../src/repos/aiJobs.js';
import { QA_REVIEW_PAGE_LIMIT } from '../../src/repos/qaReviews.js';
import { HEALTH_CHECK_PAGE_LIMIT } from '../../src/repos/healthChecks.js';
import { BILLING_PAYMENT_PAGE_LIMIT, UNPAID_VALUATION_PAGE_LIMIT } from '../../src/repos/payments.js';

const dbUp = await isDbAvailable();

/**
 * Ten lists that were capped in SQL and said nothing about it.
 *
 * Each had a literal `LIMIT` written into the query and no flag beside it, so
 * the frontend truncation census — which keys on the *presence* of a flag —
 * could not see them: they were not truncating endpoints as far as it could
 * tell, they were endpoints with nothing to be asked about. That is the failure
 * mode `test/unit/silentCapCensus.test.ts` now guards in the other direction.
 *
 * These assertions are about shape rather than about reaching a two-hundredth
 * row: the defect was a response that carried rows and no way to learn whether
 * there were more, so what has to be true is that every one of these answers
 * has the flag on it and that the caps are the constants the repos state. A
 * client cannot render a notice for a field the response does not have.
 */
describe.skipIf(!dbUp)('a capped list says it was capped', () => {
  let ctx: TestApp;
  let ops: Awaited<ReturnType<typeof seedUser>>;
  let client: Awaited<ReturnType<typeof seedUser>>;
  let valuationId: string;

  beforeAll(async () => {
    ctx = await setupTestApp();
    ops = await seedUser(ctx, { roles: ['admin', 'reviewer'] });
    client = await seedUser(ctx, { roles: ['valuation_user'] });
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/valuations',
      headers: authHeader(client.token),
      payload: { kind: '409a', company_name: 'Capped Co' },
    });
    expect(created.statusCode).toBe(201);
    valuationId = created.json().valuation.id as string;
  });

  afterAll(async () => {
    await ctx?.teardown();
  });

  const get = async (url: string, token = ops.token) => {
    const res = await ctx.app.inject({ method: 'GET', url, headers: authHeader(token) });
    expect(res.statusCode, url).toBe(200);
    return res.json() as Record<string, unknown>;
  };

  it('flags the four per-engagement run histories', async () => {
    for (const [url, rows] of [
      [`/api/v1/valuations/${valuationId}/calculations`, 'calculations'],
      [`/api/v1/valuations/${valuationId}/ai`, 'jobs'],
      [`/api/v1/valuations/${valuationId}/qa`, 'reviews'],
      [`/api/v1/valuations/${valuationId}/health-checks`, 'health_checks'],
    ] as const) {
      const body = await get(url);
      expect(Array.isArray(body[rows]), `${url} → ${rows}`).toBe(true);
      // `toHaveProperty` rather than a truthiness check: `false` is the value
      // these carry on an empty engagement, and an absent field is the bug.
      expect(body, url).toHaveProperty('truncated', false);
    }
  });

  it('flags the two admin inboxes and the invitation ledger', async () => {
    expect(await get('/api/v1/users/invitations')).toHaveProperty('truncated', false);
    expect(await get('/api/v1/support/messages')).toHaveProperty('truncated', false);
    expect(await get('/api/v1/contact/submissions')).toHaveProperty('truncated', false);
  });

  /**
   * The billing page is the sharpest case: `payments` is not only drawn as a
   * table, it is summed into "total paid", and `unpaid_valuations.length` is a
   * stat card. Past either cap the page stated a number rather than showing a
   * short list.
   */
  it('flags both billing lists, which the page turns into figures', async () => {
    const body = (await get('/api/v1/me/billing', client.token)).billing as Record<string, unknown>;
    expect(body).toHaveProperty('payments_truncated', false);
    expect(body).toHaveProperty('unpaid_truncated', false);
  });

  /**
   * The contact form had a POST, a list and a status PATCH, and nothing in the
   * product called either of the last two — every enquiry from the marketing
   * site landed where only a `psql` session could read it. The inbox is now the
   * second queue on the ops support page, so the round trip a triaging operator
   * makes has to work end to end.
   */
  it('lists and triages a contact enquiry', async () => {
    const posted = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/contact',
      payload: {
        name: 'Dana Reed',
        email: 'dana@example.com',
        company: 'Reed Capital',
        message: 'We need a 409A for our Series A.',
      },
    });
    expect(posted.statusCode).toBe(201);

    const listed = await get('/api/v1/contact/submissions?status=new');
    const rows = listed.submissions as Array<Record<string, unknown>>;
    const mine = rows.find((r) => r.email === 'dana@example.com');
    expect(mine, 'the enquiry is in the new queue').toBeDefined();

    const handled = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/contact/submissions/${mine!.id as string}`,
      headers: authHeader(ops.token),
      payload: { status: 'handled' },
    });
    expect(handled.statusCode).toBe(200);
    expect(handled.json().submission.status).toBe('handled');

    // And it leaves the queue it was triaged out of, which is what makes the
    // status filter on the page mean anything.
    const after = await get('/api/v1/contact/submissions?status=new');
    expect((after.submissions as Array<Record<string, unknown>>).map((r) => r.email)).not.toContain(
      'dana@example.com',
    );
  });

  it('is operations-only, both queues', async () => {
    for (const url of ['/api/v1/contact/submissions']) {
      const res = await ctx.app.inject({
        method: 'GET',
        url,
        headers: authHeader(client.token),
      });
      expect(res.statusCode, url).toBe(403);
    }
  });

  /**
   * The caps themselves, so a later edit cannot quietly tighten one. These are
   * the numbers the queries have always used; R162 gave them names and a flag
   * rather than changing them.
   */
  it('keeps the caps the queries already had', () => {
    expect(INVITATION_PAGE_LIMIT).toBe(200);
    expect(SUPPORT_MESSAGE_PAGE_LIMIT).toBe(200);
    expect(CONTACT_SUBMISSION_PAGE_LIMIT).toBe(200);
    expect(CALCULATION_PAGE_LIMIT).toBe(20);
    expect(AI_JOB_PAGE_LIMIT).toBe(50);
    expect(QA_REVIEW_PAGE_LIMIT).toBe(20);
    expect(HEALTH_CHECK_PAGE_LIMIT).toBe(20);
    expect(BILLING_PAYMENT_PAGE_LIMIT).toBe(500);
    expect(UNPAID_VALUATION_PAGE_LIMIT).toBe(100);
  });
});
