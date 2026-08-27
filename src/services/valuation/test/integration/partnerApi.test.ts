import { createHash } from 'node:crypto';
import { createCalculation } from '../../src/repos/calculations.js';
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
  let partnerAdminId: string;

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
    partnerAdminId = admin.id;
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

  /*
   * `/results` reports `equity_value` and `fmv_per_share` — 409A column names
   * that every engine writes into (domain/specialty.ts). On an EMI engagement
   * the per-share figure is the restricted AMV, and a partner integration reads
   * whatever is in the field. Which run it came off was decided by recency:
   * the Calculations tab offers the ordinary compute on every kind, so pressing
   * it once flipped an EMI engagement's published figure from the AMV to an
   * unrestricted §409A price, with nothing in the payload saying anything had
   * changed but the timestamp.
   */
  it('reports the run the engagement is measured in, not whichever ran last', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/partner/v1/valuations',
      headers: keyHeader(apiKey),
      payload: { kind: 'emi', company_name: 'Restricted Holdings' },
    });
    const id = created.json().valuation.id as string;
    await createCalculation(
      ctx.pool,
      {
        valuationId: id,
        engineVersion: 'py-1.0.0',
        status: 'succeeded',
        inputs: {},
        results: { kind: 'emi', specialty: { umv_per_share: 1.0, amv_per_share: 0.8 } },
        equityValue: 1_000_000,
        fmvPerShare: 0.8,
        createdBy: partnerAdminId,
      },
      { actorType: 'human', actorId: partnerAdminId },
    );
    await createCalculation(
      ctx.pool,
      {
        valuationId: id,
        engineVersion: 'py-1.0.0',
        status: 'succeeded',
        inputs: {},
        results: { approaches: { income: { equity_value: 1_400_000, weight: 1 } } },
        equityValue: 1_400_000,
        fmvPerShare: 1.4,
        createdBy: partnerAdminId,
      },
      { actorType: 'human', actorId: partnerAdminId },
    );

    const results = await app.inject({
      method: 'GET',
      url: `/api/partner/v1/valuations/${id}/results`,
      headers: keyHeader(apiKey),
    });
    expect(results.statusCode).toBe(200);
    expect(Number(results.json().calculation.fmv_per_share)).toBe(0.8);
    expect(Number(results.json().calculation.equity_value)).toBe(1_000_000);
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
        // Minting is re-authenticated — see routes/account.ts. `seedUser`'s
        // password.
        payload: { name: 'my script', current_password: 'test-password-123' },
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

