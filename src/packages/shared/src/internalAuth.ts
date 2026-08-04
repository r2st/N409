import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { problems } from './problem.js';

/**
 * Shared-secret gate for a service that only other N409 services call.
 *
 * The Python tier has enforced this since audit B-1 P0 (see
 * `src/services/{ai,engine-wrapper}/app/internal_auth.py`): an
 * `X-Internal-Token` header, compared in constant time, required on every
 * non-health route whenever `INTERNAL_SERVICE_TOKEN` is configured. The
 * valuation service already sends the header on every internal call it makes
 * (`clients/internal.ts` internalAuthHeaders).
 *
 * The report service — the fourth internal service, and the only one written
 * in TypeScript — had nothing. `POST /render/v1/pdf` accepted an
 * eight-megabyte body and spent seconds of CPU on it for anyone who could
 * reach port 3004, which is why loopback binding and a firewall rule were the
 * only two things in the way. Both are real defences; neither is the one this
 * estate decided to rely on, and a service that answers unauthenticated
 * requests is one `HOST=0.0.0.0` (which docker-compose sets, deliberately)
 * from being open. This closes that inconsistency: all four internal services
 * now answer the question the same way.
 *
 * Off when the variable is unset, matching the Python behaviour exactly so a
 * local `docker compose up` and the existing test suites keep working, and so
 * a single configured secret turns the whole estate on at once.
 */
export const INTERNAL_TOKEN_HEADER = 'x-internal-token';
export const INTERNAL_TOKEN_ENV = 'INTERNAL_SERVICE_TOKEN';

/**
 * Reachable without the secret, so a load balancer or `docker healthcheck`
 * never needs it. Mirrors `_PUBLIC_PATHS` on the Python side.
 */
export const INTERNAL_PUBLIC_PATHS: ReadonlySet<string> = new Set(['/', '/health', '/ready']);

/** The configured secret, read per call so it can rotate without a restart. */
export function internalToken(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = env[INTERNAL_TOKEN_ENV];
  return raw ? raw : null;
}

export function isInternalPublicPath(url: string): boolean {
  const path = url.split('?')[0] ?? '';
  const trimmed = path.length > 1 ? path.replace(/\/+$/, '') : path;
  return INTERNAL_PUBLIC_PATHS.has(trimmed);
}

/**
 * Constant-time header comparison. Length is compared first because
 * `timingSafeEqual` throws on a mismatch rather than returning false — and the
 * length of a secret is not what an attacker is trying to learn here.
 */
export function internalTokenMatches(provided: string | undefined, expected: string): boolean {
  if (typeof provided !== 'string') return false;
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

export interface InternalAuthLogger {
  warn: (obj: Record<string, unknown>, msg: string) => void;
}

/**
 * Requires `X-Internal-Token` on every non-health route once
 * `INTERNAL_SERVICE_TOKEN` is set. Register before the routes it guards.
 *
 * `onRequest` rather than a per-route preHandler: it runs before the body is
 * parsed, so an unauthenticated caller cannot make this service buffer and
 * validate an eight-megabyte render request before being turned away.
 */
export function registerInternalAuth(
  app: FastifyInstance,
  opts: { service: string; log?: InternalAuthLogger; env?: NodeJS.ProcessEnv } = {
    service: 'internal',
  },
): void {
  const env = opts.env ?? process.env;
  if (internalToken(env) === null) {
    (opts.log ?? app.log).warn(
      { service: opts.service, env: INTERNAL_TOKEN_ENV },
      `${INTERNAL_TOKEN_ENV} is not set — this service accepts unauthenticated requests. ` +
        'Set it in production and bind to loopback.',
    );
  }

  app.addHook('onRequest', async (req: FastifyRequest) => {
    // Re-read per request: the warning above is about start-up configuration,
    // the check is about the secret in force right now.
    const expected = internalToken(env);
    if (expected === null || isInternalPublicPath(req.url)) return;
    const provided = req.headers[INTERNAL_TOKEN_HEADER];
    const value = Array.isArray(provided) ? provided[0] : provided;
    if (!internalTokenMatches(value, expected)) {
      throw problems.unauthorized('Missing or invalid internal service token');
    }
  });
}
