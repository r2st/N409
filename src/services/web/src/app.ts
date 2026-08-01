import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import httpProxy from '@fastify/http-proxy';
import helmet from '@fastify/helmet';
import pg from 'pg';
import { createLogger, probeReady, registerHealth, registerProblemHandler } from '@n409/shared';

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
  /** Probed by /ready. Defaults to AI_URL / ENGINE_URL. */
  aiUrl?: string;
  engineUrl?: string;
  /**
   * Readiness Postgres pool. Injectable for tests; when omitted one is built
   * from DATABASE_URL and closed with the app.
   */
  pool?: pg.Pool;
  /** Injectable for tests — stands in for the upstream /ready probes. */
  readinessFetch?: typeof fetch;
}

/**
 * Readiness pool: one connection, short timeouts, used only by /ready. It must
 * never queue behind real work, and a probe that hangs is worse than one that
 * fails — /ready is what a load balancer trusts to decide whether to send
 * traffic here.
 */
function buildReadinessPool(databaseUrl: string): pg.Pool {
  return new pg.Pool({
    connectionString: databaseUrl,
    max: 1,
    connectionTimeoutMillis: 3000,
    idleTimeoutMillis: 10_000,
    // Matches the valuation service's default: managed Postgres commonly
    // presents a chain we don't ship a CA for, and this connection carries only
    // `SELECT 1`.
    ssl: /sslmode=(?!disable)/.test(databaseUrl) ? { rejectUnauthorized: false } : undefined,
  });
}

const defaultStaticRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../web-frontend/dist',
);

/**
 * Route → prerendered document, written by the frontend build
 * (web-frontend/src/lib/prerender.ts).
 *
 * Marketing routes each have their own HTML file whose `<head>` carries that
 * page's title, description, canonical, Open Graph and JSON-LD. Serving the
 * generic SPA shell for them instead — which is what the bare `index.html`
 * fallback did — means Slack, LinkedIn, X and every other unfurler shows a
 * blank preview, because none of them execute the JavaScript that would fill
 * those tags in.
 *
 * Only paths present in this manifest are mapped, and each maps to a filename
 * the build chose. Nothing derived from the request reaches the filesystem, so
 * there is no traversal surface here.
 */
export function loadPrerenderManifest(staticRoot: string): Map<string, string> {
  const manifestPath = path.join(staticRoot, 'prerender-manifest.json');
  if (!existsSync(manifestPath)) return new Map();
  try {
    const parsed: unknown = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const routes = (parsed as { routes?: Record<string, unknown> }).routes;
    if (!routes || typeof routes !== 'object') return new Map();
    return new Map(
      Object.entries(routes).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
    );
  } catch {
    return new Map();
  }
}

/**
 * Normalise a request URL to a manifest lookup key: drop the query string and
 * any trailing slash, so `/pricing`, `/pricing/` and `/pricing?utm_source=x`
 * all resolve to the same prerendered document.
 */
export function manifestKey(url: string): string {
  const pathOnly = url.split('?')[0]!.split('#')[0]!;
  if (pathOnly === '/' || pathOnly === '') return '/';
  return pathOnly.replace(/\/+$/, '');
}

/** A year, the maximum any cache should be asked to hold something. */
export const IMMUTABLE_CACHE_CONTROL = 'public, max-age=31536000, immutable';
/**
 * Revalidate every time. Not `no-store`: the document may sit in the cache, but
 * a stale one must never be served, because it names the hashed bundles.
 */
export const HTML_CACHE_CONTROL = 'no-cache';

/**
 * Cache policy for a built asset, by path.
 *
 * Vite fingerprints everything under `/assets/` with a content hash, so those
 * URLs can never change meaning — they are the textbook case for a one-year
 * immutable cache, and serving them with no Cache-Control at all (the previous
 * behaviour) made every repeat visitor re-fetch the entire bundle.
 *
 * HTML is the opposite: it is the document that *names* those hashed files, so
 * a cached copy pins the visitor to a shipped-over build. It must revalidate.
 */
