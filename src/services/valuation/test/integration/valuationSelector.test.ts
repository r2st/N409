import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isDbAvailable, setupTestApp, type TestApp } from './helpers.js';

const dbUp = await isDbAvailable();

describe.skipIf(!dbUp)('valuation selector quiz', () => {
  let ctx: TestApp;

  beforeAll(async () => {
    ctx = await setupTestApp();
  });

  afterAll(async () => {
    await ctx?.teardown();
  });

  it('answers anonymously — the quiz runs before an account exists', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/valuation-selector',
      payload: { purpose: 'issue_options', jurisdiction: 'us' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.primary.kind).toBe('409a');
    expect(body.primary.reasons.length).toBeGreaterThan(0);
    expect(body.inputs.purposes).toContain('issue_options');
  });

  it('rejects unknown fields and enum values', async () => {
    const badField = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/valuation-selector',
      payload: { purpose: 'issue_options', favorite_color: 'blue' },
    });
    expect(badField.statusCode).toBe(422);
    const badEnum = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/valuation-selector',
      payload: { purpose: 'world_domination' },
    });
    expect(badEnum.statusCode).toBe(422);
  });

  it('handles an empty body as no answers, not an error', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/valuation-selector',
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().primary).toBeNull();
  });
});
