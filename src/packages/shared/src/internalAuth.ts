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
 * Off when the variable is unset *outside* production, matching the Python
 * behaviour exactly so a local `docker compose up` and the existing test suites
 * keep working, and so a single configured secret turns the whole estate on at
 * once. In production an unset secret refuses to start — see
 * {@link MissingInternalTokenError}.
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

/** True when this process believes it is serving production traffic. */
export function isProductionEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NODE_ENV === 'production';
}

/**
 * Thrown at start-up when production has no `INTERNAL_SERVICE_TOKEN`.
 *
 * The gate used to be warn-only in every environment (R25 security audit): a
 * deploy that forgot the secret logged one line and then served every internal
 * route unauthenticated, and the line is indistinguishable from the same line
 * on a developer laptop where it is correct. A warning is the wrong shape for
 * this — the failure it describes is silent, permanent, and only visible from
 * outside the box. Refusing to boot makes the misconfiguration cost a failed
 * deploy instead of an open service.
 */
export class MissingInternalTokenError extends Error {
  constructor(readonly service: string) {
    super(
      `${INTERNAL_TOKEN_ENV} is required when NODE_ENV=production — refusing to start ${service}. ` +
        'Every non-health route on this service would otherwise accept unauthenticated requests. ' +
        `Generate one with \`openssl rand -hex 32\` and set it on every service in the estate.`,
    );
    this.name = 'MissingInternalTokenError';
  }
}

/**
 * Requires `X-Internal-Token` on every non-health route once
 * `INTERNAL_SERVICE_TOKEN` is set, and requires the variable itself in
 * production. Register before the routes it guards.
 *
 * `onRequest` rather than a per-route preHandler: it runs before the body is
 * parsed, so an unauthenticated caller cannot make this service buffer and
 * validate an eight-megabyte render request before being turned away.
 *
 * @throws MissingInternalTokenError in production with no secret configured.
 */
export function registerInternalAuth(
  app: FastifyInstance,
  opts: {
    service: string;
    log?: InternalAuthLogger;
    env?: NodeJS.ProcessEnv;
    /**
     * Paths this hook lets past because they carry a gate of their own.
     *
     * Exactly one caller: `/metrics`, which `registerMetricsEndpoint` gates on
     * `METRICS_TOKEN` — a credential that deliberately rotates separately from
     * the estate's service token, because a Prometheus configuration file is a
     * wider blast radius than a systemd unit. Without this the two gates stack
     * on this one service and nowhere else, so a scraper configured with
     * `METRICS_TOKEN` would collect from the web and valuation services and
     * silently fail against the report service alone.
     *
     * Not a general escape hatch: a path named here is unauthenticated *by this
     * hook*, so it must have an equivalent gate or it has none at all.
     */
    gatedElsewhere?: readonly string[];
  } = {
    service: 'internal',
  },
): void {
  const env = opts.env ?? process.env;
  if (internalToken(env) === null) {
    if (isProductionEnv(env)) throw new MissingInternalTokenError(opts.service);
    (opts.log ?? app.log).warn(
      { service: opts.service, env: INTERNAL_TOKEN_ENV },
      `${INTERNAL_TOKEN_ENV} is not set — this service accepts unauthenticated requests. ` +
        'Set it in production and bind to loopback.',
    );
  }

  const gatedElsewhere = new Set(opts.gatedElsewhere ?? []);

  app.addHook('onRequest', async (req: FastifyRequest) => {
    // Re-read per request: the check above is about start-up configuration,
    // this one is about the secret in force right now.
    const expected = internalToken(env);
    if (isInternalPublicPath(req.url)) return;
    const rawPath = req.url.split('?')[0] ?? '';
    const normPath = rawPath.length > 1 ? rawPath.replace(/\/+$/, '') : rawPath;
    if (gatedElsewhere.has(normPath)) return;
    if (expected === null) {
      // Unreachable at boot in production, but the secret is deliberately
      // re-read so it can rotate without a restart — and a rotation that
      // rotates it to nothing must close the gate, not open it.
      if (isProductionEnv(env)) throw problems.unauthorized('Missing or invalid internal service token');
      return;
    }
    const provided = req.headers[INTERNAL_TOKEN_HEADER];
    const value = Array.isArray(provided) ? provided[0] : provided;
    if (!internalTokenMatches(value, expected)) {
      throw problems.unauthorized('Missing or invalid internal service token');
    }
  });
}
