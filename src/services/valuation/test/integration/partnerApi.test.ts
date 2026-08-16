import { createHash } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { FixedWindowRateLimiter } from '../../src/plugins/rateLimit.js';
import { PARTNER_API_RATE_LIMIT_ORG } from '../../src/routes/partnerApi.js';
import {
  authHeader,
  forceState,
  isDbAvailable,
  seedPartner,
  seedUser,
  setupTestApp,
  type TestApp,
} from './helpers.js';

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

  it('withholds a rendered report until the draft has been shared with the partner', async () => {
    const ops = await seedUser(ctx, { roles: ['admin'] });
    const created = await app.inject({
      method: 'POST',
      url: '/api/partner/v1/valuations',
      headers: keyHeader(apiKey),
      payload: { kind: '409a', company_name: 'DraftCo' },
    });
    const id = created.json().valuation.id as string;

    // Ops render the report to check their own work, long before the draft is
    // shared — exactly the window where the deliverable must stay internal.
    const render = await app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${id}/report/render`,
      headers: authHeader(ops.token),
    });
    expect(render.statusCode).toBe(200);

    // The browser API 404s the partner here, and so must the partner API.
    const early = await app.inject({
      method: 'GET',
      url: `/api/partner/v1/valuations/${id}/report.pdf`,
      headers: keyHeader(apiKey),
    });
    expect(early.statusCode).toBe(404);
    const earlyResults = await app.inject({
      method: 'GET',
      url: `/api/partner/v1/valuations/${id}/results`,
      headers: keyHeader(apiKey),
    });
    // Not even the existence of a rendered draft leaks.
    expect(earlyResults.json().report).toEqual({ available: false, version: null });

    // `drafted` is an edge out of `reviewed`; the sharing is what this asserts on.
    await forceState(ctx, id, 'reviewed');
    const patch = await app.inject({
      method: 'PATCH',
      url: `/api/v1/valuations/${id}`,
      headers: authHeader(ops.token),
      payload: { state: 'drafted' },
    });
    expect(patch.statusCode).toBe(200);

    const shared = await app.inject({
      method: 'GET',
      url: `/api/partner/v1/valuations/${id}/report.pdf`,
      headers: keyHeader(apiKey),
    });
    expect(shared.statusCode).toBe(200);
    expect(shared.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');
    const sharedResults = await app.inject({
      method: 'GET',
      url: `/api/partner/v1/valuations/${id}/results`,
      headers: keyHeader(apiKey),
    });
    expect(sharedResults.json().report.available).toBe(true);
  }, 30_000);

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
    const tight = await setupTestApp({}, { partnerApiLimiter: new FixedWindowRateLimiter(2, 60_000) });
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

  /**
   * The per-key limit is not a ceiling on a caller, because the number of keys
   * is a knob the caller holds: `POST /partners/{id}/tokens` is self-service
   * and caps nothing. So "120 requests per minute", which the docs endpoint and
   * the OpenAPI description both state, described a key rather than an
   * organisation — and the shared engine and database the limit protects are
   * saturated by the organisation.
   */
  it('holds one budget across every key an organization mints', async () => {
    const tight = await setupTestApp(
      {},
      {
        // Per key: room for three calls. Per organisation: four in total. A
        // second key must therefore run out after one call, not after three.
        partnerApiLimiter: new FixedWindowRateLimiter(3, 60_000),
        partnerApiOrgLimiter: new FixedWindowRateLimiter(4, 60_000),
      },
    );
    try {
      const pid = await seedPartner(tight, 'Many Keys LLP');
      const admin = await seedUser(tight, { roles: ['partner'], partnerId: pid });
      const mint = async (name: string): Promise<string> => {
        const minted = await tight.app.inject({
          method: 'POST',
          url: `/api/v1/partners/${pid}/tokens`,
          headers: authHeader(admin.token),
          payload: { name },
        });
        expect(minted.statusCode).toBe(201);
        return minted.json().secret as string;
      };
      const first = await mint('first');
      const second = await mint('second');

      const ping = (key: string) =>
        tight.app.inject({ method: 'GET', url: '/api/partner/v1/valuations', headers: keyHeader(key) });

      // Spend the first key's own budget. Both budgets are reported, so a
      // partner running several integrations can see which one is binding
      // before either runs out.
      for (let i = 0; i < 3; i += 1) {
        const res = await ping(first);
        expect(res.statusCode).toBe(200);
        expect(res.headers['x-ratelimit-limit']).toBe('3');
        expect(res.headers['x-ratelimit-limit-partner']).toBe('4');
      }

      // The second key is untouched and has its full 3 — under a per-key limit
      // alone this and every further key would serve another three.
      const fourth = await ping(second);
      expect(fourth.statusCode).toBe(200);
      expect(fourth.headers['x-ratelimit-remaining']).toBe('2');
      expect(fourth.headers['x-ratelimit-remaining-partner']).toBe('0');

      const refused = await ping(second);
      expect(refused.statusCode).toBe(429);
      expect(refused.json().detail).toMatch(/across all of its API keys/);
      expect(Number(refused.headers['retry-after'])).toBeGreaterThan(0);
      // The key's own budget was not the binding one, and the headers say so.
      expect(refused.headers['x-ratelimit-remaining']).toBe('1');
      expect(refused.headers['x-ratelimit-remaining-partner']).toBe('0');
    } finally {
      await tight.teardown();
    }
  }, 60_000);

  it('charges the organization for a request its own key limit already refused', async () => {
    // Otherwise the ceiling is not one: spread a flood across enough keys and
    // every key sits at its own limit while the organisation is never charged
    // for any of it.
    const tight = await setupTestApp(
      {},
      {
        partnerApiLimiter: new FixedWindowRateLimiter(1, 60_000),
        partnerApiOrgLimiter: new FixedWindowRateLimiter(3, 60_000),
      },
    );
    try {
      const pid = await seedPartner(tight, 'Spray Capital');
      const admin = await seedUser(tight, { roles: ['partner'], partnerId: pid });
      const minted = await tight.app.inject({
        method: 'POST',
        url: `/api/v1/partners/${pid}/tokens`,
        headers: authHeader(admin.token),
        payload: { name: 'spray' },
      });
      const key = minted.json().secret as string;
      const ping = () =>
        tight.app.inject({ method: 'GET', url: '/api/partner/v1/valuations', headers: keyHeader(key) });

      expect((await ping()).statusCode).toBe(200);
      const rejected = await ping();
      expect(rejected.statusCode).toBe(429);
      // Two requests made, two charged to the organisation — including the one
      // that never ran a handler.
      expect(rejected.headers['x-ratelimit-remaining-partner']).toBe('1');
    } finally {
      await tight.teardown();
    }
  }, 60_000);

  it('publishes the limits this deployment actually enforces, not the constants', async () => {
    const docs = (await app.inject({ method: 'GET', url: '/api/partner/v1/docs' })).json();
    // This suite installs a 1000/min per-key limiter and leaves the ceiling at
    // its default. Reading both figures off the limiters rather than off the
    // module constants is what keeps a deployment that has moved either one
    // from publishing a number it does not enforce.
    expect(docs.rate_limit.limit).toBe(1000);
    expect(docs.rate_limit.organization_limit).toBe(PARTNER_API_RATE_LIMIT_ORG);
    expect(docs.rate_limit.headers).toContain('x-ratelimit-remaining-partner');

    const spec = (await app.inject({ method: 'GET', url: '/api/partner/v1/openapi.json' })).json();
    expect(spec.info.description).toMatch(
      new RegExp(`${PARTNER_API_RATE_LIMIT_ORG} per 60s across all of your organisation's keys`),
    );
  });

  it('says nothing about a ceiling when the deployment has turned it off', async () => {
    const open = await setupTestApp({}, { partnerApiOrgLimiter: null });
    try {
      const docs = (await open.app.inject({ method: 'GET', url: '/api/partner/v1/docs' })).json();
      expect(docs.rate_limit.organization_limit).toBeNull();
      expect(docs.rate_limit.headers).not.toContain('x-ratelimit-remaining-partner');

      const spec = (await open.app.inject({ method: 'GET', url: '/api/partner/v1/openapi.json' })).json();
      // Advertising a limit nobody enforces sends a client backing off against
      // a figure that means nothing here.
      expect(spec.info.description).not.toMatch(/organisation/);
    } finally {
      await open.teardown();
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

  /**
   * A partner key is the one credential here that carries an authority the
   * *token row* names rather than one re-read from the presenter: every route
   * scopes to `token.partner_id` and never consults the user behind it. So a
   * key kept working against the firm it named after its creator had left that
   * firm — one firm's client list, documents and concluded 409As, reachable by
   * a departed member, until somebody at the firm noticed the key and revoked
   * it by hand.
   */
  describe('a partner key follows its creator’s membership', () => {
    /** Mints a fresh firm, an admin in it, and that admin's org key. */
    async function seedFirmWithKey(name: string) {
      const firmId = await seedPartner(ctx, name);
      const admin = await seedUser(ctx, { roles: ['partner'], partnerId: firmId });
      const minted = await app.inject({
        method: 'POST',
        url: `/api/v1/partners/${firmId}/tokens`,
        headers: authHeader(admin.token),
        payload: { name: `${name} integration` },
      });
      expect(minted.statusCode).toBe(201);
      return { firmId, admin, secret: minted.json().secret as string };
    }

    const listWith = (secret: string) =>
      app.inject({ method: 'GET', url: '/api/partner/v1/valuations', headers: keyHeader(secret) });

    it('stops working when the creator is moved to another firm', async () => {
      const { admin, secret } = await seedFirmWithKey('Departure Advisors');
      const elsewhere = await seedPartner(ctx, 'Somewhere Else LLP');
      expect((await listWith(secret)).statusCode).toBe(200);

      await ctx.pool.query('UPDATE users SET partner_id = $2 WHERE id = $1', [admin.id, elsewhere]);

      expect((await listWith(secret)).statusCode).toBe(401);
    });

    it('stops working when the creator is removed from the firm entirely', async () => {
      const { admin, secret } = await seedFirmWithKey('Dissolved Advisors');
      expect((await listWith(secret)).statusCode).toBe(200);

      await ctx.pool.query('UPDATE users SET partner_id = NULL WHERE id = $1', [admin.id]);

      expect((await listWith(secret)).statusCode).toBe(401);
    });

    it('does not touch last_used_at on a key it refuses', async () => {
      // A refused key was not used, and a moved-out member should not be able
      // to keep a stale key looking live in the firm's settings page.
      const { admin, firmId, secret } = await seedFirmWithKey('Quiet Advisors');
      await ctx.pool.query('UPDATE users SET partner_id = NULL WHERE id = $1', [admin.id]);
      await listWith(secret);
      const { rows } = await ctx.pool.query<{ last_used_at: Date | null }>(
        'SELECT last_used_at FROM api_tokens WHERE partner_id = $1',
        [firmId],
      );
      expect(rows[0]!.last_used_at).toBeNull();
    });

    it('comes back when the move is undone, rather than being permanently dead', async () => {
      // Refused, not revoked: an admin who reassigns a user by mistake can put
      // them back, and a stolen key cannot be used to kill a firm's
      // integration for good.
      const { admin, firmId, secret } = await seedFirmWithKey('Boomerang Advisors');
      await ctx.pool.query('UPDATE users SET partner_id = NULL WHERE id = $1', [admin.id]);
      expect((await listWith(secret)).statusCode).toBe(401);

      await ctx.pool.query('UPDATE users SET partner_id = $2 WHERE id = $1', [admin.id, firmId]);
      expect((await listWith(secret)).statusCode).toBe(200);
    });

    it('leaves a personal token alone — it carries only its owner’s own scope', async () => {
      const client = await seedUser(ctx, { roles: ['valuation_user'] });
      const minted = await app.inject({
        method: 'POST',
        url: '/api/v1/me/tokens',
        headers: authHeader(client.token),
        payload: { name: 'my script' },
      });
      expect(minted.statusCode).toBe(201);
      const secret = minted.json().secret as string;

      // A personal token has no organisation to be a member of; it is rejected
      // by the partner API on its own terms, not by the membership rule.
      const res = await listWith(secret);
      expect(res.statusCode).toBe(403);
      expect(res.json().detail).toContain('personal tokens are not accepted');
    });
  });
});
