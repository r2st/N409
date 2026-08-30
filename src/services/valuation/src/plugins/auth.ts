import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { ApiProblem, bindActor, problems, type RequestApiToken } from '@n409/shared';
import { verifySession, type JwtConfig } from '../auth/jwt.js';
import { SESSION_COOKIE } from '../auth/cookies.js';
import { isOps, type Principal } from '../auth/rbac.js';
import { findAuthPrincipal } from '../repos/users.js';
import { API_TOKEN_REFUSAL_DETAIL, resolveApiTokenWithReason, TOKEN_SCHEME } from '../repos/apiTokens.js';
import type { SystemSettingsStore } from '../repos/systemSettings.js';
import { costOfRequest } from '../domain/requestCost.js';
import type { FixedWindowRateLimiter, WeightedWindowRateLimiter } from './rateLimit.js';

/**
 * How the request authenticated — the partner API accepts api_token only.
 *
 * Aliases the shared shape rather than restating it because `requestErrorContext`
 * reads this decoration off the request to label the 5xx line, and shared cannot
 * import this file to find out what it is called. It read `apiToken.id` for as
 * long as this existed, so the `api_token_id` it logs was undefined on every
 * request that had a token. Having one definition is what makes renaming a
 * field a build error rather than a field that silently stops appearing.
 */
export type ApiTokenContext = RequestApiToken;

