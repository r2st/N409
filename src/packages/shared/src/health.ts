import type { FastifyInstance } from 'fastify';

export type ReadinessCheck = () => Promise<void>;

/**
 * Health endpoints (issue #4): /health = liveness, /ready = readiness with
 * dependency checks (e.g. SELECT 1 against Postgres).
 */
export function registerHealth(
  app: FastifyInstance,
  opts: { service: string; version?: string; checks?: Record<string, ReadinessCheck> },
): void {
  const startedAt = Date.now();

  app.get('/health', async () => ({
    status: 'ok',
    service: opts.service,
    version: opts.version ?? '0.1.0',
    uptime_s: Math.round((Date.now() - startedAt) / 1000),
  }));

  app.get('/ready', async (_req, reply) => {
    const results: Record<string, string> = {};
    let healthy = true;
    for (const [name, check] of Object.entries(opts.checks ?? {})) {
      try {
        await check();
        results[name] = 'ok';
      } catch (err) {
        healthy = false;
        results[name] = err instanceof Error ? err.message : 'failed';
      }
    }
    return reply
      .status(healthy ? 200 : 503)
      .send({ status: healthy ? 'ready' : 'unavailable', checks: results });
  });
}