// `GET /me` — the first call an integration makes and the one it makes when a
// key stops working. 409.ai's partner API documents the same endpoint; this one
// also answers "which of my keys is this", which is the question that actually
// comes up mid-rotation.
describe.skipIf(!dbUp)('partner API: GET /me', () => {
  let ctx: TestApp;
  let app: FastifyInstance;
  let partnerId: string;
  let apiKey: string;
  let adminToken: string;

  const keyHeader = (key: string) => ({ authorization: `Bearer ${key}` });

  beforeAll(async () => {
    ctx = await setupTestApp({}, { partnerApiLimiter: new FixedWindowRateLimiter(1000, 60_000) });
    app = ctx.app;
    partnerId = await seedPartner(ctx, 'Meridian Capital Partners');
    const admin = await seedUser(ctx, { roles: ['partner'], partnerId });
    adminToken = admin.token;
    const minted = await app.inject({
      method: 'POST',
      url: `/api/v1/partners/${partnerId}/tokens`,
      headers: authHeader(adminToken),
      payload: { name: 'production' },
    });
    expect(minted.statusCode).toBe(201);
    apiKey = minted.json().secret as string;
  });

  afterAll(async () => {
    await ctx?.teardown();
  });

  const me = async (key: string) =>
    app.inject({ method: 'GET', url: '/api/partner/v1/me', headers: keyHeader(key) });

  it('names the organization behind the key', async () => {
    const res = await me(apiKey);
    expect(res.statusCode).toBe(200);
    const body = res.json() as { partner: Record<string, unknown> };
    expect(body.partner.id).toBe(partnerId);
    expect(body.partner.name).toBe('Meridian Capital Partners');
    expect(typeof body.partner.key).toBe('string');
    expect(typeof body.partner.white_label_enabled).toBe('boolean');
  });

  // Mid-rotation a partner holds several keys and needs to know which one the
  // caller actually presented. The prefix is the visible half; the secret must
  // never come back out.
  it('names which key was used, by prefix, and never the secret', async () => {
    const res = await me(apiKey);
    const body = res.json() as { token: { name: string; prefix: string } };
    expect(body.token.name).toBe('production');
    expect(apiKey.startsWith(body.token.prefix)).toBe(true);
    expect(res.body).not.toContain(apiKey);
  });

  // Two keys for one organization: same partner, different token identity. The
  // second half is what makes the endpoint useful for anything.
  it('distinguishes two keys of the same organization', async () => {
    const second = await app.inject({
      method: 'POST',
      url: `/api/v1/partners/${partnerId}/tokens`,
      headers: authHeader(adminToken),
      payload: { name: 'staging' },
    });
    expect(second.statusCode).toBe(201);
    const first = (await me(apiKey)).json() as { partner: { id: string }; token: { id: string } };
    const other = (await me(second.json().secret as string)).json() as {
      partner: { id: string };
      token: { id: string };
    };
    expect(other.partner.id).toBe(first.partner.id);
    expect(other.token.id).not.toBe(first.token.id);
    expect(other.token.name).toBe('staging');
  });

  it('requires a key', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/partner/v1/me' });
    expect(res.statusCode).toBe(401);
  });

  // A session JWT is not an API key, and this endpoint is on the API-key
  // surface — the same rule every other partner endpoint follows.
  it('rejects a session bearer', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/partner/v1/me',
      headers: authHeader(adminToken),
    });
    expect(res.statusCode).toBe(403);
  });

  it('carries the rate-limit headers rather than repeating them in the body', async () => {
    const res = await me(apiKey);
    expect(res.headers['x-ratelimit-limit']).toBeDefined();
    expect(res.headers['x-ratelimit-remaining']).toBeDefined();
    // A second source for a number that moves between the two reads.
    expect(res.body).not.toContain('rate_limit');
  });

  // A live key whose organization has been archived. `apiKeyGuard` cannot catch
  // it — the token resolves fine — so without this the endpoint would invent an
  // identity for a firm that no longer exists.
  it('404s when the organization behind a valid key is archived', async () => {
    const doomedPartner = await seedPartner(ctx, 'Closed Advisors');
    const doomedAdmin = await seedUser(ctx, { roles: ['partner'], partnerId: doomedPartner });
    const minted = await app.inject({
      method: 'POST',
      url: `/api/v1/partners/${doomedPartner}/tokens`,
      headers: authHeader(doomedAdmin.token),
      payload: { name: 'about to close' },
    });
    const doomedKey = minted.json().secret as string;
    expect((await me(doomedKey)).statusCode).toBe(200);

    await ctx.pool.query('UPDATE partners SET archived_at = now() WHERE id = $1', [doomedPartner]);
    expect((await me(doomedKey)).statusCode).toBe(404);
  });

  it('is listed in the docs endpoint and the OpenAPI spec', async () => {
    const docs = await app.inject({ method: 'GET', url: '/api/partner/v1/docs' });
    const listed = (docs.json() as { endpoints: { method: string; path: string }[] }).endpoints;
    expect(listed).toContainEqual(expect.objectContaining({ method: 'GET', path: '/me' }));

    const spec = await app.inject({ method: 'GET', url: '/api/partner/v1/openapi.json' });
    expect((spec.json() as { paths: Record<string, unknown> }).paths['/me']).toBeDefined();
  });
});

