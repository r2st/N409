import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { authHeader, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';

/**
 * Server-side enforcement of the intake answer rules.
 *
 * The browser warns, but the browser is not the gate: the client portal is
 * reachable by anyone holding a link, and the questionnaire lands in a jsonb
 * column that the engine later reads as fact. So the same rules that colour a
 * field amber have to be able to refuse a submission, and the schema endpoint
 * has to actually ship them or the two sides silently disagree.
 */

const dbUp = await isDbAvailable();

/** Every required answer, all of them valid — the baseline a test then spoils. */
const COMPLETE_ANSWERS = {
  legal_name: 'Northwind Robotics, Inc.',
  state_of_incorporation: 'Delaware',
  incorporation_date: '2019-04-02',
  industry: 'Robotics',
  business_description: 'Autonomous warehouse robots.',
  revenue_status: 'post_revenue',
  total_shares_outstanding: 10_000_000,
  has_articles: true,
};

describe.skipIf(!dbUp)('intake answer validation', () => {
  let ctx: TestApp;
  let app: FastifyInstance;
  let client: Awaited<ReturnType<typeof seedUser>>;
  let valuationId: string;

  const save = (answers: Record<string, unknown>) =>
    app.inject({
      method: 'PUT',
      url: `/api/v1/valuations/${valuationId}/questionnaire`,
      headers: authHeader(client.token),
      payload: { answers },
    });

  const submit = () =>
    app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${valuationId}/questionnaire/submit`,
      headers: authHeader(client.token),
      payload: {},
    });

  beforeAll(async () => {
    ctx = await setupTestApp({ AUTO_PIPELINE: 'off', EMAIL_MODE: 'off' });
    app = ctx.app;
    client = await seedUser(ctx, { roles: ['valuation_user'] });
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/valuations',
      headers: authHeader(client.token),
      payload: { kind: '409a', company_name: 'ValidationCo' },
    });
    valuationId = created.json().valuation.id;
  });

  afterAll(async () => {
    await ctx?.teardown();
  });

  it('ships the rules with the schema so the wizard can warn without a round trip', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/intake/schema',
      headers: authHeader(client.token),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();

    const fields = body.sections.flatMap((s: { fields: unknown[] }) => s.fields) as Array<{
      key: string;
      type: string;
      rules?: Record<string, unknown>;
    }>;
    expect(fields.find((f) => f.key === 'last_fy_revenue')?.rules).toMatchObject({ min: 0 });
    expect(fields.find((f) => f.key === 'incorporation_date')?.rules).toMatchObject({ notFuture: true });
    expect(Array.isArray(body.cross_rules)).toBe(true);
    expect(body.cross_rules.length).toBeGreaterThan(0);
  });

  it('reports issues on save and on read', async () => {
    const saved = await save({ ...COMPLETE_ANSWERS, last_fy_revenue: -1 });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().issues).toContainEqual({
      field: 'last_fy_revenue',
      severity: 'error',
      message: 'Last fiscal-year revenue cannot be negative.',
    });

    const read = await app.inject({
      method: 'GET',
      url: `/api/v1/valuations/${valuationId}/questionnaire`,
      headers: authHeader(client.token),
    });
    expect(read.json().issues).toHaveLength(1);
  });

  it('refuses to accept a submission carrying an impossible answer', async () => {
    // Completion is satisfied — every required field is answered — so this
    // 422 is the validation gate and not the old "you missed a field" one.
    const res = await submit();
    expect(res.statusCode).toBe(422);
    const body = res.json();
    expect(body.detail).toMatch(/Correct the highlighted answers/);
    expect(body.issues).toEqual([
      {
        field: 'last_fy_revenue',
        severity: 'error',
        message: 'Last fiscal-year revenue cannot be negative.',
      },
    ]);
  });

  it('rejects a date that is not a real day', async () => {
    const res = await save({ ...COMPLETE_ANSWERS, incorporation_date: '2019-02-30', last_fy_revenue: 1 });
    expect(res.json().issues).toContainEqual({
      field: 'incorporation_date',
      severity: 'error',
      message: 'Date of incorporation must be a valid date (YYYY-MM-DD).',
    });
    expect((await submit()).statusCode).toBe(422);
  });

  it('rejects a round that closed before the company was incorporated', async () => {
    const res = await save({
      ...COMPLETE_ANSWERS,
      last_fy_revenue: 1,
      last_round_date: '2018-01-01',
    });
    expect(res.json().issues).toContainEqual({
      field: 'last_round_date',
      severity: 'error',
      message: 'The most recent round closed before the company was incorporated.',
    });
    expect((await submit()).statusCode).toBe(422);
  });

  it('lets an unusual but possible form through, and hands back the warnings', async () => {
    const saved = await save({
      ...COMPLETE_ANSWERS,
      last_fy_revenue: 250_000,
      last_round_date: '2023-05-01',
      cash_on_hand: 100_000,
      monthly_burn: 150_000,
      option_pool_size: 12_000_000,
    });
    const issues = saved.json().issues as Array<{ severity: string; field: string }>;
    expect(issues.every((i) => i.severity === 'warning')).toBe(true);
    expect(issues.map((i) => i.field).sort()).toEqual(['monthly_burn', 'option_pool_size']);

    const res = await submit();
    expect(res.statusCode).toBe(200);
    expect(res.json().submitted_at).toBeTruthy();
    // The warnings travel with the acceptance — an analyst picking this up
    // sees the same two questions the client was shown.
    expect(res.json().issues).toHaveLength(2);
  });

  it('accepts a clean form with nothing to report', async () => {
    await save({ ...COMPLETE_ANSWERS, cash_on_hand: 500_000, monthly_burn: 50_000, option_pool_size: null });
    const res = await submit();
    expect(res.statusCode).toBe(200);
    expect(res.json().issues).toEqual([]);
  });
});
