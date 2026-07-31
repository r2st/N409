import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  authHeader,
  isDbAvailable,
  seedPartner,
  seedUser,
  setupTestApp,
  stubReadinessFetch,
  type TestApp,
} from './helpers.js';

const dbUp = await isDbAvailable();

describe.skipIf(!dbUp)('valuation API (M0 exit criteria)', () => {
  let ctx: TestApp;
  let client: Awaited<ReturnType<typeof seedUser>>;
  let otherClient: Awaited<ReturnType<typeof seedUser>>;
  let ops: Awaited<ReturnType<typeof seedUser>>;
  let partnerUser: Awaited<ReturnType<typeof seedUser>>;
  let partnerId: string;

  beforeAll(async () => {
    ctx = await setupTestApp();
    partnerId = await seedPartner(ctx, 'Vestd');
    client = await seedUser(ctx, { roles: ['valuation_user'] });
    otherClient = await seedUser(ctx, { roles: ['valuation_user'] });
    ops = await seedUser(ctx, { roles: ['admin'] });
    partnerUser = await seedUser(ctx, { roles: ['partner'], partnerId });
  });
  afterAll(async () => ctx?.teardown());

  describe('auth surface (issue #3)', () => {
    it('registers a new user and returns a working token', async () => {
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/auth/register',
        payload: { email: 'founder@newco.com', password: 'a-long-password1', first_name: 'Fo' },
      });
      expect(res.statusCode).toBe(201);
      const { token, user } = res.json();
      expect(user.roles).toEqual(['valuation_user']);
      expect(user.password_digest).toBeUndefined();

      const me = await ctx.app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: authHeader(token) });
      expect(me.statusCode).toBe(200);
      expect(me.json().user.email).toBe('founder@newco.com');
    });

    it('rejects duplicate registration with 409', async () => {
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/auth/register',
        payload: { email: 'FOUNDER@newco.com', password: 'a-long-password1' },
      });
      expect(res.statusCode).toBe(409);
    });

    it('rejects wrong password and unknown email identically', async () => {
      const bad = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { email: client.email, password: 'wrong' },
      });
      const unknown = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { email: 'nobody@nowhere.io', password: 'wrong' },
      });
      expect(bad.statusCode).toBe(401);
      expect(unknown.statusCode).toBe(401);
      expect(bad.json().detail).toBe(unknown.json().detail);
    });

    it('requires auth on the valuation surface', async () => {
      const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/valuations' });
      expect(res.statusCode).toBe(401);
      expect(res.headers['content-type']).toContain('application/problem+json');
    });
  });

  describe('create valuation → audit event (exit criterion)', () => {
    let valuationId: string;

    it('creates a valuation via the API', async () => {
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/valuations',
        headers: authHeader(client.token),
        payload: { kind: '409a', company_name: 'Acme Robotics', service_countries: ['US'] },
      });
      expect(res.statusCode).toBe(201);
      const { valuation } = res.json();
      valuationId = valuation.id;
      expect(valuation.state).toBe('pending');
      expect(valuation.user_id).toBe(client.id);
      expect(Number(valuation.number)).toBeGreaterThanOrEqual(1);
    });

    it('wrote the valuation_created event atomically', async () => {
      const res = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/valuations/${valuationId}/events`,
        headers: authHeader(client.token),
      });
      expect(res.statusCode).toBe(200);
      const { events } = res.json();
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: 'valuation_created',
        actor_type: 'human',
        actor_id: client.id,
        source: 'api',
      });
      expect(events[0].payload.company_name).toBe('Acme Robotics');
    });

    it('created the 1:1 params row', async () => {
      const { rows } = await ctx.pool.query('SELECT * FROM valuation_params WHERE valuation_id = $1', [
        valuationId,
      ]);
      expect(rows).toHaveLength(1);
    });

    it('every ops change writes further events (exit criterion)', async () => {
      const res = await ctx.app.inject({
        method: 'PATCH',
        url: `/api/v1/valuations/${valuationId}`,
        headers: authHeader(ops.token),
        payload: { state: 'started', assigned_reviewer_id: ops.id },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().valuation.state).toBe('started');
      expect(res.json().valuation.started_at).not.toBeNull();

      const events = (
        await ctx.app.inject({
          method: 'GET',
          url: `/api/v1/valuations/${valuationId}/events`,
          headers: authHeader(ops.token),
        })
      ).json().events;
      const types = events.map((e: { type: string }) => e.type);
      expect(types).toEqual(['valuation_created', 'valuation_updated', 'state_changed']);
      const stateChange = events.find((e: { type: string }) => e.type === 'state_changed');
      expect(stateChange.payload).toMatchObject({ from: 'pending', to: 'started' });
    });

    it('client owner may rename but NOT transition state', async () => {
      const rename = await ctx.app.inject({
        method: 'PATCH',
        url: `/api/v1/valuations/${valuationId}`,
        headers: authHeader(client.token),
        payload: { company_name: 'Acme Robotics Inc' },
      });
      expect(rename.statusCode).toBe(200);

      const transition = await ctx.app.inject({
        method: 'PATCH',
        url: `/api/v1/valuations/${valuationId}`,
        headers: authHeader(client.token),
        payload: { state: 'published' },
      });
      expect(transition.statusCode).toBe(403);
    });

    it('rejects unknown patch fields', async () => {
      const res = await ctx.app.inject({
        method: 'PATCH',
        url: `/api/v1/valuations/${valuationId}`,
        headers: authHeader(ops.token),
        payload: { engine_version: 'sneaky' },
      });
      expect(res.statusCode).toBe(422);
    });

    it('another client cannot see or patch it (404, no existence leak)', async () => {
      const get = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/valuations/${valuationId}`,
        headers: authHeader(otherClient.token),
      });
      expect(get.statusCode).toBe(404);
      const patch = await ctx.app.inject({
        method: 'PATCH',
        url: `/api/v1/valuations/${valuationId}`,
        headers: authHeader(otherClient.token),
        payload: { company_name: 'hijack' },
      });
      expect(patch.statusCode).toBe(404);
    });
  });

  describe('partner scoping (issue #3)', () => {
    let partnerValuationId: string;

    it('partner-created valuations land in their partner scope', async () => {
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/valuations',
        headers: authHeader(partnerUser.token),
        payload: { kind: 'emi', company_name: 'UK Startup Ltd' },
      });
      expect(res.statusCode).toBe(201);
      partnerValuationId = res.json().valuation.id;
      expect(res.json().valuation.partner_id).toBe(partnerId);
      expect(res.json().valuation.source).toBe('partner');
    });

    it('partner list is scoped; ops list sees everything', async () => {
      const partnerList = await ctx.app.inject({
        method: 'GET',
        url: '/api/v1/valuations',
        headers: authHeader(partnerUser.token),
      });
      const ids = partnerList.json().valuations.map((v: { id: string }) => v.id);
      expect(ids).toEqual([partnerValuationId]);

      const opsList = await ctx.app.inject({
        method: 'GET',
        url: '/api/v1/valuations',
        headers: authHeader(ops.token),
      });
      expect(opsList.json().total).toBeGreaterThanOrEqual(2);
    });

    it('clients cannot read partner valuations and vice versa', async () => {
      const res = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/valuations/${partnerValuationId}`,
        headers: authHeader(client.token),
      });
      expect(res.statusCode).toBe(404);
    });

    it('list filters work (state, kind)', async () => {
      const res = await ctx.app.inject({
        method: 'GET',
        url: '/api/v1/valuations?kind=emi',
        headers: authHeader(ops.token),
      });
      expect(res.json().valuations.every((v: { kind: string }) => v.kind === 'emi')).toBe(true);
    });
  });

  describe('observability (issue #4)', () => {
    it('liveness and readiness (postgres + AI + engine) respond', async () => {
      const health = await ctx.app.inject({ method: 'GET', url: '/health' });
      expect(health.statusCode).toBe(200);
      expect(health.json().service).toBe('valuation');

      const ready = await ctx.app.inject({ method: 'GET', url: '/ready' });
      expect(ready.statusCode).toBe(200);
      expect(ready.json().checks).toMatchObject({ postgres: 'ok', ai: 'ok', engine: 'ok' });
    });

    it('is not ready when a downstream service is not ready', async () => {
      // A valuation cannot be calculated without the engine and no pipeline runs
      // without the AI service, so `SELECT 1` alone reported ready while every
      // calculation route was 502-ing.
      const down = await setupTestApp({}, { readinessFetch: stubReadinessFetch(503) });
      try {
        const ready = await down.app.inject({ method: 'GET', url: '/ready' });
        expect(ready.statusCode).toBe(503);
        expect(ready.json().status).toBe('unavailable');
        expect(ready.json().checks.postgres).toBe('ok');
        expect(ready.json().checks.ai).toContain('not ready');
        expect(ready.json().checks.engine).toContain('not ready');
      } finally {
        await down.teardown();
      }
    });

    it('is not ready when a downstream service is unreachable', async () => {
      const unreachable = (async () => {
        throw new Error('connect ECONNREFUSED');
      }) as typeof fetch;
      const down = await setupTestApp({}, { readinessFetch: unreachable });
      try {
        const ready = await down.app.inject({ method: 'GET', url: '/ready' });
        expect(ready.statusCode).toBe(503);
        expect(ready.json().checks.ai).toContain('unreachable');
      } finally {
        await down.teardown();
      }
    });
  });
});

if (!dbUp) {
  console.warn('[api.test] Postgres not reachable — integration tests skipped. Run: npm run dev:db');
}
