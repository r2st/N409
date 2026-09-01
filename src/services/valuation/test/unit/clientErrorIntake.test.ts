import { describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { MetricsRegistry, registerProblemHandler } from '@n409/shared';
import { registerClientErrorRoutes } from '../../src/routes/clientErrors.js';
import { FixedWindowRateLimiter } from '../../src/plugins/rateLimit.js';

/**
 * The intake for crashes that happen after the bundle has been served.
 *
 * Nothing on this box could see one before R313: the shell and the bundle are
 * both 200s, so a release that blanks a route for every user leaves the access
 * log, the error rate and every gauge exactly as they were.
 *
 * What is pinned here is the pair the endpoint exists to produce — a counter an
 * alert can read and a log line an operator can read — and the bounds that keep
 * an unauthenticated write from being a liability.
 */

const report = {
  kind: 'render',
  name: 'TypeError',
  message: 'cannot read properties of undefined',
  stack: 'TypeError: x\n    at Workspace (app.js:1:1)',
  url: '/valuations/01J/workspace',
};

async function buildBare(opts: { limiter?: FixedWindowRateLimiter } = {}): Promise<{
  app: FastifyInstance;
  registry: MetricsRegistry;
  lines: Array<{ obj: Record<string, unknown>; msg: string }>;
}> {
  const lines: Array<{ obj: Record<string, unknown>; msg: string }> = [];
  const app = Fastify({ logger: false });
  const registry = new MetricsRegistry();
  app.decorate('metrics', registry);
  // Capture what the route says rather than what pino renders; the fields are
  // the contract.
  app.addHook('onRequest', (req, _reply, done) => {
    req.log = {
      ...req.log,
      warn: (obj: Record<string, unknown>, msg: string) => void lines.push({ obj, msg }),
    } as typeof req.log;
    done();
  });
  registerProblemHandler(app);
  registerClientErrorRoutes(app, opts);
  await app.ready();
  return { app, registry, lines };
}

describe('POST /api/v1/client-errors', () => {
  it('counts the crash and writes it down', async () => {
    const { app, registry, lines } = await buildBare();
    try {
      const res = await app.inject({ method: 'POST', url: '/api/v1/client-errors', payload: report });
      // 204: nothing to disclose, and worthless as an oracle.
      expect(res.statusCode).toBe(204);
      expect(res.body).toBe('');

      expect(registry.render()).toContain('client_errors_total{kind="render"} 1');
      expect(lines).toHaveLength(1);
      expect(lines[0]!.obj).toMatchObject({
        event: 'client_error',
        kind: 'render',
        name: 'TypeError',
        detail: 'cannot read properties of undefined',
        page: '/valuations/01J/workspace',
      });
      expect(String(lines[0]!.obj.stack)).toContain('at Workspace');
    } finally {
      await app.close();
    }
  });

  it('refuses a kind it did not name, because the kind is a metric label', async () => {
    const { app, registry } = await buildBare();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/client-errors',
        payload: { ...report, kind: 'whatever-the-caller-likes' },
      });
      expect(res.statusCode).toBe(422);
      // No series minted from the refused label.
      expect(registry.render()).not.toContain('whatever-the-caller-likes');
    } finally {
      await app.close();
    }
  });

  it('refuses a report bigger than the caps rather than logging it', async () => {
    const { app, lines } = await buildBare();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/client-errors',
        payload: { kind: 'render', message: 'x'.repeat(5_000) },
      });
      expect(res.statusCode).toBe(422);
      expect(lines).toHaveLength(0);
    } finally {
      await app.close();
    }
  });

  it('counts what the throttle refused, so the signal never flattens in silence', async () => {
    const { app, registry } = await buildBare({ limiter: new FixedWindowRateLimiter(2, 60_000) });
    try {
      for (let i = 0; i < 2; i++) {
        expect(
          (await app.inject({ method: 'POST', url: '/api/v1/client-errors', payload: report })).statusCode,
        ).toBe(204);
      }
      const refused = await app.inject({ method: 'POST', url: '/api/v1/client-errors', payload: report });
      expect(refused.statusCode).toBe(429);
      // The wait, which the problem catalogue promises on every 429 here.
      expect(refused.headers['retry-after']).toBeDefined();

      const text = registry.render();
      expect(text).toContain('client_errors_total{kind="render"} 2');
      expect(text).toContain('client_errors_dropped_total 1');
    } finally {
      await app.close();
    }
  });

  it('works without a metrics registry, so a bare app can still log', async () => {
    const app = Fastify({ logger: false });
    registerProblemHandler(app);
    registerClientErrorRoutes(app);
    await app.ready();
    try {
      const res = await app.inject({ method: 'POST', url: '/api/v1/client-errors', payload: report });
      expect(res.statusCode).toBe(204);
    } finally {
      await app.close();
    }
  });
});
