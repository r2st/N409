import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { isUlid, problems } from '@n409/shared';
import { canManageTokens } from '../auth/operations.js';
import { createApiToken, findApiTokenById, listApiTokens, revokeApiToken } from '../repos/apiTokens.js';
import { requirePrincipal } from '../plugins/auth.js';

/**
 * M3 feature 14 — partner API token management. Tokens are scoped to a
 * partner; the secret is returned exactly once, on creation.
 */
export function registerApiTokenRoutes(app: FastifyInstance, deps: { pool: pg.Pool }): void {
  app.get('/api/v1/partners/:partnerId/tokens', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    const { partnerId } = req.params as { partnerId: string };
    if (!isUlid(partnerId)) throw problems.notFound();
    if (!canManageTokens(principal, partnerId)) throw problems.forbidden();
    return { tokens: await listApiTokens(deps.pool, partnerId) };
  });

  app.post('/api/v1/partners/:partnerId/tokens', { preHandler: app.authenticate }, async (req, reply) => {
    const principal = requirePrincipal(req);
    const { partnerId } = req.params as { partnerId: string };
    if (!isUlid(partnerId)) throw problems.notFound();
    if (!canManageTokens(principal, partnerId)) throw problems.forbidden();

    const parsed = z.object({ name: z.string().min(1).max(200) }).safeParse(req.body);
    if (!parsed.success) throw problems.unprocessable('Invalid token', { errors: parsed.error.issues });

    const { token, secret } = await createApiToken(deps.pool, {
      partnerId,
      createdBy: principal.id,
      name: parsed.data.name,
    });
    // `secret` is shown once and never retrievable again.
    return reply.status(201).send({ token, secret });
  });

  app.delete('/api/v1/api-tokens/:id', { preHandler: app.authenticate }, async (req, reply) => {
    const principal = requirePrincipal(req);
    const { id } = req.params as { id: string };
    if (!isUlid(id)) throw problems.notFound();
    const token = await findApiTokenById(deps.pool, id);
    if (!token) throw problems.notFound();
    // A personal token (no partner) is governed by ownership, not by the
    // partner policy — nobody else may revoke it, not even ops.
    const allowed = token.partner_id
      ? canManageTokens(principal, token.partner_id)
      : token.created_by === principal.id;
    if (!allowed) throw problems.notFound();
    await revokeApiToken(deps.pool, id);
    return reply.status(204).send();
  });
}
