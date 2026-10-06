import { describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { registerSubscribeRoutes } from '../../src/routes/subscribe.js';

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
});
