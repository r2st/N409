// R427 M17: data integrity audit — regression tests for the five fixes.
import { describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { registerProblemHandler } from '@n409/shared';
import { registerSubscribeRoutes } from '../../src/routes/subscribe.js';
import { registerShareTokenRoutes } from '../../src/routes/shareTokens.js';

function mockPool() {
  return { query: vi.fn().mockResolvedValue({ rows: [] }) } as any;
}

describe('share token expiry guard (M17 fix 5)', () => {
  it('CTE includes expires_at predicate so expired tokens do not bump view_count', async () => {
    const pool = mockPool();
    const app = Fastify();
    registerProblemHandler(app);
    registerShareTokenRoutes(app, pool);

    // The route fires two queries when the CTE returns no rows:
    // 1. The CTE (bumped) with expires_at > now()
    // 2. A SELECT to distinguish expired from missing
    pool.query
      .mockResolvedValueOnce({ rows: [] })           // CTE returns nothing
      .mockResolvedValueOnce({ rows: [{ token: 'x' }] }); // token exists but expired

    const res = await app.inject({
      method: 'GET',
      url: '/api/share-tokens/some-token/summary',
    });

    expect(res.statusCode).toBe(410);

    const cteQuery = pool.query.mock.calls[0]![0] as string;
    expect(cteQuery).toContain('expires_at > now()');
  });

  it('returns 404 when token does not exist at all', async () => {
    const pool = mockPool();
    const app = Fastify();
    registerProblemHandler(app);
    registerShareTokenRoutes(app, pool);

    pool.query
      .mockResolvedValueOnce({ rows: [] })  // CTE returns nothing
      .mockResolvedValueOnce({ rows: [] }); // token not found in expiry check either

    const res = await app.inject({
      method: 'GET',
      url: '/api/share-tokens/nonexistent/summary',
    });

    expect(res.statusCode).toBe(404);
  });
});

describe('email subscriber case normalisation (M17 fix 4)', () => {
  it('lowercases email before insert', async () => {
    const pool = mockPool();
    const app = Fastify();
    registerSubscribeRoutes(app, { pool });

    await app.inject({
      method: 'POST',
      url: '/api/v1/subscribe',
      payload: { email: 'User@Example.COM' },
    });

    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO email_subscribers'),
      ['user@example.com'],
    );
  });

  it('preserves already-lowercase email', async () => {
    const pool = mockPool();
    const app = Fastify();
    registerSubscribeRoutes(app, { pool });

    await app.inject({
      method: 'POST',
      url: '/api/v1/subscribe',
      payload: { email: 'test@example.com' },
    });

    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO email_subscribers'),
      ['test@example.com'],
    );
  });
});
