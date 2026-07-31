/**
 * Per-user / per-org throttling across the whole authenticated API surface
 * (improvement 5), layered on top of the existing per-endpoint auth/partner
 * limiters. Wired through registerAuth's `sessionLimiter`/`sessionOrgLimiter`
 * deps so every route behind `app.authenticate` is covered without per-route
 * wiring — see plugins/auth.ts.
 *
 * The limiters default to off outside production (see app.ts) so this suite
 * injects its own, mirroring publicRateLimits.test.ts.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { isDbAvailable, seedPartner, seedUser, setupTestApp, authHeader } from './helpers.js';
import { FixedWindowRateLimiter } from '../../src/plugins/rateLimit.js';

const dbUp = await isDbAvailable();
const WINDOW_MS = 60_000;

describe.skipIf(!dbUp)('session rate limiting', () => {
  describe('per-user limit', () => {
    let ctx: Awaited<ReturnType<typeof setupTestApp>>;
    let app: FastifyInstance;

    beforeAll(async () => {
      ctx = await setupTestApp(
        { AUTO_PIPELINE: 'off' },
        { sessionLimiter: new FixedWindowRateLimiter(2, WINDOW_MS) },
      );
      app = ctx.app;
    });

    afterAll(async () => {
      await ctx.teardown();
    });

    it('throttles a single user after their per-minute budget, with rate-limit headers', async () => {
      const user = await seedUser(ctx, { roles: ['valuation_user'] });
      const req = { method: 'GET' as const, url: '/api/v1/me', headers: authHeader(user.token) };

      const first = await app.inject(req);
      const second = await app.inject(req);
      const third = await app.inject(req);

      expect(first.statusCode).toBe(200);
      expect(first.headers['x-ratelimit-limit-user']).toBe('2');
      expect(second.statusCode).toBe(200);
      expect(second.headers['x-ratelimit-remaining-user']).toBe('0');
      expect(third.statusCode).toBe(429);
      expect(Number(third.headers['retry-after'])).toBeGreaterThan(0);
    });

    it('does not let one user throttled-out affect another', async () => {
      const spent = await seedUser(ctx, { roles: ['valuation_user'] });
      const req = { method: 'GET' as const, url: '/api/v1/me', headers: authHeader(spent.token) };
      await app.inject(req);
      await app.inject(req);
      expect((await app.inject(req)).statusCode).toBe(429);

      const fresh = await seedUser(ctx, { roles: ['valuation_user'] });
      const freshRes = await app.inject({
        method: 'GET',
        url: '/api/v1/me',
        headers: authHeader(fresh.token),
      });
      expect(freshRes.statusCode).toBe(200);
    });
  });

  describe('per-org limit', () => {
    let ctx: Awaited<ReturnType<typeof setupTestApp>>;
    let app: FastifyInstance;

    beforeAll(async () => {
      ctx = await setupTestApp(
        { AUTO_PIPELINE: 'off' },
        {
          // High enough that only the org limiter can trip in this suite.
          sessionLimiter: new FixedWindowRateLimiter(1000, WINDOW_MS),
          sessionOrgLimiter: new FixedWindowRateLimiter(2, WINDOW_MS),
        },
      );
      app = ctx.app;
    });

    afterAll(async () => {
      await ctx.teardown();
    });

    it('shares one budget across every user in the same partner org', async () => {
      const partnerId = await seedPartner(ctx, 'Acme Fund');
      const userA = await seedUser(ctx, { roles: ['partner'], partnerId });
      const userB = await seedUser(ctx, { roles: ['partner'], partnerId });

      const resA = await app.inject({
        method: 'GET',
        url: '/api/v1/me',
        headers: authHeader(userA.token),
      });
      const resB = await app.inject({
        method: 'GET',
        url: '/api/v1/me',
        headers: authHeader(userB.token),
      });
      const resA2 = await app.inject({
        method: 'GET',
        url: '/api/v1/me',
        headers: authHeader(userA.token),
      });

      expect(resA.statusCode).toBe(200);
      expect(resB.statusCode).toBe(200);
      // Third request against the org, regardless of which user, is refused.
      expect(resA2.statusCode).toBe(429);
    });

    it('does not apply an org limit to users without a partner', async () => {
      const solo = await seedUser(ctx, { roles: ['valuation_user'] });
      const req = { method: 'GET' as const, url: '/api/v1/me', headers: authHeader(solo.token) };
      // More requests than the org budget, but there is no org to charge them to.
      for (let i = 0; i < 5; i++) {
        expect((await app.inject(req)).statusCode).toBe(200);
      }
    });
  });

  describe('default (no limiter configured)', () => {
    it('never throttles or adds rate-limit headers when neither limiter is injected', async () => {
      const ctx = await setupTestApp({ AUTO_PIPELINE: 'off' });
      try {
        const user = await seedUser(ctx, { roles: ['valuation_user'] });
        const req = {
          method: 'GET' as const,
          url: '/api/v1/me',
          headers: authHeader(user.token),
        };
        let lastRes;
        for (let i = 0; i < 10; i++) lastRes = await ctx.app.inject(req);
        expect(lastRes?.statusCode).toBe(200);
        expect(lastRes?.headers['x-ratelimit-limit-user']).toBeUndefined();
      } finally {
        await ctx.teardown();
      }
    });
  });
});
