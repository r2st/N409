import { describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { registerProblemHandler } from '@n409/shared';
import { registerSubscribeRoutes } from '../../src/routes/subscribe.js';
import { FixedWindowRateLimiter } from '../../src/plugins/rateLimit.js';

function mockPool() {
  return { query: vi.fn().mockResolvedValue({ rows: [] }) } as any;
}

describe('POST /api/v1/subscribe', () => {
  it('returns 201 on valid email', async () => {
    const pool = mockPool();
    const app = Fastify();
    registerSubscribeRoutes(app, { pool });
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/subscribe',
      payload: { email: 'test@example.com' },
    });
    expect(res.statusCode).toBe(201);
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO email_subscribers'),
      ['test@example.com'],
    );
  });

  it('rejects invalid email', async () => {
    const pool = mockPool();
    const app = Fastify();
    registerSubscribeRoutes(app, { pool });
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/subscribe',
      payload: { email: 'not-an-email' },
    });
    expect(res.statusCode).toBe(422);
    expect(pool.query).not.toHaveBeenCalled();
  });

  it('rejects empty body', async () => {
    const pool = mockPool();
    const app = Fastify();
    registerSubscribeRoutes(app, { pool });
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/subscribe',
      payload: {},
    });
    expect(res.statusCode).toBe(422);
  });

  it('returns 429 with retry-after >= 1 when rate-limited', async () => {
    const limiter = new FixedWindowRateLimiter(1, 60_000);
    const pool = mockPool();
    const app = Fastify();
    registerProblemHandler(app);
    registerSubscribeRoutes(app, { pool, limiter });

    await app.inject({
      method: 'POST',
      url: '/api/v1/subscribe',
      payload: { email: 'first@example.com' },
    });

    const refused = await app.inject({
      method: 'POST',
      url: '/api/v1/subscribe',
      payload: { email: 'second@example.com' },
    });

    expect(refused.statusCode).toBe(429);
    const body = refused.json();
    expect(body.retry_after_seconds).toBeGreaterThanOrEqual(1);
    expect(Number(refused.headers['retry-after'])).toBeGreaterThanOrEqual(1);
  });
});
