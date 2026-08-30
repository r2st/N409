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

  /*
   * The slug lookup, the 404s and the archived channel used to be asserted here
   * against `/api/v1/public/partners/:key/branding`, a second public branding
   * endpoint that predated migration 0091 and served the pre-white-label
   * columns: the ops channel label rather than `brand_name`, and a firm's
   * staged colour and logo whether or not `white_label_enabled` was on. The
   * login page read it, so the one page white label exists for was the one page
   * resolving the brand a different way from everything else.
   *
   * It is gone, and `/api/v1/public/branding/:key` — the resolver every other
   * surface uses — answers all three cases in `branding.test.ts`.
   */

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
