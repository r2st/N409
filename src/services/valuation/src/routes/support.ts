import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { isUlid, problems } from '@n409/shared';
import { isOps } from '../auth/rbac.js';
import { createSupportMessage, listSupportMessages, setSupportMessageStatus } from '../repos/support.js';
import { requirePrincipal } from '../plugins/auth.js';

/**
 * In-app support (remaining-gaps §3 #8, the Intercom-style widget): any
 * signed-in user can send a message from the help widget and see their own
 * history; ops triage the inbox and mark messages resolved.
 */

const CreateBody = z.object({
  subject: z.string().min(1).max(300),
  body: z.string().min(1).max(20_000),
  page_path: z.string().max(500).optional(),
});

const ListQuery = z.object({
  status: z.enum(['open', 'resolved']).optional(),
});

const PatchBody = z.object({
  status: z.enum(['open', 'resolved']),
});

export function registerSupportRoutes(app: FastifyInstance, deps: { pool: pg.Pool }): void {
  app.post('/api/v1/support/messages', { preHandler: app.authenticate }, async (req, reply) => {
    const principal = requirePrincipal(req);
    const parsed = CreateBody.safeParse(req.body);
    if (!parsed.success) throw problems.unprocessable('Invalid message', { errors: parsed.error.issues });
    const message = await createSupportMessage(deps.pool, {
      userId: principal.id,
      subject: parsed.data.subject,
      body: parsed.data.body,
      pagePath: parsed.data.page_path ?? null,
    });
    return reply.status(201).send({ message });
  });

  // Ops see the whole inbox; everyone else sees their own message history.
  app.get('/api/v1/support/messages', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    const parsed = ListQuery.safeParse(req.query);
    if (!parsed.success) throw problems.badRequest('Invalid query', { errors: parsed.error.issues });
    const filters = isOps(principal)
      ? { status: parsed.data.status }
      : { status: parsed.data.status, userId: principal.id };
    return listSupportMessages(deps.pool, filters);
  });

  app.patch('/api/v1/support/messages/:id', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    if (!isOps(principal)) throw problems.forbidden('Support triage is operations-only');
    const { id } = req.params as { id: string };
    if (!isUlid(id)) throw problems.notFound();
    const parsed = PatchBody.safeParse(req.body);
    if (!parsed.success) throw problems.unprocessable('Invalid patch', { errors: parsed.error.issues });
    const message = await setSupportMessageStatus(deps.pool, id, parsed.data.status, principal.id);
    if (!message) throw problems.notFound();
    return { message };
  });
}