declare module 'fastify' {
  interface FastifyRequest {
    principal: Principal | null;
    /** Set when the bearer was an API token (n409_pat_…). */
    apiToken: ApiTokenContext | null;
    /**
     * The `session_epoch` the presented JWT was minted under, or null when the
     * request did not present one (an API token, or a legacy token from before
     * the claim existed).
     *
     * Recorded rather than recomputed because one route outlives its own
     * request: `routes/stream.ts` holds an SSE connection open for as long as a
     * tab is, and re-checks revocation on a timer. Re-verifying the JWT there
     * would mean the route keeping the raw bearer for hours, which is the one
     * thing this service takes care not to do.
     */
    sessionEpoch: number | null;
  }
  interface FastifyInstance {
    authenticate: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

/**
 * What a request with no credential at all is told.
 *
 * `problems.unauthorized()`'s default is "Authentication required", which
 * states the problem and stops. The two audiences that reach this line need
 * different next steps and both fit in a sentence: a browser has a session
 * cookie it did not send (or has been signed out), and an integrator has an
 * `Authorization` header to add — and naming the scheme and the token prefix is
 * the difference between reading the docs and guessing at them.
 */
const MISSING_CREDENTIAL =
  `Authentication required. Send an API token as \`Authorization: Bearer ${TOKEN_SCHEME}…\`, ` +
  'or sign in — a browser session sends its own cookie, so this usually means the session expired.';

/** Requests that only read are served normally during maintenance. */
const READ_ONLY_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Checks `key` against `limiter` (a no-op when undefined) and mirrors the
 * partner API's header convention (`x-ratelimit-*` / `retry-after`) so every
 * throttle on this platform reports the same shape. Scope distinguishes the
 * two limiters in the 429 detail message ("user" vs "org").
 */
function applyLimiter(
  reply: FastifyReply,
  limiter: FixedWindowRateLimiter | undefined,
  key: string,
  scope: 'user' | 'org',
): void {
  if (!limiter) return;
  const result = limiter.check(key);
  void reply.header(`x-ratelimit-limit-${scope}`, result.limit);
  void reply.header(`x-ratelimit-remaining-${scope}`, result.remaining);
  void reply.header(`x-ratelimit-reset-${scope}`, Math.ceil(result.resetAt / 1000));
  if (!result.allowed) {
    const retryAfter = Math.max(1, Math.ceil((result.resetAt - Date.now()) / 1000));
    throw problems.tooManyRequests(
      `Rate limit of ${result.limit} requests per minute exceeded for this ${scope === 'user' ? 'account' : 'organization'}`,
      retryAfter,
    );
  }
}

/**
 * Charges an expensive request against the per-user cost budget. Ordinary
 * requests cost nothing and never touch the limiter, so the headers only appear
 * on the routes the budget actually governs.
 */
function applyCostLimiter(
  req: FastifyRequest,
  reply: FastifyReply,
  limiter: WeightedWindowRateLimiter | undefined,
  key: string,
): void {
  if (!limiter) return;
  const cost = costOfRequest(req.method, req.url);
  if (cost <= 0) return;

  const result = limiter.consume(key, cost);
  void reply.header('x-ratelimit-limit-cost', result.limit);
  void reply.header('x-ratelimit-remaining-cost', result.remaining);
  void reply.header('x-ratelimit-reset-cost', Math.ceil(result.resetAt / 1000));
  if (!result.allowed) {
    const retryAfter = Math.max(1, Math.ceil((result.resetAt - Date.now()) / 1000));
    throw problems.tooManyRequests(
      `Budget for expensive operations (${result.limit} cost units per minute) exhausted`,
      retryAfter,
    );
  }
}

/**
 * Bearer authentication: session JWTs, or API tokens (`n409_pat_…`, M3) which
 * act as the user that created them. Roles/partner are re-read from the DB on
 * every request so a role change or removal takes effect immediately, not at
 * token expiry.
 */
export function registerAuth(
  app: FastifyInstance,
  deps: {
    pool: pg.Pool;
    jwt: JwtConfig;
    settings?: SystemSettingsStore;
    /** Per-user request throttle across the whole authenticated API surface. */
    sessionLimiter?: FixedWindowRateLimiter;
    /** Per-organisation (partner) throttle, checked alongside sessionLimiter. */
    sessionOrgLimiter?: FixedWindowRateLimiter;
    /** Per-user cost budget for renders, exports, engine runs and AI jobs. */
    costLimiter?: WeightedWindowRateLimiter;
  },
): void {
  app.decorateRequest('principal', null);
  app.decorateRequest('apiToken', null);
  app.decorateRequest('sessionEpoch', null);

  app.decorate('authenticate', async (req: FastifyRequest, reply: FastifyReply) => {
    // Bearer header first (API tokens + JS clients), falling back to the
    // httpOnly session cookie (audit F-2) so the SPA never needs a JS-readable
    // token. An empty/whitespace bearer is treated as absent.
    const header = req.headers.authorization;
    const headerBearer = header?.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : '';
    const bearer = headerBearer || req.cookies?.[SESSION_COOKIE] || '';
    if (!bearer) throw problems.unauthorized(MISSING_CREDENTIAL);

    let sub: string;
    let sessionEpoch: number | null = null;
    if (bearer.startsWith(TOKEN_SCHEME)) {
      // The refusal reason, not just the refusal. `resolveApiToken` answered
      // `null` to four different conditions and this said "Invalid or revoked
      // API token" to all of them — including the one this platform causes
      // itself, where a firm's integration stops because the member who minted
      // its key was moved out of the org. That reads as a typo, and the fix for
      // it is nothing like the fix for a typo. See `ApiTokenRefusal`.
      const { token: resolved, refusal } = await resolveApiTokenWithReason(deps.pool, bearer);
      if (!resolved) throw problems.unauthorized(API_TOKEN_REFUSAL_DETAIL[refusal ?? 'unknown']);
      sub = resolved.userId;
      req.apiToken = { tokenId: resolved.tokenId, partnerId: resolved.partnerId };
    } else {
      try {
        ({ sub, session_epoch: sessionEpoch } = await verifySession(bearer, deps.jwt));
      } catch {
        throw problems.unauthorized(
          'Your session is no longer valid — it has expired, or was ended by a password change. Sign in again.',
        );
      }
    }

    const user = await findAuthPrincipal(deps.pool, sub);
    // "Unknown user" was a statement about our lookup, given to somebody with
    // no user to look up. The reachable cause is one thing — the account this
    // credential acts as has been closed — and saying it is the difference
    // between a support ticket and a sign-up. (An API token minted by a closed
    // account is refused a layer earlier now, with its own sentence; see
    // `ApiTokenRefusal.no_owner`.)
    if (!user || user.deleted_at) {
      throw problems.unauthorized(
        'The account this sign-in belongs to has been closed, so it can no longer be used. ' +
          'Contact support if it was closed in error, or sign in with another account.',
      );
    }

    // "Sign out everywhere" and password changes bump the epoch; a JWT minted
    // before the bump is dead. API tokens have their own revocation and are
    // deliberately unaffected — revoking browser sessions shouldn't break a
    // partner's running integration.
    if (sessionEpoch !== null && sessionEpoch !== user.session_epoch) {
      throw problems.unauthorized('This session has been signed out');
    }

    req.principal = { id: user.id, roles: user.roles, partnerId: user.partner_id };
    req.sessionEpoch = sessionEpoch;

    // Put the actor on the request's log context now that it is known, so every
    // line this request writes says who it was for — including the work that
    // outlives the response, which this service starts a lot of and awaits none
    // of. Bound here rather than per route for the same reason the throttles
    // are: this preHandler is the one place every authenticated request passes
    // through. Ids only; see RequestActor.
    bindActor({
      userId: req.principal.id,
      partnerId: req.principal.partnerId,
      apiTokenId: req.apiToken?.tokenId ?? null,
    });

    // Per-user / per-org throttling (improvement 5), checked right after the
    // principal resolves so it covers every authenticated route through this
    // one preHandler rather than needing per-route wiring. Both limiters are
    // optional — a deployment (or a test) that doesn't pass one simply skips
    // that check, matching the injectable pattern used for the partner/board/
    // scim limiters elsewhere in AppDeps.
    applyLimiter(reply, deps.sessionLimiter, req.principal.id, 'user');
    if (req.principal.partnerId) {
      applyLimiter(reply, deps.sessionOrgLimiter, req.principal.partnerId, 'org');
    }
    applyCostLimiter(req, reply, deps.costLimiter, req.principal.id);

    // Maintenance mode: ops keep working, everyone else gets a read-only
    // platform. Sign-in and password reset live on unauthenticated routes and
    // stay up regardless.
    if (deps.settings && !READ_ONLY_METHODS.has(req.method) && !isOps(req.principal)) {
      if (await deps.settings.get('maintenance_mode')) {
        // `expected`: an operator turned this on, so the 503 is policy rather
        // than breakage and the error handler logs it at `warn`. Without that
        // a maintenance window files one `error` per refused write, for as
        // long as the window lasts.
        throw maintenanceMode();
      }
    }
  });
}

/**
 * The maintenance-mode refusal.
 *
 * Same body `problems.serviceUnavailable` produced, plus `expected` — the one
 * 5xx on this platform that is a planned state rather than a failure, and the
 * only one whose rate is set by how often clients poll rather than by how badly
 * something is broken.
 */
function maintenanceMode(): ApiProblem {
  return new ApiProblem({
    status: 503,
    title: 'Service Unavailable',
    type: 'urn:n409:problem:unavailable',
    detail: 'The platform is in maintenance mode — changes are temporarily disabled.',
    expected: true,
  });
}

export function requirePrincipal(req: FastifyRequest): Principal {
  if (!req.principal) throw problems.unauthorized();
  return req.principal;
}