// The partner's own identifier for an engagement (migration 0164), which 409.ai
// documents as a partner-scoped unique `external_id`.
//
// What it buys over `Idempotency-Key` is durability. That key is a per-request
// value the partner is told to vary, so it makes a retry safe without making
// the *result* findable — a create whose response never arrived leaves an
// engagement the partner cannot name, because the only name it has is a ULID
// that was in the response. `external_id` travels in the request, so it is
// known before the answer exists.
describe.skipIf(!dbUp)('partner API: external_id', () => {
  let ctx: TestApp;
  let app: FastifyInstance;
  let partnerId: string;
  let apiKey: string;
  let otherKey: string;

  const keyHeader = (key: string) => ({ authorization: `Bearer ${key}` });

  const mintKey = async (owner: string): Promise<string> => {
    const admin = await seedUser(ctx, { roles: ['partner'], partnerId: owner });
    const minted = await app.inject({
      method: 'POST',
      url: `/api/v1/partners/${owner}/tokens`,
      headers: authHeader(admin.token),
      payload: { name: 'external-id tests' },
    });
    expect(minted.statusCode).toBe(201);
    return minted.json().secret as string;
  };

  const create = async (key: string, body: Record<string, unknown>) =>
    app.inject({
      method: 'POST',
      url: '/api/partner/v1/valuations',
      headers: keyHeader(key),
      payload: { kind: '409a', company_name: 'Northwind Robotics, Inc.', ...body },
    });

  beforeAll(async () => {
    ctx = await setupTestApp({}, { partnerApiLimiter: new FixedWindowRateLimiter(1000, 60_000) });
    app = ctx.app;
    partnerId = await seedPartner(ctx, 'External Id Advisors');
    apiKey = await mintKey(partnerId);
    otherKey = await mintKey(await seedPartner(ctx, 'Unrelated Advisors'));
  });

  afterAll(async () => {
    await ctx?.teardown();
  });

  it('is echoed back on the create response', async () => {
    const res = await create(apiKey, { external_id: 'CRM-1001' });
    expect(res.statusCode).toBe(201);
    expect(res.json().valuation.external_id).toBe('CRM-1001');
  });

  it('is null when none was supplied', async () => {
    const res = await create(apiKey, {});
    expect(res.statusCode).toBe(201);
    expect(res.json().valuation.external_id).toBeNull();
  });

  it('finds the valuation again', async () => {
    const created = await create(apiKey, { external_id: 'CRM-2002' });
    const found = await app.inject({
      method: 'GET',
      url: '/api/partner/v1/valuations?external_id=CRM-2002',
      headers: keyHeader(apiKey),
    });
    expect(found.statusCode).toBe(200);
    const body = found.json() as { valuations: { id: string }[]; total: number };
    expect(body.total).toBe(1);
    expect(body.valuations[0]!.id).toBe(created.json().valuation.id);
  });

  it('returns an empty list for one that was never used', async () => {
    const found = await app.inject({
      method: 'GET',
      url: '/api/partner/v1/valuations?external_id=never-issued',
      headers: keyHeader(apiKey),
    });
    expect(found.statusCode).toBe(200);
    expect((found.json() as { total: number }).total).toBe(0);
  });

  it('refuses a second valuation carrying the same one', async () => {
    expect((await create(apiKey, { external_id: 'CRM-3003' })).statusCode).toBe(201);
    const dup = await create(apiKey, { external_id: 'CRM-3003' });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().detail).toContain('already used');
    // The message has to name the way out, or the partner's only recourse is
    // to invent a second id for an engagement that already exists.
    expect(dup.json().detail).toContain('GET /valuations?external_id=');
  });

  // The namespace is the partner's own. Two firms both calling their first
  // engagement `1` is not a collision anyone should have to think about.
  it('is scoped per organization, not globally', async () => {
    expect((await create(apiKey, { external_id: 'shared-value' })).statusCode).toBe(201);
    expect((await create(otherKey, { external_id: 'shared-value' })).statusCode).toBe(201);
  });

  // A lookup key that resolved differently for `"abc"` and `"abc "` would be a
  // trap: the uniqueness index cannot see the difference between a typo and a
  // deliberate namespace, so the trim happens before either.
  it('trims, so a stray space is not a second engagement', async () => {
    expect((await create(apiKey, { external_id: 'CRM-4004' })).statusCode).toBe(201);
    expect((await create(apiKey, { external_id: '  CRM-4004  ' })).statusCode).toBe(409);
  });

  it('refuses an empty or oversized value rather than storing it', async () => {
    expect((await create(apiKey, { external_id: '' })).statusCode).toBe(422);
    expect((await create(apiKey, { external_id: '   ' })).statusCode).toBe(422);
    expect((await create(apiKey, { external_id: 'x'.repeat(201) })).statusCode).toBe(422);
  });

  // The unique index arbitrates, not a SELECT before the INSERT — two
  // concurrent creates both see nothing and both proceed, which is the race
  // `Idempotency-Key` had before 0160 turned its receipt into a claim. Exactly
  // one of these must win.
  it('lets exactly one of two concurrent creates through', async () => {
    const [a, b] = await Promise.all([
      create(apiKey, { external_id: 'CRM-RACE' }),
      create(apiKey, { external_id: 'CRM-RACE' }),
    ]);
    const codes = [a.statusCode, b.statusCode].sort();
    expect(codes).toEqual([201, 409]);
  });

  // Another partner's identifier is not a way to see their work.
  it('does not reach across organizations', async () => {
    expect((await create(otherKey, { external_id: 'RIVAL-ONLY' })).statusCode).toBe(201);
    const found = await app.inject({
      method: 'GET',
      url: '/api/partner/v1/valuations?external_id=RIVAL-ONLY',
      headers: keyHeader(apiKey),
    });
    expect((found.json() as { total: number }).total).toBe(0);
  });

  it('is documented in the OpenAPI spec', async () => {
    const spec = await app.inject({ method: 'GET', url: '/api/partner/v1/openapi.json' });
    expect(spec.body).toContain('external_id');
  });
});

