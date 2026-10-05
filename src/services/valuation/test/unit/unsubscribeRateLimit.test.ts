import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { registerProblemHandler } from '@n409/shared';
import { registerUnsubscribeRoutes } from '../../src/routes/unsubscribe.js';
import { FixedWindowRateLimiter } from '../../src/plugins/rateLimit.js';

/**
 * R378: the unsubscribe endpoints were the only public, database-writing routes
 * with no per-IP rate limiter. Every other public endpoint that writes (contact,
 * client-intake, auditor-portal, board-approval) has one. The POST verifies a
 * cryptographic token and upserts a preference row on every valid request, so an
 * unthrottled caller burns CPU on signature verification and holds connections.
 */

const stubPool = { query: async () => ({ rows: [], rowCount: 0 }) } as never;
const SECRET = 'test-secret-long-enough-for-hmac-0123456789abcdef';

function buildApp(limiter: FixedWindowRateLimiter) {
  const app = Fastify({ logger: false });
  registerProblemHandler(app);
  registerUnsubscribeRoutes(app, { pool: stubPool, secret: SECRET, limiter });
  return app;
}

describe('unsubscribe rate limiting', () => {
  it('refuses the POST after the per-IP budget is spent', async () => {
    const limiter = new FixedWindowRateLimiter(2, 60_000);
    const app = buildApp(limiter);
    try {
      for (let i = 0; i < 2; i++) {
        const res = await app.inject({
          method: 'POST',
          url: '/api/v1/unsubscribe?token=junk',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          payload: 'List-Unsubscribe=One-Click',
        });
        // Still 200 — good tokens or bad, the budget wasn't exhausted yet.
        expect(res.statusCode).toBe(200);
      }
      const refused = await app.inject({
        method: 'POST',
        url: '/api/v1/unsubscribe?token=junk',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: 'List-Unsubscribe=One-Click',
      });
      // POST answers 200 even when throttled, so a provider never sees 429.
      expect(refused.statusCode).toBe(200);
      expect(refused.json()).toMatchObject({ unsubscribed: false });
    } finally {
      await app.close();
    }
  });

  it('refuses the GET after the per-IP budget is spent', async () => {
    const limiter = new FixedWindowRateLimiter(2, 60_000);
    const app = buildApp(limiter);
    try {
      for (let i = 0; i < 2; i++) {
        const res = await app.inject({ method: 'GET', url: '/api/v1/unsubscribe?token=junk' });
        expect(res.statusCode).toBe(200);
      }
      const refused = await app.inject({ method: 'GET', url: '/api/v1/unsubscribe?token=junk' });
      expect(refused.statusCode).toBe(429);
      expect(refused.body).toContain('Too many requests');
    } finally {
      await app.close();
    }
  });

  it('shares the budget between POST and GET', async () => {
    const limiter = new FixedWindowRateLimiter(2, 60_000);
    const app = buildApp(limiter);
    try {
      await app.inject({
        method: 'POST',
        url: '/api/v1/unsubscribe?token=junk',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: '',
      });
      await app.inject({ method: 'GET', url: '/api/v1/unsubscribe?token=junk' });
      // Third request — the budget is spent regardless of verb.
      const refused = await app.inject({ method: 'GET', url: '/api/v1/unsubscribe?token=junk' });
      expect(refused.statusCode).toBe(429);
    } finally {
      await app.close();
    }
  });
});
