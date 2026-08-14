import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authHeader, isDbAvailable, seedPartner, seedUser, setupTestApp, type TestApp } from './helpers.js';

const dbUp = await isDbAvailable();

/**
 * Which firm a client-intake request is about, and what happens when the answer
 * is nobody.
 *
 * `clientIntake.test.ts` covers the questionnaire itself thoroughly — saving,
 * validating, submitting, converting — from one firm's point of view. What it
 * does not cover is `resolveFirm`, the four-armed rule deciding whose pipeline
 * a caller is allowed to touch, and that is where `routes/clientIntake.ts`'s
 * missing branches were.
 *
 * The rule matters because the thing being scoped is a list of a firm's
 * prospects. Getting it wrong does not corrupt anything — it shows one firm who
 * the other firm is pitching.
 */
describe.skipIf(!dbUp)('client intake — firm scope and portal refusals', () => {
  let ctx: TestApp;
  let firmId: string;
  let rivalId: string;
  let firmAdmin: { id: string; token: string };
  let opsInFirm: { id: string; token: string };
  let opsNoFirm: { id: string; token: string };
  let outsider: { id: string; token: string };

  beforeAll(async () => {
    ctx = await setupTestApp();
    firmId = await seedPartner(ctx, 'Scope Valuation');
    rivalId = await seedPartner(ctx, 'Scope Rival');
    firmAdmin = await seedUser(ctx, { roles: ['partner'], partnerId: firmId });
    opsInFirm = await seedUser(ctx, { roles: ['reviewer'], partnerId: firmId });
    opsNoFirm = await seedUser(ctx, { roles: ['reviewer'] });
    outsider = await seedUser(ctx, { roles: ['valuation_user'] });
  });
  afterAll(async () => ctx?.teardown());

  const create = (token: string, payload: object = {}, query = '') =>
    ctx.app.inject({
      method: 'POST',
      url: `/api/v1/firm/intake-links${query}`,
      headers: authHeader(token),
      payload,
    });

  const list = (token: string, query = '') =>
    ctx.app.inject({ method: 'GET', url: `/api/v1/firm/intake-links${query}`, headers: authHeader(token) });

  async function mintToken(): Promise<{ id: string; token: string }> {
    const res = await create(firmAdmin.token, { client_name: 'Prospect Co' });
    expect(res.statusCode, res.body).toBe(201);
    const body = res.json();
    return { id: body.link.id as string, token: body.token as string };
  }

  // ── resolveFirm ───────────────────────────────────────────────────────────
  describe('whose pipeline this is', () => {
    it('400s an ops caller who names no firm and belongs to none', async () => {
      // Ops can act for any firm, which is exactly why they must name one.
      // Defaulting to "all firms" would be a cross-firm prospect list.
      const res = await create(opsNoFirm.token, { client_name: 'X' });
      expect(res.statusCode).toBe(400);
      expect(res.json().detail).toMatch(/partner_id is required/);
    });

    it('lets an ops caller act for a firm they name', async () => {
      const res = await create(opsNoFirm.token, { client_name: 'Named Firm Co' }, `?partner_id=${rivalId}`);
      expect(res.statusCode).toBe(201);
      // And the link lands in that firm's list, not anyone else's.
      const rivalList = await list(opsNoFirm.token, `?partner_id=${rivalId}`);
      expect(rivalList.json().links.map((l: { client_name: string }) => l.client_name)).toContain(
        'Named Firm Co',
      );
    });

    it('falls back to an ops caller’s own firm when they name none', async () => {
      const res = await create(opsInFirm.token, { client_name: 'Own Firm Co' });
      expect(res.statusCode).toBe(201);
      const own = await list(firmAdmin.token);
      expect(own.json().links.map((l: { client_name: string }) => l.client_name)).toContain('Own Firm Co');
    });

    it('403s a firm member reaching for another firm, and allows naming their own', async () => {
      const other = await create(firmAdmin.token, { client_name: 'X' }, `?partner_id=${rivalId}`);
      expect(other.statusCode).toBe(403);
      expect(other.json().detail).toMatch(/your own firm/i);

      // Naming your own is redundant but not an error — the console sends it.
      const own = await create(firmAdmin.token, { client_name: 'Explicit Co' }, `?partner_id=${firmId}`);
      expect(own.statusCode).toBe(201);
    });

    it('403s an account that belongs to no firm at all', async () => {
      const res = await create(outsider.token, { client_name: 'X' });
      expect(res.statusCode).toBe(403);
      expect(res.json().detail).toMatch(/firm accounts/i);
    });

    it('applies the same rule to every firm-side route, not just create', async () => {
      const { id } = await mintToken();
      const routes: [string, string][] = [
        ['GET', '/api/v1/firm/intake-links'],
        ['GET', `/api/v1/firm/intake-links/${id}`],
        ['POST', `/api/v1/firm/intake-links/${id}/convert`],
        ['DELETE', `/api/v1/firm/intake-links/${id}`],
      ];
      for (const [method, url] of routes) {
        const outsiderRes = await ctx.app.inject({
          method: method as 'GET',
          url,
          headers: authHeader(outsider.token),
          payload: method === 'GET' ? undefined : {},
        });
        expect(outsiderRes.statusCode, `outsider ${method} ${url}`).toBe(403);

        const rivalRes = await ctx.app.inject({
          method: method as 'GET',
          url: `${url}?partner_id=${rivalId}`,
          headers: authHeader(firmAdmin.token),
          payload: method === 'GET' ? undefined : {},
        });
        expect(rivalRes.statusCode, `cross-firm ${method} ${url}`).toBe(403);
      }
    });

    it('400s a partner_id that is not a single value', async () => {
      // Fastify parses a repeated query key as an array, which the schema
      // rejects — worth pinning, because an array reaching `resolveFirm` would
      // compare by reference and never match the caller's own firm.
      const res = await list(firmAdmin.token, `?partner_id=${firmId}&partner_id=${rivalId}`);
      expect(res.statusCode).toBe(400);
    });
  });

  // ── Firm-side bodies and ids ──────────────────────────────────────────────
  describe('firm-side requests', () => {
    it('422s a create it cannot parse', async () => {
      // `client_name` is optional and has no minimum, so '' is accepted — the
      // firm may mint a link before it knows who it is for. The cases below are
      // the ones the schema genuinely refuses.
      for (const payload of [
        { client_name: 'X', client_email: 'not-an-email' },
        { client_name: 'X', expires_in_days: 0 },
        { client_name: 'X', expires_in_days: 100_000 },
        { client_name: 'X', expires_in_days: 2.5 },
      ]) {
        const res = await create(firmAdmin.token, payload);
        expect(res.statusCode, JSON.stringify(payload)).toBe(422);
      }
    });

    it('422s a convert whose stated kind or currency is not one', async () => {
      const { id } = await mintToken();
      for (const payload of [{ kind: 'astrology' }, { currency: 'DOLLARS' }, { company_name: '' }]) {
        const res = await ctx.app.inject({
          method: 'POST',
          url: `/api/v1/firm/intake-links/${id}/convert`,
          headers: authHeader(firmAdmin.token),
          payload,
        });
        expect(res.statusCode, JSON.stringify(payload)).toBe(422);
      }
    });

    it('404s a link id this firm does not hold, on read, convert and revoke', async () => {
      const ULID_ABSENT = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
      for (const id of ['not-a-ulid', ULID_ABSENT]) {
        const read = await ctx.app.inject({
          method: 'GET',
          url: `/api/v1/firm/intake-links/${id}`,
          headers: authHeader(firmAdmin.token),
        });
        expect(read.statusCode, `read ${id}`).toBe(404);

        const convert = await ctx.app.inject({
          method: 'POST',
          url: `/api/v1/firm/intake-links/${id}/convert`,
          headers: authHeader(firmAdmin.token),
          payload: {},
        });
        expect(convert.statusCode, `convert ${id}`).toBe(404);

        const revoke = await ctx.app.inject({
          method: 'DELETE',
          url: `/api/v1/firm/intake-links/${id}`,
          headers: authHeader(firmAdmin.token),
        });
        expect(revoke.statusCode, `revoke ${id}`).toBe(404);
      }
    });

    it('204s a revoke once and 404s the second time', async () => {
      const { id } = await mintToken();
      const first = await ctx.app.inject({
        method: 'DELETE',
        url: `/api/v1/firm/intake-links/${id}`,
        headers: authHeader(firmAdmin.token),
      });
      expect(first.statusCode).toBe(204);
      const second = await ctx.app.inject({
        method: 'DELETE',
        url: `/api/v1/firm/intake-links/${id}`,
        headers: authHeader(firmAdmin.token),
      });
      expect(second.statusCode).toBe(404);
    });
  });

  // ── Portal ────────────────────────────────────────────────────────────────
  describe('the client portal', () => {
    const portal = (payload: unknown) =>
      ctx.app.inject({ method: 'POST', url: '/api/v1/intake/portal', payload });
    const answers = (payload: unknown) =>
      ctx.app.inject({ method: 'POST', url: '/api/v1/intake/portal/answers', payload });
    const submit = (payload: unknown) =>
      ctx.app.inject({ method: 'POST', url: '/api/v1/intake/portal/submit', payload });

    it('422s a request carrying no usable token field', async () => {
      // Shape first, then authentication — a body with no `token` at all is a
      // malformed request, not a failed guess.
      for (const payload of [{}, { token: '' }, { token: 123 }]) {
        expect((await portal(payload)).statusCode, `portal ${JSON.stringify(payload)}`).toBe(422);
        expect((await submit(payload)).statusCode, `submit ${JSON.stringify(payload)}`).toBe(422);
      }
      // Save additionally requires an answers object.
      expect((await answers({ token: 'x' })).statusCode).toBe(422);
      expect((await answers({ token: 'x', answers: 'not-an-object' })).statusCode).toBe(422);
    });

    it('401s a token that was never issued, identically on all three routes', async () => {
      // One response for "never existed", "expired" and "already submitted"
      // alike: this endpoint authenticates on the token alone, and a different
      // status for each would tell a guesser which guess was close.
      const bogus = { token: 'definitely-not-a-real-token' };
      expect((await portal(bogus)).statusCode).toBe(401);
      expect((await submit(bogus)).statusCode).toBe(401);
      expect((await answers({ ...bogus, answers: {} })).statusCode).toBe(401);
    });

    it('answers a live token without leaking the firm id or its other clients', async () => {
      const { token } = await mintToken();
      const res = await portal({ token });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.client_name).toBe('Prospect Co');
      expect(body.can_edit).toBe(true);
      expect(body.sections.length).toBeGreaterThan(0);
      // The prospect sees a brand, never an id.
      expect(JSON.stringify(body.firm)).not.toContain(firmId);
      expect(body).not.toHaveProperty('partner_id');
    });

    it('422s a submit that is short of required answers, and says how short', async () => {
      const { token } = await mintToken();
      const res = await submit({ token });
      expect(res.statusCode).toBe(422);
      expect(res.json().detail).toMatch(/Complete all required fields/);
      // The completion payload is the point — "incomplete" alone gives the
      // client nothing to act on.
      const completion = res.json().completion;
      expect(completion.ready).toBe(false);
      // Section-by-section, so the form can point at the sections still short
      // rather than saying only that something is missing.
      expect(completion.requiredTotal).toBeGreaterThan(0);
      expect(completion.requiredAnswered).toBeLessThan(completion.requiredTotal);
      expect(completion.sections.some((s: { complete: boolean }) => !s.complete)).toBe(true);
    });

    it('401s the portal for a link the firm has withdrawn', async () => {
      const { id, token } = await mintToken();
      expect((await portal({ token })).statusCode).toBe(200);
      await ctx.app.inject({
        method: 'DELETE',
        url: `/api/v1/firm/intake-links/${id}`,
        headers: authHeader(firmAdmin.token),
      });
      expect((await portal({ token })).statusCode).toBe(401);
      expect((await answers({ token, answers: {} })).statusCode).toBe(401);
      expect((await submit({ token })).statusCode).toBe(401);
    });
  });
});