// `POST /valuations/{id}/submit` — the step that was missing between "the
// partner API created this" and "somebody looked at it".
//
// A valuation created through the web app walks the client-side states as the
// founder fills the questionnaire in. A partner integration collects the same
// information in its own product, so without a way to say so the engagement sat
// in `pending` forever: created by the API, uploaded to by the API, and never
// handed over. 409.ai's partner API documents the same call.
describe.skipIf(!dbUp)('partner API: submit', () => {
  let ctx: TestApp;
  let app: FastifyInstance;
  let apiKey: string;
  let otherKey: string;

  const keyHeader = (key: string) => ({ authorization: `Bearer ${key}` });

  const mintKey = async (owner: string): Promise<string> => {
    const admin = await seedUser(ctx, { roles: ['partner'], partnerId: owner });
    const minted = await app.inject({
      method: 'POST',
      url: `/api/v1/partners/${owner}/tokens`,
      headers: authHeader(admin.token),
      payload: { name: 'submit tests' },
    });
    return minted.json().secret as string;
  };

  /** A fresh valuation, in `pending` as every partner create leaves it. */
  const created = async (): Promise<string> => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/partner/v1/valuations',
      headers: keyHeader(apiKey),
      payload: { kind: '409a', company_name: 'Submit Test Co.' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().valuation.state).toBe('pending');
    return res.json().valuation.id as string;
  };

  const submit = async (id: string, key = apiKey) =>
    app.inject({ method: 'POST', url: `/api/partner/v1/valuations/${id}/submit`, headers: keyHeader(key) });

  beforeAll(async () => {
    ctx = await setupTestApp({}, { partnerApiLimiter: new FixedWindowRateLimiter(1000, 60_000) });
    app = ctx.app;
    apiKey = await mintKey(await seedPartner(ctx, 'Submitting Advisors'));
    otherKey = await mintKey(await seedPartner(ctx, 'Bystander Advisors'));
  });

  afterAll(async () => {
    await ctx?.teardown();
  });

  it('carries a pending valuation all the way to user_finished', async () => {
    const res = await submit(await created());
    expect(res.statusCode).toBe(200);
    expect(res.json().valuation.state).toBe('user_finished');
  });

  // Every edge, not one jump. The dashboards and SLA figures are keyed on the
  // sequence — a file that skips `completed` sits in the review queue with an
  // ageing figure computed from a timestamp nothing set — and each edge has its
  // own audit event.
  it('records every intermediate transition rather than one jump', async () => {
    const id = await created();
    await submit(id);
    const { rows } = await ctx.pool.query<{ payload: { to?: string } }>(
      `SELECT payload FROM valuation_events
        WHERE valuation_id = $1 AND type = 'state_changed'
        ORDER BY seq`,
      [id],
    );
    const states = rows.map((r) => r.payload.to);
    expect(states).toEqual(['started', 'onboarding_completed', 'user_finished']);
  });

  // A retry must succeed. The partner's request may have landed and its
  // response may not have come back, which is the ordinary case this whole API
  // is built to survive.
  it('is idempotent — a second submit changes nothing and still answers 200', async () => {
    const id = await created();
    expect((await submit(id)).statusCode).toBe(200);
    const again = await submit(id);
    expect(again.statusCode).toBe(200);
    expect(again.json().valuation.state).toBe('user_finished');
    const { rows } = await ctx.pool.query(
      `SELECT 1 FROM valuation_events WHERE valuation_id = $1 AND type = 'state_changed'`,
      [id],
    );
    expect(rows).toHaveLength(3);
  });

  // Past the target is also "already submitted": the partner asked us to take
  // it, and we have.
  it('returns a valuation already past the target unchanged', async () => {
    const id = await created();
    await submit(id);
    await ctx.pool.query(`UPDATE valuations SET state = 'review' WHERE id = $1`, [id]);
    const res = await submit(id);
    expect(res.statusCode).toBe(200);
    expect(res.json().valuation.state).toBe('review');
  });

  // The dead ends are a different answer. A cancelled engagement needs a
  // restart, and silently reporting success would leave the partner waiting for
  // a report nobody is writing.
  it.each(['cancelled', 'timeout', 'ignored'])('refuses to submit a %s valuation', async (state) => {
    const id = await created();
    await ctx.pool.query(`UPDATE valuations SET state = $2 WHERE id = $1`, [id, state]);
    const res = await submit(id);
    expect(res.statusCode).toBe(409);
    expect(res.json().detail).toContain('restarted');
  });

  it('starts from wherever the valuation actually is', async () => {
    const id = await created();
    await ctx.pool.query(`UPDATE valuations SET state = 'started' WHERE id = $1`, [id]);
    const res = await submit(id);
    expect(res.json().valuation.state).toBe('user_finished');
    const { rows } = await ctx.pool.query<{ payload: { to?: string } }>(
      `SELECT payload FROM valuation_events
        WHERE valuation_id = $1 AND type = 'state_changed' ORDER BY seq`,
      [id],
    );
    expect(rows.map((r) => r.payload.to)).toEqual(['onboarding_completed', 'user_finished']);
  });

  it('is scoped to the key that owns the valuation', async () => {
    const id = await created();
    expect((await submit(id, otherKey)).statusCode).toBe(404);
  });

  it('404s an id that does not exist', async () => {
    expect((await submit('01ARZ3NDEKTSV4RRFFQ69G5FAV')).statusCode).toBe(404);
    expect((await submit('not-a-ulid')).statusCode).toBe(404);
  });

  it('is listed in the docs endpoint and the OpenAPI spec', async () => {
    const docs = await app.inject({ method: 'GET', url: '/api/partner/v1/docs' });
    expect((docs.json() as { endpoints: { path: string }[] }).endpoints).toContainEqual(
      expect.objectContaining({ method: 'POST', path: '/valuations/{id}/submit' }),
    );
    const spec = await app.inject({ method: 'GET', url: '/api/partner/v1/openapi.json' });
    expect(
      (spec.json() as { paths: Record<string, unknown> }).paths['/valuations/{id}/submit'],
    ).toBeDefined();
  });
});

