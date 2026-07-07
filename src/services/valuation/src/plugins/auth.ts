import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { problems } from '@n409/shared';
import { verifySession, type JwtConfig } from '../auth/jwt.js';
import type { Principal } from '../auth/rbac.js';
import { findUserById } from '../repos/users.js';
import { resolveApiToken, TOKEN_SCHEME } from '../repos/apiTokens.js';

declare module 'fastify' {
  interface FastifyRequest {
    principal: Principal | null;
  }
  interface FastifyInstance {
    authenticate: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

/**
 * Bearer authentication: session JWTs, or partner API tokens (`n409_pat_…`,
 * M3) which act as the user that created them. Roles/partner are re-read from
 * the DB on every request so a role change or removal takes effect
 * immediately, not at token expiry.
 */
export function registerAuth(app: FastifyInstance, deps: { pool: pg.Pool; jwt: JwtConfig }): void {
  app.decorateRequest('principal', null);

  app.decorate('authenticate', async (req: FastifyRequest, _reply: FastifyReply) => {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) throw problems.unauthorized();
    const bearer = header.slice('Bearer '.length);

    let sub: string;
    if (bearer.startsWith(TOKEN_SCHEME)) {
      const resolved = await resolveApiToken(deps.pool, bearer);
      if (!resolved) throw problems.unauthorized('Invalid or revoked API token');
      sub = resolved.userId;
    } else {
      try {
        ({ sub } = await verifySession(bearer, deps.jwt));
      } catch {
        throw problems.unauthorized('Invalid or expired token');
      }
    }

    const user = await findUserById(deps.pool, sub);
    if (!user || user.deleted_at) throw problems.unauthorized('Unknown user');

    req.principal = { id: user.id, roles: user.roles, partnerId: user.partner_id };
  });
}

export function requirePrincipal(req: FastifyRequest): Principal {
  if (!req.principal) throw problems.unauthorized();
  return req.principal;
}
