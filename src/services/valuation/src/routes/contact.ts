import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { isUlid, problems } from '@n409/shared';
import { isOps } from '../auth/rbac.js';
import { OptionalPhone } from '../domain/phone.js';
import {
  createContactSubmission,
  listContactSubmissions,
  setContactSubmissionStatus,
} from '../repos/contactSubmissions.js';
import { requirePrincipal } from '../plugins/auth.js';
import { FixedWindowRateLimiter } from '../plugins/rateLimit.js';
import { invalidBody, invalidQuery } from '../domain/validationProblem.js';

/**
 * Public marketing contact form (409.ai gap #28). Anyone can POST a message
 * from /contact (no auth) — a per-IP fixed-window limiter keeps it from being
 * a spam relay. Ops read the queue and mark each submission handled.
 */

const CreateBody = z.object({
  name: z.string().trim().min(1).max(200),
  email: z.string().trim().email().max(320),
  company: z.string().trim().max(200).optional(),
  phone: OptionalPhone,
  message: z.string().trim().min(1).max(10_000),
});

const ListQuery = z.object({
  status: z.enum(['new', 'handled']).optional(),
});

const PatchBody = z.object({
  status: z.enum(['new', 'handled']),
});

/** Blank strings survive zod's optional(); fold them to undefined. */
function blankToUndefined(v: string | undefined): string | undefined {
  return v && v.length > 0 ? v : undefined;
}

export function registerContactRoutes(
  app: FastifyInstance,
  deps: { pool: pg.Pool; limiter?: FixedWindowRateLimiter },
): void {
  // 5 submissions per IP per 10 minutes — generous for a human, useless for a bot.
  const limiter = deps.limiter ?? new FixedWindowRateLimiter(5, 10 * 60 * 1000);

  app.post('/api/v1/contact', async (req, reply) => {
    const { allowed, resetAt } = limiter.check(req.ip);
    if (!allowed) {
      throw problems.tooManyRequests(
        'Too many messages — please try again later',
        Math.max(1, Math.ceil((resetAt - Date.now()) / 1000)),
      );
    }
    const parsed = CreateBody.safeParse(req.body);
    if (!parsed.success) throw invalidBody('Invalid message', parsed.error);
    const submission = await createContactSubmission(deps.pool, {
      name: parsed.data.name,
      email: parsed.data.email,
      company: blankToUndefined(parsed.data.company),
      // Already blank-folded and normalized to E.164 by OptionalPhone.
      phone: parsed.data.phone,
      message: parsed.data.message,
    });
    return reply.status(201).send({ submission: { id: submission.id, created_at: submission.created_at } });
  });

  app.get('/api/v1/contact/submissions', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    if (!isOps(principal)) throw problems.forbidden('Contact submissions are operations-only');
    const parsed = ListQuery.safeParse(req.query);
    if (!parsed.success) throw invalidQuery(parsed.error);
    return listContactSubmissions(deps.pool, { status: parsed.data.status });
  });

  app.patch('/api/v1/contact/submissions/:id', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    if (!isOps(principal)) throw problems.forbidden('Contact submissions are operations-only');
    const { id } = req.params as { id: string };
    if (!isUlid(id)) throw problems.notFound();
    const parsed = PatchBody.safeParse(req.body);
    if (!parsed.success) throw invalidBody('Invalid patch', parsed.error);
    const submission = await setContactSubmissionStatus(deps.pool, id, parsed.data.status, principal.id);
    if (!submission) throw problems.notFound();
    return { submission };
  });
}