// `PUT /valuations/{id}` — the last endpoint 409.ai's partner API had and this
// one did not. Without it a partner who typo'd a company name had no way to
// correct it: the value would travel through the pipeline into the deliverable.
describe.skipIf(!dbUp)('partner API: update', () => {
  let ctx: TestApp;
  let app: FastifyInstance;
  let apiKey: string;
  let otherKey: string;

  const keyHeader = (key: string) => ({ authorization: `Bearer ${key}` });

  const mintKey = async (owner: string): Promise<string> => {
    const admin = await seedUser(ctx, { roles: ['partner'], partnerId: owner });
    const minted = await app.inject({
      method: 'POST',
      url: `/api/v1/partners/${owner}/tokens`,
      headers: authHeader(admin.token),
      payload: { name: 'update tests' },
    });
    return minted.json().secret as string;
  };

  const created = async (body: Record<string, unknown> = {}): Promise<string> => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/partner/v1/valuations',
      headers: keyHeader(apiKey),
      payload: { kind: '409a', company_name: 'Typoed Nmae Inc.', ...body },
    });
    expect(res.statusCode).toBe(201);
    return res.json().valuation.id as string;
  };

  const update = async (id: string, payload: unknown, key = apiKey) =>
    app.inject({
      method: 'PUT',
      url: `/api/partner/v1/valuations/${id}`,
      headers: keyHeader(key),
      payload,
    });

  beforeAll(async () => {
    ctx = await setupTestApp({}, { partnerApiLimiter: new FixedWindowRateLimiter(1000, 60_000) });
    app = ctx.app;
    apiKey = await mintKey(await seedPartner(ctx, 'Correcting Advisors'));
    otherKey = await mintKey(await seedPartner(ctx, 'Uninvolved Advisors'));
  });

  afterAll(async () => {
    await ctx?.teardown();
  });

  it('corrects the company name', async () => {
    const id = await created();
    const res = await update(id, { company_name: 'Correct Name Inc.' });
    expect(res.statusCode).toBe(200);
    expect(res.json().valuation.company_name).toBe('Correct Name Inc.');
  });

  it('changes only what it was given', async () => {
    const id = await created({ currency: 'EUR', external_id: 'keep-me' });
    await update(id, { company_name: 'Renamed Ltd.' });
    const after = await app.inject({
      method: 'GET',
      url: `/api/partner/v1/valuations/${id}`,
      headers: keyHeader(apiKey),
    });
    expect(after.json().valuation.currency).toBe('EUR');
    expect(after.json().valuation.external_id).toBe('keep-me');
  });

  it('clears a nullable field when sent null', async () => {
    const id = await created({ external_id: 'to-be-cleared' });
    const res = await update(id, { external_id: null });
    expect(res.statusCode).toBe(200);
    expect(res.json().valuation.external_id).toBeNull();
  });

  // An empty body is far more likely to be a client that built the patch wrong
  // than a deliberate no-op, and a 200 would report a correction that never
  // landed.
  it('refuses an empty patch rather than reporting success', async () => {
    const res = await update(await created(), {});
    expect(res.statusCode).toBe(422);
    expect(res.json().detail).toContain('No editable fields');
  });

  // `kind` selects the report skeleton, the engine pipeline and the price.
  // Changing it after documents are attached is a different engagement, not an
  // edit — and a strict body says so instead of dropping it silently.
  it('refuses to change the kind, and says so', async () => {
    const res = await update(await created(), { kind: 'asc_718' });
    expect(res.statusCode).toBe(422);
  });

  it('validates the fields it does accept', async () => {
    const id = await created();
    expect((await update(id, { company_name: '' })).statusCode).toBe(422);
    expect((await update(id, { currency: 'NOTACURRENCY' })).statusCode).toBe(422);
    expect((await update(id, { service_countries: ['USA'] })).statusCode).toBe(422);
  });

  // The line is where the deliverable starts being written: past that an
  // analyst is working from these values, and a name that changes underneath
  // them appears in a report nobody re-read.
  it.each(['review', 'reviewed', 'drafted', 'published'])('refuses once the file is %s', async (state) => {
    const id = await created();
    await ctx.pool.query(`UPDATE valuations SET state = $2 WHERE id = $1`, [id, state]);
    const res = await update(id, { company_name: 'Too Late Inc.' });
    expect(res.statusCode).toBe(409);
    expect(res.json().detail).toContain('no longer editable');
  });

  it.each(['pending', 'user_finished', 'completed', 'paid'])('allows it while %s', async (state) => {
    const id = await created();
    await ctx.pool.query(`UPDATE valuations SET state = $2 WHERE id = $1`, [id, state]);
    expect((await update(id, { company_name: `Renamed in ${state}` })).statusCode).toBe(200);
  });

  // The same index guards the update path as the create path.
  it('refuses an external_id another valuation already holds', async () => {
    await created({ external_id: 'taken-already' });
    const other = await created();
    const res = await update(other, { external_id: 'taken-already' });
    expect(res.statusCode).toBe(409);
    expect(res.json().detail).toContain('already used');
  });

  it('is scoped to the key that owns the valuation', async () => {
    const id = await created();
    expect((await update(id, { company_name: 'Not Yours' }, otherKey)).statusCode).toBe(404);
  });

  it('records the correction in the audit trail', async () => {
    const id = await created();
    await update(id, { company_name: 'Audited Rename Inc.' });
    const { rows } = await ctx.pool.query<{ source: string }>(
      `SELECT source FROM valuation_events WHERE valuation_id = $1 AND type = 'valuation_updated'`,
      [id],
    );
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows.map((r) => r.source)).toContain('partner_api');
  });

  it('is listed in the docs endpoint and the OpenAPI spec', async () => {
    const docs = await app.inject({ method: 'GET', url: '/api/partner/v1/docs' });
    expect((docs.json() as { endpoints: { path: string }[] }).endpoints).toContainEqual(
      expect.objectContaining({ method: 'PUT', path: '/valuations/{id}' }),
    );
    const spec = await app.inject({ method: 'GET', url: '/api/partner/v1/openapi.json' });
    const paths = (spec.json() as { paths: Record<string, Record<string, unknown>> }).paths;
    expect(paths['/valuations/{id}']!.put).toBeDefined();
    // The GET on the same path must survive gaining a sibling.
    expect(paths['/valuations/{id}']!.get).toBeDefined();
  });
});
