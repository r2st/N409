import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import httpProxy from '@fastify/http-proxy';
import { createLogger, registerHealth, registerProblemHandler } from '@n409/shared';

export interface WebAppOptions {
  /** Upstream valuation-service base URL; /api/* is proxied here. */
  valuationUrl?: string;
  /** Directory holding the built SPA (index.html + assets). */
  staticRoot?: string;
}

const defaultStaticRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../web-frontend/dist',
);

/**
 * Web/BFF: serves the built React SPA and proxies /api/* to the valuation
 * service so the browser talks to a single origin (no CORS, no exposed ports).
 */
export function buildApp(opts: WebAppOptions = {}): FastifyInstance {
  const app = Fastify({
    loggerInstance: createLogger({ service: 'web' }),
  }) as unknown as FastifyInstance;
  const staticRoot = opts.staticRoot ?? process.env.WEB_STATIC_ROOT ?? defaultStaticRoot;
  const hasStatic = existsSync(staticRoot);

  registerProblemHandler(app);
  // When the SPA build is present it owns / — keep only /health + /ready here.
  registerHealth(app, { service: 'web', rootRoute: !hasStatic });

  const valuationUrl = opts.valuationUrl ?? process.env.VALUATION_URL ?? 'http://127.0.0.1:3001';
  void app.register(httpProxy, {
    upstream: valuationUrl,
    prefix: '/api',
    rewritePrefix: '/api',
  });

  if (hasStatic) {
    // wildcard:false registers a route per built file; the catch-all below
    // then serves index.html for client-side routes (SPA fallback). /api/*
    // stays with the proxy — a static-prefix wildcard beats /* in routing.
    void app.register(fastifyStatic, { root: staticRoot, wildcard: false });
    app.get('/*', (_req, reply) => reply.sendFile('index.html'));
  } else {
    app.log.warn({ staticRoot }, 'frontend build not found — serving API proxy only');
  }

  return app;
}
