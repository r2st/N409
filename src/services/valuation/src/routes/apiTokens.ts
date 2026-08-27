import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { isUlid, problems } from '@n409/shared';
import { canManageTokens } from '../auth/operations.js';
import { canManageUsers } from '../auth/rbac.js';
import {
  API_TOKEN_PAGE_LIMIT,
  apiTokenStats,
  createApiToken,
  findApiTokenById,
  listAllApiTokens,
  listApiTokens,
  revokeApiToken,
  TOKEN_PAGE_LIMIT,
} from '../repos/apiTokens.js';
import { requirePrincipal } from '../plugins/auth.js';
import { recordAdminEvent } from '../events/adminRecord.js';
import { flagParam } from '../domain/queryFlag.js';
import { invalidBody, invalidQuery } from '../domain/validationProblem.js';
import { forbidden } from '../domain/accessProblem.js';

/**
 * M3 feature 14 — partner API token management. Tokens are scoped to a
 * partner; the secret is returned exactly once, on creation.
 *
 * Minting and revoking are audited (R159), and were not. `GET
 * /api/v1/admin/api-tokens` exists precisely because "who currently holds API
 * credentials" is a question somebody asks — and it answers it as a *snapshot*
 * of the rows that survive. A token minted and revoked between two readings of
 * that page left no trace anywhere, which is the shape of the credential you
 * would most want a trace of. A partner token reads a firm's engagements
 * without a session and outlives the browser that made it, hence `critical` on
 * the creation event and `notice` on the revocation.
 */
/** A live token unused for this long is worth asking about. 90 days. */
const DORMANT_AFTER_MS = 90 * 86_400_000;

export function registerApiTokenRoutes(app: FastifyInstance, deps: { pool: pg.Pool }): void {
  app.get('/api/v1/partners/:partnerId/tokens', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    const { partnerId } = req.params as { partnerId: string };
    if (!isUlid(partnerId)) throw problems.notFound();
    if (!canManageTokens(principal, partnerId)) throw forbidden("Listing that partner's API tokens", 'ops');
    return { ...(await listApiTokens(deps.pool, partnerId)), page_limit: API_TOKEN_PAGE_LIMIT };
  });

  app.post('/api/v1/partners/:partnerId/tokens', { preHandler: app.authenticate }, async (req, reply) => {
    const principal = requirePrincipal(req);
    const { partnerId } = req.params as { partnerId: string };
    if (!isUlid(partnerId)) throw problems.notFound();
    if (!canManageTokens(principal, partnerId))
      throw forbidden('Creating an API token for that partner', 'ops');
    // No key mints its successor. The same rule `POST /me/tokens` states at
    // length: revoking a leaked credential has to be the end of it, and it is
    // not if the credential's last act can be to issue a replacement that
    // survives the revocation. A partner key is the one this matters most for —
    // it is handed to an integration, lives outside the firm's browser
    // sessions, and reads the firm's whole book.
    if (req.apiToken)
      throw problems.forbidden(
        'An API token cannot mint another API token — create it from the partner console while signed in',
      );

    const parsed = z.object({ name: z.string().min(1).max(200) }).safeParse(req.body);
    if (!parsed.success) throw invalidBody('Invalid token', parsed.error);

    const { token, secret } = await createApiToken(deps.pool, {
      partnerId,
      createdBy: principal.id,
      name: parsed.data.name,
    });
    await recordAdminEvent(deps.pool, {
      type: 'api_token_created',
      actor: { actorType: 'human', actorId: principal.id },
      subjectType: 'api_token',
      subjectId: token.id,
      subjectLabel: parsed.data.name,
      payload: { partner_id: partnerId },
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
        revoked: flagParam(false),
        limit: z.coerce.number().int().min(1).max(TOKEN_PAGE_LIMIT).default(TOKEN_PAGE_LIMIT),
      })
      .safeParse(req.query ?? {});
    if (!parsed.success) throw invalidQuery(parsed.error);

    // The rows are a page; the figures are the platform. Counting in SQL rather
    // than over `tokens` is what lets the read be bounded without the security
    // figures quietly shrinking to match — see `apiTokenStats`. "Dormant" is the
    // number this list exists to surface: a live credential nobody is using.
    const [{ tokens, truncated }, stats] = await Promise.all([
      listAllApiTokens(deps.pool, {
        includeRevoked: parsed.data.revoked,
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
    await recordAdminEvent(deps.pool, {
      type: 'api_token_revoked',
      actor: { actorType: 'human', actorId: principal.id },
      subjectType: 'api_token',
      subjectId: id,
      subjectLabel: token.name,
      payload: { partner_id: token.partner_id, personal: token.partner_id === null },
    });
    return reply.status(204).send();
  });
}