export function cacheControlFor(filePath: string): string {
  const normalised = filePath.replace(/\\/g, '/');
  if (/(^|\/)assets\//.test(normalised)) return IMMUTABLE_CACHE_CONTROL;
  if (/\.html?$/i.test(normalised)) return HTML_CACHE_CONTROL;
  // Everything else at the site root (favicon, og-image, robots.txt, manifests)
  // keeps its name across deploys, so it gets a short shared cache instead of an
  // immutable one — long enough to help, short enough that a fix propagates.
  return 'public, max-age=3600';
}

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

  const valuationUrl = opts.valuationUrl ?? process.env.VALUATION_URL ?? 'http://127.0.0.1:3001';
  const aiUrl = opts.aiUrl ?? process.env.AI_URL ?? 'http://127.0.0.1:3002';
  const engineUrl = opts.engineUrl ?? process.env.ENGINE_URL ?? 'http://127.0.0.1:3003';

  // Readiness. This endpoint previously reported `{"checks":{}}` with a 200 —
  // structurally incapable of ever saying "not ready", which made it worse than
  // no endpoint at all: Caddy and every uptime check believed it. Web is the
  // only origin the public reaches, so its readiness has to mean "a request
  // arriving here can actually be served", and that depends entirely on
  // downstream services it does not itself contain.
  //
  // The upstream probes are the load-bearing part; `postgres` is checked too so
  // a database outage is attributable at the edge instead of only showing up as
  // three simultaneous upstream failures.
  const databaseUrl = process.env.DATABASE_URL;
  const readinessPool = opts.pool ?? (databaseUrl ? buildReadinessPool(databaseUrl) : undefined);
  if (!readinessPool) {
    // Deliberately fatal to readiness rather than skipped: every unit shares one
    // EnvironmentFile that defines DATABASE_URL, so its absence is a broken
    // deploy. A check that quietly passes when unconfigured is how /ready came
    // to report an empty object in the first place.
    app.log.error('DATABASE_URL is not set — /ready will report unavailable');
  }
  // The pool is ours only when we built it; an injected one belongs to the caller.
  if (!opts.pool && readinessPool) app.addHook('onClose', async () => readinessPool.end());

  // When the SPA build is present it owns / — keep only /health + /ready here.
  registerHealth(app, {
    service: 'web',
    rootRoute: !hasStatic,
    checks: {
      postgres: async () => {
        if (!readinessPool) throw new Error('DATABASE_URL is not configured');
        await readinessPool.query('SELECT 1');
      },
      // Named for what a failure means to a visitor, not for the hostname.
      valuation: () => probeReady('valuation', valuationUrl, { fetchFn: opts.readinessFetch }),
      ai: () => probeReady('ai', aiUrl, { fetchFn: opts.readinessFetch }),
      engine: () => probeReady('engine', engineUrl, { fetchFn: opts.readinessFetch }),
    },
  });
  void app.register(httpProxy, {
    upstream: valuationUrl,
    prefix: '/api',
    rewritePrefix: '/api',
  });

  if (hasStatic) {
    // wildcard:false registers a route per built file; the catch-all below
    // then serves index.html for client-side routes (SPA fallback). /api/*
    // stays with the proxy — a static-prefix wildcard beats /* in routing.
    //
    // setHeaders rather than @fastify/static's own `maxAge`/`immutable`, because
    // those apply one policy to every file: hashed bundles and the HTML that
    // names them need opposite answers (see cacheControlFor).
    void app.register(fastifyStatic, {
      root: staticRoot,
      wildcard: false,
      // `cacheControl: false` disables the library's own header (which defaulted
      // to `public, max-age=0` and would win over ours) so setHeaders is the
      // single authority on cache policy.
      cacheControl: false,
      setHeaders: (res, filePath) => {
        res.setHeader('cache-control', cacheControlFor(filePath));
      },
    });

    const prerendered = loadPrerenderManifest(staticRoot);
    if (prerendered.size === 0) {
      app.log.warn(
        { staticRoot },
        'no prerender manifest — marketing routes will serve the generic shell and unfurl without metadata',
      );
    }

    // The SPA/prerender fallback serves HTML under an arbitrary route path, so
    // it never matches a hashed asset — pin it to no-cache explicitly rather
    // than letting the filename heuristic decide.
    app.get('/*', (req, reply) => {
      const file = prerendered.get(manifestKey(req.url));
      void reply.header('cache-control', HTML_CACHE_CONTROL);
      return reply.sendFile(file ?? 'index.html');
    });
  } else {
    app.log.warn({ staticRoot }, 'frontend build not found — serving API proxy only');
  }

  return app;
}
