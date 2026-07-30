import type { FastifyInstance } from 'fastify';
import { buildInfo } from './build.js';

export type ReadinessCheck = () => Promise<void>;

/**
 * Health endpoints (issue #4): /health = liveness, /ready = readiness with
 * dependency checks (e.g. SELECT 1 against Postgres).
 *
 * /health also reports the commit that was built (see build.ts) so "which code
 * is live" is answerable without SSH — `dist/` is gitignored and built on the
 * server, so a skipped build used to be invisible from outside.
 */
export function registerHealth(
  app: FastifyInstance,
  opts: {
    service: string;
    version?: string;
    checks?: Record<string, ReadinessCheck>;
    /** Set false when the service serves its own / (e.g. the web SPA). */
    rootRoute?: boolean;
  },
): void {
  const startedAt = Date.now();
  const build = buildInfo();

  if (opts.rootRoute !== false) {
    app.get('/', async () => ({
      service: opts.service,
      version: opts.version ?? '0.1.0',
      status: 'ok',
      endpoints: ['/health', '/ready'],
    }));
  }

  app.get('/health', async () => ({
    status: 'ok',
    service: opts.service,
    version: opts.version ?? '0.1.0',
    uptime_s: Math.round((Date.now() - startedAt) / 1000),
    // 'unknown' when the deploy recorded no provenance — reported rather than
    // omitted, so a deploy that skipped the step is visible instead of silent.
    build_sha: build.sha,
    build_sha_source: build.source,
  }));

  app.get('/ready', async (_req, reply) => {
    const entries = Object.entries(opts.checks ?? {});
    // Checks are independent and mostly network-bound, so run them concurrently:
    // in series, /ready cost the sum of every upstream's timeout.
    const settled = await Promise.all(
      entries.map(async ([name, check]) => {
        try {
          await check();
          return [name, 'ok'] as const;
        } catch (err) {
          return [name, err instanceof Error ? err.message : 'failed'] as const;
        }
      }),
    );
    const healthy = settled.every(([, status]) => status === 'ok');
    return reply.status(healthy ? 200 : 503).send({
      status: healthy ? 'ready' : 'unavailable',
      checks: Object.fromEntries(settled) as Record<string, string>,
      build_sha: build.sha,
    });
  });
}

/**
 * Readiness probe for a sibling service's `/ready`, shared by every service that
 * fronts another one.  Throws with a short, human-readable reason so
 * registerHealth can put it straight into the response body.
 *
 * Deliberately short-timeout, unretried and without body parsing: a readiness
 * check must answer fast and must never become a way to hang /ready. An upstream
 * 503 is honoured — a downstream that knows it is broken makes its callers
 * not-ready too, which is the whole point of probing past `SELECT 1`.
 */
export async function probeReady(
  service: string,
  baseUrl: string,
  opts: {
    timeoutMs?: number;
    fetchFn?: typeof fetch;
    headers?: Record<string, string>;
    /** Path to probe, for a service that mounts health under a prefix. */
    path?: string;
  } = {},
): Promise<void> {
  const url = `${baseUrl.replace(/\/$/, '')}${opts.path ?? '/ready'}`;
  const doFetch = opts.fetchFn ?? fetch;
  let res: Response;
  try {
    res = await doFetch(url, {
      headers: opts.headers ?? {},
      signal: AbortSignal.timeout(opts.timeoutMs ?? 3000),
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : 'unreachable';
    throw new Error(`${service} unreachable at ${url}: ${reason}`);
  }
  if (!res.ok) throw new Error(`${service} is not ready (HTTP ${res.status})`);
}
