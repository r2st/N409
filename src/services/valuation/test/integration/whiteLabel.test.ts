import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { authHeader, isDbAvailable, seedPartner, seedUser, setupTestApp, type TestApp } from './helpers.js';

const dbUp = await isDbAvailable();

/** Improvement 8 — white-label: public branding, template admin, override delivery. */

describe.skipIf(!dbUp)('white-label partner portal', () => {
  let ctx: TestApp;
  let app: FastifyInstance;
  let pool: pg.Pool;
  let partnerId: string;
  let adminToken: string;

  beforeAll(async () => {
    ctx = await setupTestApp();
    app = ctx.app;
    pool = ctx.pool;
    partnerId = await seedPartner(ctx, 'Bridge Advisors');
    const admin = await seedUser(ctx, { roles: ['admin'] });
    adminToken = admin.token;
    await app.inject({
      method: 'PATCH',
      url: `/api/v1/partners/${partnerId}`,
      headers: authHeader(adminToken),
      payload: { brand_color: '#1f6f54', logo_url: 'https://cdn.example.com/bridge.png' },
    });
  }, 60_000);

  afterAll(async () => {
    await ctx?.teardown();
  });

  it('serves login branding publicly by slug', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/public/partners/bridge-advisors/branding' });
    expect(res.statusCode).toBe(200);
    expect(res.json().partner).toEqual({
      name: 'Bridge Advisors',
      key: 'bridge-advisors',
      brand_color: '#1f6f54',
      logo_url: 'https://cdn.example.com/bridge.png',
    });
  });

  it('404s unknown, malformed, and archived slugs', async () => {
    expect(
      (await app.inject({ method: 'GET', url: '/api/v1/public/partners/nope/branding' })).statusCode,
    ).toBe(404);
    expect(
      (await app.inject({ method: 'GET', url: '/api/v1/public/partners/UPPER%20case/branding' })).statusCode,
    ).toBe(404);

    const archivedId = await seedPartner(ctx, 'Gone Partners');
    await app.inject({
      method: 'PATCH',
      url: `/api/v1/partners/${archivedId}`,
      headers: authHeader(adminToken),
      payload: { archived: true },
    });
    expect(
      (await app.inject({ method: 'GET', url: '/api/v1/public/partners/gone-partners/branding' })).statusCode,
    ).toBe(404);
  });

  it('stores email template overrides and rejects unknown keys', async () => {
    const ok = await app.inject({
      method: 'PATCH',
      url: `/api/v1/partners/${partnerId}`,
      headers: authHeader(adminToken),
      payload: {
        email_templates: {
          valuation_started: {
            subject: '{{partner_name}} has begun your {{company_name}} valuation',
            body: 'Hello from {{partner_name}} — work on {{company_name}} ({{kind}}) has started.',
          },
        },
      },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().partner.email_templates.valuation_started.subject).toContain('{{partner_name}}');

    const bad = await app.inject({
      method: 'PATCH',
      url: `/api/v1/partners/${partnerId}`,
      headers: authHeader(adminToken),
      payload: { email_templates: { totally_made_up: { subject: 'x', body: 'y' } } },
    });
    expect(bad.statusCode).toBe(422);
  });

  it('delivers the partner-templated email on a state change', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/valuations',
      headers: authHeader(adminToken),
      payload: { kind: '409a', company_name: 'Acme Inc', partner_id: partnerId },
    });
    expect(created.statusCode).toBe(201);
    const valuationId = created.json().valuation.id as string;

    const moved = await app.inject({
      method: 'PATCH',
      url: `/api/v1/valuations/${valuationId}`,
      headers: authHeader(adminToken),
      payload: { state: 'started' },
    });
    expect(moved.statusCode).toBe(200);

    const { rows } = await pool.query(
      `SELECT subject, body, template_key FROM email_outbox WHERE valuation_id = $1`,
      [valuationId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].template_key).toBe('valuation_started');
    expect(rows[0].subject).toBe('Bridge Advisors has begun your Acme Inc valuation');
    expect(rows[0].body).toBe('Hello from Bridge Advisors — work on Acme Inc (409a) has started.');
  });

  it('keeps platform defaults for non-partner engagements', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/valuations',
      headers: authHeader(adminToken),
      payload: { kind: '409a', company_name: 'Solo Co' },
    });
    const valuationId = created.json().valuation.id as string;
    await app.inject({
      method: 'PATCH',
      url: `/api/v1/valuations/${valuationId}`,
      headers: authHeader(adminToken),
      payload: { state: 'started' },
    });
    const { rows } = await pool.query(`SELECT subject FROM email_outbox WHERE valuation_id = $1`, [
      valuationId,
    ]);
    expect(rows[0].subject).toBe("We've started your 409A valuation for Solo Co");
  });
});
