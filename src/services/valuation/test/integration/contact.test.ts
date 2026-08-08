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
      // Stored canonically, not as the submitter spaced it.
      phone: '+15551234567',
      status: 'new',
    });
  });

  // Each submission below comes from its own address: the limiter is 5 per IP
  // per 10 minutes and has its own test at the bottom of this file.
  let nextIp = 0;
  const postFrom = (payload: Record<string, unknown>) =>
    ctx.app.inject({
      method: 'POST',
      url: '/api/v1/contact',
      payload,
      remoteAddress: `203.0.113.${++nextIp}`,
    });

  it('normalizes a phone number and refuses one that cannot be dialled', async () => {
    expect((await postFrom({ ...VALID, phone: '+44 (0)20 7946 0000' })).statusCode).toBe(201);
    // No country code — the shape this field took before it was validated, and
    // the shape an SMS to that contact would have silently failed on.
    expect((await postFrom({ ...VALID, phone: '(555) 123-4567' })).statusCode).toBe(422);
    expect((await postFrom({ ...VALID, phone: '+1234' })).statusCode).toBe(422);

    const { rows } = await ctx.pool.query(
      `SELECT phone FROM contact_submissions ORDER BY created_at DESC, id DESC LIMIT 1`,
    );
    expect(rows[0].phone).toBe('+442079460000');
  });

  it('treats a blank or missing phone as no phone at all', async () => {
    for (const phone of ['', '   ', null]) {
      expect((await postFrom({ ...VALID, phone })).statusCode).toBe(201);
    }
    const { phone: _omitted, ...withoutPhone } = VALID;
    expect((await postFrom(withoutPhone)).statusCode).toBe(201);

    const { rows } = await ctx.pool.query(
      `SELECT phone FROM contact_submissions ORDER BY created_at DESC, id DESC LIMIT 4`,
    );
    expect(rows.map((r) => r.phone)).toEqual([null, null, null, null]);
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
