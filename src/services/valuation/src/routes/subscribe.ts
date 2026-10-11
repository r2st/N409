import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { problems } from '@n409/shared';
import { FixedWindowRateLimiter } from '../plugins/rateLimit.js';
import { invalidBody } from '../domain/validationProblem.js';
import { recordThrottleRefusal } from '../observability/requestThrottle.js';

const SubscribeBody = z
  .object({
    email: z.string().trim().email().max(320),
  })
  .strict();

export function registerSubscribeRoutes(
  app: FastifyInstance,
  deps: { pool: pg.Pool; limiter?: FixedWindowRateLimiter },
): void {
  const limiter = deps.limiter ?? new FixedWindowRateLimiter(5, 10 * 60 * 1000);

  app.post('/api/v1/subscribe', async (req, reply) => {
    const { allowed, resetAt } = limiter.check(req.ip);
    if (!allowed) {
      recordThrottleRefusal('subscribe');
      throw problems.tooManyRequests(
        'Too many subscription requests',
        Math.ceil((resetAt - Date.now()) / 1000),
      );
    }

    const parsed = SubscribeBody.safeParse(req.body);
    if (!parsed.success) throw invalidBody('Invalid subscription', parsed.error);

    const { email } = parsed.data;
    await deps.pool.query(
      `INSERT INTO email_subscribers (email) VALUES ($1)
       ON CONFLICT (email) DO NOTHING`,
      [email],
    );

    return reply.code(201).send({ ok: true });
  });
}
