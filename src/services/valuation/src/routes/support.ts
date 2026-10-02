import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { isUlid, problems } from '@n409/shared';
import { isOps } from '../auth/rbac.js';
import {
  createSupportMessage,
  listSupportMessages,
  MAX_SUPPORT_MESSAGE_BODY,
  MAX_SUPPORT_MESSAGE_SUBJECT,
  setSupportMessageStatus,
} from '../repos/support.js';
import { recordAdminEvent } from '../events/adminRecord.js';
import { requirePrincipal } from '../plugins/auth.js';
import { invalidBody, invalidQuery } from '../domain/validationProblem.js';
import { nonBlankText } from '../domain/nonBlankText.js';

/**
 * In-app support (remaining-gaps §3 #8, the Intercom-style widget): any
 * signed-in user can send a message from the help widget and see their own
 * history; ops triage the inbox and mark messages resolved.
 */

const CreateBody = z
  .object({
    subject: nonBlankText(1, MAX_SUPPORT_MESSAGE_SUBJECT),
    body: z.string().min(1).max(MAX_SUPPORT_MESSAGE_BODY),
    page_path: z.string().max(500).optional(),
  })
  .strict();

const ListQuery = z.object({
  status: z.enum(['open', 'resolved']).optional(),
});

const PatchBody = z.object({
  status: z.enum(['open', 'resolved']),
}).strict();

export function registerSupportRoutes(app: FastifyInstance, deps: { pool: pg.Pool }): void {
  app.post('/api/v1/support/messages', { preHandler: app.authenticate }, async (req, reply) => {
    const principal = requirePrincipal(req);
    const parsed = CreateBody.safeParse(req.body);
    if (!parsed.success) throw invalidBody('Invalid message', parsed.error);
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
    if (!parsed.success) throw invalidQuery(parsed.error);
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
    if (!parsed.success) throw invalidBody('Invalid patch', parsed.error);
    const written = await setSupportMessageStatus(deps.pool, id, parsed.data.status, principal.id);
    if (!written) throw problems.notFound();
    /*
     * The transition, on the spine that carries every other ops action.
     *
     * Triaging support was the one operations surface that wrote nothing to
     * `admin_events`. Who closed a message lived on the row and nowhere else,
     * so reopening one erased it — `resolved_by` and `resolved_at` are cleared
     * on the way back to `open` — and there was no other copy to read. A
     * message a customer raised, an operator closed, and somebody reopened
     * left a row that could only say it was open.
     *
     * Only on a real transition: `changed` is decided by the UPDATE's own
     * predicate, so a repeated press writes no second row saying it happened
     * twice.
     */
    if (written.changed) {
      await recordAdminEvent(deps.pool, {
        type: parsed.data.status === 'resolved' ? 'support_message_resolved' : 'support_message_reopened',
        actor: { actorType: 'human', actorId: principal.id },
        subjectType: 'support_message',
        subjectId: written.message.id,
        subjectLabel: written.message.subject,
        payload: { status: parsed.data.status },
      });
    }
    return { message: written.message };
  });
}
