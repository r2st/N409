import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import httpProxy from '@fastify/http-proxy';
import helmet from '@fastify/helmet';
import { createLogger, registerHealth, registerProblemHandler } from '@n409/shared';

// Analytics hosts the SPA loads *after* cookie consent (§23/§25). Allowed in
// the CSP so opt-in analytics works; everything else is self-only.
const ANALYTICS_SCRIPT = [
  'https://www.googletagmanager.com',
  'https://www.google-analytics.com',
  'https://connect.facebook.net',
];
const ANALYTICS_CONNECT = [
  'https://www.google-analytics.com',
  'https://region1.google-analytics.com',
  'https://www.googletagmanager.com',
  'https://www.facebook.com',
];

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

  // Security headers for the served SPA (audit B-1 P1 / F-2). This is the HTML
  // origin, so it carries the real CSP: self-hosted JS/CSS only, images from
  // https/data, styles allow inline (Tailwind/injected), analytics hosts allowed
  // for consent-gated scripts. Framing is denied and HSTS is enabled.
  void app.register(helmet, {
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        'default-src': ["'self'"],
        'base-uri': ["'self'"],
        'object-src': ["'none'"],
        'frame-ancestors': ["'none'"],
        'form-action': ["'self'"],
        'script-src': ["'self'", ...ANALYTICS_SCRIPT],
        'style-src': ["'self'", "'unsafe-inline'"],
        'img-src': ["'self'", 'data:', 'https:'],
        'font-src': ["'self'", 'data:'],
        'connect-src': ["'self'", ...ANALYTICS_CONNECT],
        'frame-src': ["'self'", 'https://td.doubleclick.net'],
        'upgrade-insecure-requests': [],
      },
    },
    frameguard: { action: 'deny' },
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    hsts: { maxAge: 15552000, includeSubDomains: true }, // 180 days
  });

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
