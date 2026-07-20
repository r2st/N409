import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { problems } from '@n409/shared';
import { verifySession, type JwtConfig } from '../auth/jwt.js';
import { SESSION_COOKIE } from '../auth/cookies.js';
import { isOps, type Principal } from '../auth/rbac.js';
import { findUserById } from '../repos/users.js';
import { resolveApiToken, TOKEN_SCHEME } from '../repos/apiTokens.js';
import type { SystemSettingsStore } from '../repos/systemSettings.js';

/** How the request authenticated — the partner API accepts api_token only. */
export interface ApiTokenContext {
  tokenId: string;
  /** null for a personal token, which carries its owner's own scope. */
  partnerId: string | null;
}

declare module 'fastify' {
  interface FastifyRequest {
    principal: Principal | null;
    /** Set when the bearer was an API token (n409_pat_…). */
    apiToken: ApiTokenContext | null;
  }
  interface FastifyInstance {
    authenticate: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

/** Requests that only read are served normally during maintenance. */
const READ_ONLY_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Bearer authentication: session JWTs, or API tokens (`n409_pat_…`, M3) which
 * act as the user that created them. Roles/partner are re-read from the DB on
 * every request so a role change or removal takes effect immediately, not at
 * token expiry.
 */
export function registerAuth(
  app: FastifyInstance,
  deps: { pool: pg.Pool; jwt: JwtConfig; settings?: SystemSettingsStore },
): void {
  app.decorateRequest('principal', null);
  app.decorateRequest('apiToken', null);

  app.decorate('authenticate', async (req: FastifyRequest, _reply: FastifyReply) => {
    // Bearer header first (API tokens + JS clients), falling back to the
    // httpOnly session cookie (audit F-2) so the SPA never needs a JS-readable
    // token. An empty/whitespace bearer is treated as absent.
    const header = req.headers.authorization;
    const headerBearer = header?.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : '';
    const bearer = headerBearer || req.cookies?.[SESSION_COOKIE] || '';
    if (!bearer) throw problems.unauthorized();

    let sub: string;
    let sessionEpoch: number | null = null;
    if (bearer.startsWith(TOKEN_SCHEME)) {
      const resolved = await resolveApiToken(deps.pool, bearer);
      if (!resolved) throw problems.unauthorized('Invalid or revoked API token');
      sub = resolved.userId;
      req.apiToken = { tokenId: resolved.tokenId, partnerId: resolved.partnerId };
    } else {
      try {
        ({ sub, session_epoch: sessionEpoch } = await verifySession(bearer, deps.jwt));
      } catch {
        throw problems.unauthorized('Invalid or expired token');
      }
    }

    const user = await findUserById(deps.pool, sub);
    if (!user || user.deleted_at) throw problems.unauthorized('Unknown user');

    // "Sign out everywhere" and password changes bump the epoch; a JWT minted
    // before the bump is dead. API tokens have their own revocation and are
    // deliberately unaffected — revoking browser sessions shouldn't break a
    // partner's running integration.
    if (sessionEpoch !== null && sessionEpoch !== user.session_epoch) {
      throw problems.unauthorized('This session has been signed out');
    }

    req.principal = { id: user.id, roles: user.roles, partnerId: user.partner_id };

    // Maintenance mode: ops keep working, everyone else gets a read-only
    // platform. Sign-in and password reset live on unauthenticated routes and
    // stay up regardless.
    if (deps.settings && !READ_ONLY_METHODS.has(req.method) && !isOps(req.principal)) {
      if (await deps.settings.get('maintenance_mode')) {
        throw problems.serviceUnavailable(
          'The platform is in maintenance mode — changes are temporarily disabled.',
        );
      }
    }
  });
}

export function requirePrincipal(req: FastifyRequest): Principal {
  if (!req.principal) throw problems.unauthorized();
  return req.principal;
}
