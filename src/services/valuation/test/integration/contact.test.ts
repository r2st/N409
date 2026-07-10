import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authHeader, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';

/**
 * Public marketing contact form (409.ai gap #28): anyone can POST a message
 * (no auth), validation rejects junk, a per-IP limiter caps spam, and only ops
 * can read/triage the queue.
 */

const dbUp = await isDbAvailable();

const VALID = {
  name: 'Ada Lovelace',
  email: 'ada@analytical.example',
  company: 'Analytical Engines',
  phone: '+1 5551234567',
  message: 'We need a 409A valuation before our next board meeting.',
};

describe.skipIf(!dbUp)('contact form', () => {
  let ctx: TestApp;
  let ops: Awaited<ReturnType<typeof seedUser>>;
  let client: Awaited<ReturnType<typeof seedUser>>;

  beforeAll(async () => {
    ctx = await setupTestApp();
    ops = await seedUser(ctx, { roles: ['admin'] });
    client = await seedUser(ctx, { roles: ['valuation_user'] });
  });
  afterAll(async () => ctx?.teardown());

  it('accepts a public submission without auth and stores it', async () => {
    const res = await ctx.app.inject({ method: 'POST', url: '/api/v1/contact', payload: VALID });
    expect(res.statusCode).toBe(201);
    expect(res.json().submission.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);

    const { rows } = await ctx.pool.query('SELECT * FROM contact_submissions');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      name: VALID.name,
      email: VALID.email,
      company: VALID.company,
      phone: VALID.phone,
      status: 'new',
    });
  });

  it('rejects missing required fields with 422', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/contact',
      payload: { name: '', email: 'not-an-email', message: '' },
    });
    expect(res.statusCode).toBe(422);
  });

  it('lets ops list submissions but forbids clients', async () => {
    const forbidden = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/contact/submissions',
      headers: authHeader(client.token),
    });
    expect(forbidden.statusCode).toBe(403);

    const anon = await ctx.app.inject({ method: 'GET', url: '/api/v1/contact/submissions' });
    expect(anon.statusCode).toBe(401);

    const ok = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/contact/submissions',
      headers: authHeader(ops.token),
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().submissions.length).toBeGreaterThanOrEqual(1);
  });

  it('lets ops mark a submission handled', async () => {
    const list = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/contact/submissions',
      headers: authHeader(ops.token),
    });
    const id = list.json().submissions[0].id as string;

    const patch = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/contact/submissions/${id}`,
      headers: authHeader(ops.token),
      payload: { status: 'handled' },
    });
    expect(patch.statusCode).toBe(200);
    expect(patch.json().submission).toMatchObject({ status: 'handled', handled_by: ops.id });

    const clientPatch = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/contact/submissions/${id}`,
      headers: authHeader(client.token),
      payload: { status: 'new' },
    });
    expect(clientPatch.statusCode).toBe(403);
  });
});

describe.skipIf(!dbUp)('contact form rate limiting', () => {
  let ctx: TestApp;

  beforeAll(async () => {
    ctx = await setupTestApp();
  });
  afterAll(async () => ctx?.teardown());

  it('caps submissions per IP with a 429 after the window fills', async () => {
    const post = () => ctx.app.inject({ method: 'POST', url: '/api/v1/contact', payload: VALID });
    // Default limiter is 5 per 10 minutes; the 6th from the same IP is denied.
    for (let i = 0; i < 5; i++) {
      expect((await post()).statusCode).toBe(201);
    }
    const denied = await post();
    expect(denied.statusCode).toBe(429);
    expect(denied.headers['retry-after']).toBeDefined();
  });
});
