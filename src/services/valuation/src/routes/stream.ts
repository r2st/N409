import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { isUlid, problems } from '@n409/shared';
import { canReadValuation, type Principal } from '../auth/rbac.js';
import { findValuationById } from '../repos/valuations.js';
import { findUserById } from '../repos/users.js';
import { requirePrincipal } from '../plugins/auth.js';
import type { ValuationHub } from '../realtime/hub.js';

/**
 * Improvement 4 — per-valuation SSE stream. One long-lived GET per open
 * detail page; the hub pushes `presence` (who is viewing) and `comment`
 * (live thread updates) events. The client authenticates with the normal
 * bearer header (fetch-based reader, not EventSource, so no token-in-URL).
 */
export function registerStreamRoutes(
  app: FastifyInstance,
  deps: { pool: pg.Pool; hub: ValuationHub; heartbeatMs?: number },
): void {
  const heartbeatMs = deps.heartbeatMs ?? 25_000;

  app.get('/api/v1/valuations/:id/stream', { preHandler: app.authenticate }, async (req, reply) => {
    const principal: Principal = requirePrincipal(req);
    const { id } = req.params as { id: string };
    if (!isUlid(id)) throw problems.notFound();
    const valuation = await findValuationById(deps.pool, id);
    if (
      !valuation ||
      !canReadValuation(principal, { userId: valuation.user_id, partnerId: valuation.partner_id })
    ) {
      throw problems.notFound();
    }

    const user = await findUserById(deps.pool, principal.id);
    const name =
      [user?.first_name, user?.last_name].filter(Boolean).join(' ') || user?.email || 'Someone';

    reply.hijack();
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-accel-buffering': 'no', // disable proxy buffering (nginx) so events flush
    });
    reply.raw.write(': connected\n\n');

    const send = (event: string, data: unknown) => {
      reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    const leave = deps.hub.join(valuation.id, { userId: principal.id, name, send });

    const heartbeat = setInterval(() => {
      reply.raw.write(': ping\n\n');
    }, heartbeatMs);

    req.raw.on('close', () => {
      clearInterval(heartbeat);
      leave();
    });
  });
}
