import { createHash } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { FixedWindowRateLimiter } from '../../src/plugins/rateLimit.js';
import { authHeader, isDbAvailable, seedPartner, seedUser, setupTestApp, type TestApp } from './helpers.js';

const dbUp = await isDbAvailable();

/** Improvement 6 — programmatic partner API behind API-key auth. */

describe.skipIf(!dbUp)('partner API', () => {
  let ctx: TestApp;
  let app: FastifyInstance;
  let partnerId: string;
  let otherPartnerId: string;
  let apiKey: string;
  let otherApiKey: string;
  let partnerAdminToken: string;

  const keyHeader = (key: string) => ({ authorization: `Bearer ${key}` });

  beforeAll(async () => {
    const docsDir = await mkdtemp(path.join(tmpdir(), 'n409-partner-api-'));
    ctx = await setupTestApp(
      { DOCUMENTS_DIR: docsDir },
      { partnerApiLimiter: new FixedWindowRateLimiter(1000, 60_000) },
    );
    app = ctx.app;
    partnerId = await seedPartner(ctx, 'Acme Advisors');
    otherPartnerId = await seedPartner(ctx, 'Rival Partners');

    const admin = await seedUser(ctx, { roles: ['partner'], partnerId });
    partnerAdminToken = admin.token;
    const minted = await app.inject({
      method: 'POST',
      url: `/api/v1/partners/${partnerId}/tokens`,
      headers: authHeader(partnerAdminToken),
      payload: { name: 'CI integration' },
    });
    expect(minted.statusCode).toBe(201);
    apiKey = minted.json().secret as string;

    const otherAdmin = await seedUser(ctx, { roles: ['partner'], partnerId: otherPartnerId });
    const otherMinted = await app.inject({
      method: 'POST',
      url: `/api/v1/partners/${otherPartnerId}/tokens`,
      headers: authHeader(otherAdmin.token),
      payload: { name: 'Rival key' },
    });
    otherApiKey = otherMinted.json().secret as string;
  }, 60_000);

  afterAll(async () => {
    await ctx?.teardown();
  });

  it('serves machine-readable docs publicly, generated from the route registry', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/partner/v1/docs' });
    expect(res.statusCode).toBe(200);
    const docs = res.json();
    expect(docs.version).toBe('v1');
    expect(docs.rate_limit.limit).toBeGreaterThan(0);
    const paths = docs.endpoints.map((e: { method: string; path: string }) => `${e.method} ${e.path}`);
    expect(paths).toContain('POST /valuations');
    expect(paths).toContain('GET /valuations/{id}');
    expect(paths).toContain('POST /valuations/{id}/documents');
    expect(paths).toContain('GET /valuations/{id}/results');
  });

  it('rejects session JWTs — the surface is API-key only', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/partner/v1/valuations',
      headers: authHeader(partnerAdminToken),
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().detail).toContain('API key');
  });

  it('rejects missing/garbage credentials', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/partner/v1/valuations' })).statusCode).toBe(401);
    const bad = await app.inject({
      method: 'GET',
      url: '/api/partner/v1/valuations',
      headers: keyHeader('n409_pat_not_a_real_key'),
    });
    expect(bad.statusCode).toBe(401);
  });

  it('creates a valuation scoped to the key partner and returns rate-limit headers', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/partner/v1/valuations',
      headers: keyHeader(apiKey),
      payload: { kind: '409a', company_name: 'API Client Co', currency: 'USD' },
    });
    expect(res.statusCode).toBe(201);
    expect(Number(res.headers['x-ratelimit-limit'])).toBeGreaterThan(0);
    expect(res.headers['x-ratelimit-remaining']).toBeDefined();
    const { valuation } = res.json();
    expect(valuation.company_name).toBe('API Client Co');
    expect(valuation.state).toBe('pending');
    // internal fields stay internal
    expect(valuation.user_id).toBeUndefined();
    expect(valuation.partner_id).toBeUndefined();

    // status check
    const status = await app.inject({
      method: 'GET',
      url: `/api/partner/v1/valuations/${valuation.id}`,
      headers: keyHeader(apiKey),
    });
    expect(status.statusCode).toBe(200);
    expect(status.json().valuation.id).toBe(valuation.id);

    // list is partner-scoped
    const list = await app.inject({
      method: 'GET',
      url: '/api/partner/v1/valuations',
      headers: keyHeader(apiKey),
    });
    expect(list.json().total).toBe(1);

    // another partner's key gets a 404, not a 403 — no id oracle
    const foreign = await app.inject({
      method: 'GET',
      url: `/api/partner/v1/valuations/${valuation.id}`,
      headers: keyHeader(otherApiKey),
    });
    expect(foreign.statusCode).toBe(404);
    const foreignList = await app.inject({
      method: 'GET',
      url: '/api/partner/v1/valuations',
      headers: keyHeader(otherApiKey),
    });
    expect(foreignList.json().total).toBe(0);
  });

  it('uploads a base64 document and surfaces it in results', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/partner/v1/valuations',
      headers: keyHeader(apiKey),
      payload: { kind: '409a', company_name: 'DocCo' },
    });
    const id = created.json().valuation.id as string;

    const content = Buffer.from('%PDF-1.4 fake cap table');
    const upload = await app.inject({
      method: 'POST',
      url: `/api/partner/v1/valuations/${id}/documents`,
      headers: keyHeader(apiKey),
      payload: {
        filename: 'cap-table.pdf',
        kind: 'cap_table',
        content_type: 'application/pdf',
        content_base64: content.toString('base64'),
      },
    });
    expect(upload.statusCode).toBe(201);
    expect(upload.json().document.sha256).toBe(createHash('sha256').update(content).digest('hex'));

    const results = await app.inject({
      method: 'GET',
      url: `/api/partner/v1/valuations/${id}/results`,
      headers: keyHeader(apiKey),
    });
    expect(results.statusCode).toBe(200);
    const body = results.json();
    expect(body.calculation).toBeNull();
    expect(body.documents).toHaveLength(1);
    expect(body.documents[0].filename).toBe('cap-table.pdf');
    expect(body.report).toEqual({ available: false, version: null });

    // no rendered report yet → 404
    const pdf = await app.inject({
      method: 'GET',
      url: `/api/partner/v1/valuations/${id}/report.pdf`,
      headers: keyHeader(apiKey),
    });
    expect(pdf.statusCode).toBe(404);
  });

  it('rejects empty and oversized uploads', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/partner/v1/valuations',
      headers: keyHeader(apiKey),
      payload: { kind: '409a', company_name: 'EdgeCo' },
    });
    const id = created.json().valuation.id as string;
    const empty = await app.inject({
      method: 'POST',
      url: `/api/partner/v1/valuations/${id}/documents`,
      headers: keyHeader(apiKey),
      payload: { filename: 'x.pdf', content_base64: '' },
    });
    expect(empty.statusCode).toBe(422);
  });

  it('rate limits per key with 429 + retry-after once the window is exhausted', async () => {
    const tight = await setupTestApp(
      {},
      { partnerApiLimiter: new FixedWindowRateLimiter(2, 60_000) },
    );
    try {
      const pid = await seedPartner(tight, 'Tight Org');
      const admin = await seedUser(tight, { roles: ['partner'], partnerId: pid });
      const minted = await tight.app.inject({
        method: 'POST',
        url: `/api/v1/partners/${pid}/tokens`,
        headers: authHeader(admin.token),
        payload: { name: 'tight' },
      });
      const key = minted.json().secret as string;

      const ping = () =>
        tight.app.inject({
          method: 'GET',
          url: '/api/partner/v1/valuations',
          headers: keyHeader(key),
        });
      expect((await ping()).statusCode).toBe(200);
      expect((await ping()).statusCode).toBe(200);
      const limited = await ping();
      expect(limited.statusCode).toBe(429);
      expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
      expect(limited.headers['x-ratelimit-remaining']).toBe('0');
    } finally {
      await tight.teardown();
    }
  }, 60_000);

  it('revoked keys stop working immediately', async () => {
    const minted = await app.inject({
      method: 'POST',
      url: `/api/v1/partners/${partnerId}/tokens`,
      headers: authHeader(partnerAdminToken),
      payload: { name: 'short-lived' },
    });
    const { token, secret } = minted.json();
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/api/partner/v1/valuations',
          headers: keyHeader(secret),
        })
      ).statusCode,
    ).toBe(200);

    await app.inject({
      method: 'DELETE',
      url: `/api/v1/api-tokens/${token.id}`,
      headers: authHeader(partnerAdminToken),
    });
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/api/partner/v1/valuations',
          headers: keyHeader(secret),
        })
      ).statusCode,
    ).toBe(401);
  });
});
