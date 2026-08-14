import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { isUlid, problems } from '@n409/shared';
import { canManageTokens } from '../auth/operations.js';
import { canManageUsers } from '../auth/rbac.js';
import {
  apiTokenStats,
  createApiToken,
  findApiTokenById,
  listAllApiTokens,
  listApiTokens,
  revokeApiToken,
  TOKEN_PAGE_LIMIT,
} from '../repos/apiTokens.js';
import { requirePrincipal } from '../plugins/auth.js';

/**
 * M3 feature 14 — partner API token management. Tokens are scoped to a
 * partner; the secret is returned exactly once, on creation.
 */
/** A live token unused for this long is worth asking about. 90 days. */
const DORMANT_AFTER_MS = 90 * 86_400_000;

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

  /**
   * Cross-partner credential listing (design §14.1).
   *
   * Answering "who currently holds API credentials" used to mean opening every
   * partner page in turn, which is the same as not being able to answer it.
   *
   * Gated on `canManageUsers` rather than `isOps`: this is the whole platform's
   * credential inventory across every firm, and the reviewer and data roles that
   * `isOps` admits have no business reading it. Firm-scoped token management
   * stays where it is, on the partner's own page, under `canManageTokens`.
   *
   * Revoked rows are excluded by default and reachable with `?revoked=true`, so
   * the list opens on the credentials that can currently be used.
   */
  app.get('/api/v1/admin/api-tokens', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    if (!canManageUsers(principal)) {
      throw problems.forbidden('The platform token listing is administrator-only');
    }
    const parsed = z
      .object({
        revoked: z.enum(['true', 'false']).optional(),
        limit: z.coerce.number().int().min(1).max(TOKEN_PAGE_LIMIT).default(TOKEN_PAGE_LIMIT),
      })
      .safeParse(req.query ?? {});
    if (!parsed.success) throw problems.unprocessable('Invalid query', { errors: parsed.error.issues });

    // The rows are a page; the figures are the platform. Counting in SQL rather
    // than over `tokens` is what lets the read be bounded without the security
    // figures quietly shrinking to match — see `apiTokenStats`. "Dormant" is the
    // number this list exists to surface: a live credential nobody is using.
    const [{ tokens, truncated }, stats] = await Promise.all([
      listAllApiTokens(deps.pool, {
        includeRevoked: parsed.data.revoked === 'true',
        limit: parsed.data.limit,
      }),
      apiTokenStats(deps.pool, DORMANT_AFTER_MS),
    ]);
    return {
      tokens,
      truncated,
      total: stats.total,
      live: stats.live,
      dormant: stats.dormant,
      dormant_after_days: DORMANT_AFTER_MS / 86_400_000,
    };
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
