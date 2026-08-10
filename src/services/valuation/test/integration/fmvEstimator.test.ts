import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isDbAvailable, setupTestApp, type TestApp } from './helpers.js';

const dbUp = await isDbAvailable();

describe.skipIf(!dbUp)('free 409A estimator', () => {
  let ctx: TestApp;

  beforeAll(async () => {
    ctx = await setupTestApp();
  });

  afterAll(async () => {
    await ctx?.teardown();
  });

  const post = (payload: unknown) =>
    ctx.app.inject({ method: 'POST', url: '/api/v1/fmv-estimator', payload });

  it('answers anonymously — a calculator behind a signup is not a free calculator', async () => {
    const res = await post({
      stage: 'series_a',
      round_age: 'under_6m',
      post_money: 25_000_000,
      fully_diluted_shares: 10_000_000,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.result.equity_value.median).toBeCloseTo(25_000_000, -1);
    expect(body.result.per_share.median).toBeGreaterThan(0);
    expect(body.result.evidence[0].source).toBe('priced_round');
    // The form renders from the vocabulary the endpoint scores.
    expect(body.inputs.stages).toContain('series_a');
    expect(body.inputs.round_ages).toContain('under_6m');
  });

  it('carries the safe-harbor disclaimer in the response body', async () => {
    const res = await post({ stage: 'seed', round_age: 'under_6m', revenue_ltm: 500_000 });
    expect(res.statusCode).toBe(200);
    expect(res.json().result.disclaimer).toMatch(/not a valuation/i);
  });

  it('names the four fields when given nothing to work with', async () => {
    const res = await post({ stage: 'seed', round_age: 'never' });
    expect(res.statusCode).toBe(422);
    expect(res.json().detail ?? res.json().title).toMatch(/round price, profit, revenue, or capital raised/i);
  });

  it('rejects unknown fields, bad enums, and out-of-range money', async () => {
    expect((await post({ stage: 'seed', round_age: 'never', favorite_color: 'blue' })).statusCode).toBe(422);
    expect((await post({ stage: 'series_z', round_age: 'never' })).statusCode).toBe(422);
    expect((await post({ stage: 'seed', round_age: 'under_6m', post_money: 1e15 })).statusCode).toBe(422);
    // A non-finite figure must not reach the multiple bands.
    expect((await post({ stage: 'seed', round_age: 'under_6m', revenue_ltm: 'lots' })).statusCode).toBe(422);
  });

  it('stores nothing — two identical calls are independent', async () => {
    const payload = { stage: 'series_b', round_age: '6_to_12m', post_money: 80_000_000 };
    const a = await post(payload);
    const b = await post(payload);
    expect(a.statusCode).toBe(200);
    expect(b.json().result).toEqual(a.json().result);
  });
});
