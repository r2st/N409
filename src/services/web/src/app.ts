import { existsSync, readFileSync, readdirSync, type Dirent } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import httpProxy from '@fastify/http-proxy';
import helmet from '@fastify/helmet';
import pg from 'pg';
import {
  REQUEST_ID_HEADER,
  bindRequestId,
  createLogger,
  probeReady,
  requestIdFromHeaders,
  MetricsRegistry,
  registerHealth,
  registerHttpMetrics,
  registerMetricsEndpoint,
  registerCgroupMemoryMetrics,
  registerProcessMetrics,
  registerPermissionsPolicy,
  registerProblemHandler,
  registerRequestDrain,
  trustedProxies,
  WEB_PERMISSIONS_POLICY,
} from '@n409/shared';

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
export function buildReadinessPool(databaseUrl: string): pg.Pool {
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
 * Executable inline `<script>` bodies in a served HTML document, as the
 * `'sha256-…'` source expressions CSP wants.
 *
 * `index.html` ships one inline script on purpose: the theme resolver, which
 * must run synchronously in `<head>` before first paint or a dark-mode visitor
 * sees a white flash. Every prerendered marketing document inherits it, since
 * the prerenderer rewrites only the head-fallback block.
 *
 * A `script-src` of `'self'` does not permit inline script, so shipping that
 * tag under this CSP means the browser refuses to run it and the flash it
 * exists to prevent happens on every cold load — silently, because a blocked
 * inline script is a console message and nothing else.
 *
 * The hashes are computed from the documents actually on disk rather than
 * pinned as constants, so editing the theme script cannot quietly re-break it:
 * whatever is served is what is allowed. `'unsafe-inline'` would also fix the
 * flash, and would additionally permit every inline script an injection could
 * introduce — the whole value of the directive. Hashes keep that shut.
 *
 * Only executable scripts count. `application/ld+json` blocks — of which the
 * marketing documents carry dozens — are data, never executed, and so are not
 * subject to `script-src`; hashing them would bloat the header for nothing.
 */
export function inlineScriptHashes(
  staticRoot: string,
  log?: { warn: (fields: Record<string, unknown>, message: string) => void },
): string[] {
  const hashes = new Set<string>();
  const documents = htmlFilesUnder(staticRoot);
  for (const file of documents) {
    let html: string;
    try {
      html = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
      const attrs = match[1] ?? '';
      // An external script is governed by its URL, not by a hash.
      if (/\bsrc\s*=/i.test(attrs)) continue;
      const type = /\btype\s*=\s*["']?([^"'\s>]+)/i.exec(attrs)?.[1];
      // Absent type and `module` are JavaScript; anything else is a data block
      // unless it names a JavaScript MIME type.
      if (type && type !== 'module' && !/^(text|application)\/(java|ecma)script$/i.test(type)) continue;
      hashes.add(
        `'sha256-${createHash('sha256')
          .update(match[2] ?? '', 'utf8')
          .digest('base64')}'`,
      );
    }
  }
  /*
   * A CSP with no hashes in it, over documents that carry an inline script, is
   * the exact state this directive was written to end — and it is invisible
   * (R305, methodology M11).
   *
   * The header is served either way. Every inline script in the built documents
   * is then blocked by the browser, which reports it as a console message on the
   * visitor's machine and nowhere else: the site works, the theme resolver does
   * not run, and the flash of the wrong theme this whole mechanism exists to
   * prevent is back on every cold load. Nothing on the server ever learns it.
   *
   * Two causes, said apart, because they are different faults. No documents at
   * all means the static root is missing, unreadable or empty — the build did
   * not land, and every other thing served from that directory is broken too.
   * Documents with no inline script in them is a frontend change: the resolver
   * was renamed, moved to a `src` bundle, or dropped.
   *
   * Warned rather than refused. A deployment that genuinely has no inline
   * script is legitimate, and failing to boot the public site over a cosmetic
   * regression is the wrong trade — but it must not be silent.
   */
  if (hashes.size === 0) {
    log?.warn(
      { staticRoot, documents: documents.length },
      documents.length === 0
        ? 'no HTML documents under the static root — nothing to hash for the CSP, and nothing to serve'
        : 'no inline script hashes for the CSP — any inline script in the built documents will be blocked',
    );
  }
  // Sorted so the header is byte-stable across boots — it is compared in tests
  // and cached by intermediaries.
  return [...hashes].sort();
}

/** Every `.html` file under `dir`, recursively. Missing directory → nothing. */
function htmlFilesUnder(dir: string): string[] {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const found: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...htmlFilesUnder(full));
    else if (/\.html?$/i.test(entry.name)) found.push(full);
  }
  return found;
}

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
export function loadPrerenderManifest(
  staticRoot: string,
  log?: { warn: (fields: Record<string, unknown>, message: string) => void },
): Map<string, string> {
  const manifestPath = path.join(staticRoot, 'prerender-manifest.json');
  /*
   * THREE CAUSES, ONE EMPTY MAP (R305, methodology M11).
   *
   * A build that did not prerender, a manifest that will not parse, and a
   * manifest whose `routes` is not an object all left here as `new Map()`, and
   * the caller's one warning says "no prerender manifest" for each. Two of the
   * three are a file sitting on disk that this process read and rejected, which
   * is a build or deploy fault with a fix — and the line an operator would see
   * tells them the opposite, that nothing was produced.
   *
   * The consequence is the same either way and is why any of this is worth a
   * line: every marketing route falls back to the generic SPA shell, so Slack,
   * LinkedIn, X and every crawler that does not run JavaScript unfurls a blank
   * preview. There is no other symptom — the pages render correctly to a human
   * — so nothing surfaces this until somebody pastes a link.
   *
   * The logger is optional because the four unit tests here call this directly
   * with a temporary directory and have no app; the caller in `buildApp` passes
   * `app.log`.
   */
  if (!existsSync(manifestPath)) return new Map();
  try {
    const parsed: unknown = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const routes = (parsed as { routes?: Record<string, unknown> }).routes;
    if (!routes || typeof routes !== 'object') {
      log?.warn(
        { manifestPath },
        'prerender manifest has no routes object — marketing routes will serve the generic shell',
      );
      return new Map();
    }
    return new Map(
      Object.entries(routes).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
    );
  } catch (err) {
    log?.warn(
      { err, manifestPath },
      'prerender manifest is present but could not be read — marketing routes will serve the generic shell',
    );
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

/**
 * Does this request want a document, or a file that was supposed to be on disk?
 *
 * The SPA fallback answers every path the static plugin did not claim, which is
 * correct for client-side routes — `/valuations/01ARZ…` has no file behind it
 * and never will. It is wrong for anything that named a file: the fallback
 * returned `index.html`, as `text/html`, with a **200**.
 *
 * That is not a cosmetic mismatch. Vite fingerprints its chunks and the build
 * empties `dist/` before writing, so the moment a deploy lands, every hashed
 * URL the *previous* build named is gone. A browser tab that was already open
 * then navigates to a lazy route, asks for its old chunk, and is handed the
 * HTML shell with a 200. The module is refused for its MIME type, the dynamic
 * import rejects, and — because `React.lazy` caches a rejection permanently —
 * the error boundary's "Try again" can never succeed. The app is bricked until
 * the user thinks to reload.
 *
 * The 200 is the other half of the damage, and it outlives the tab: a missing
 * font, image, stylesheet or manifest also answers "success", so a half-built
 * or half-shipped `dist/` looks perfectly healthy to a CDN, an uptime check and
 * anything reading the access log.
 *
 * The rule is the one distinction that matters: a final path segment carrying
 * an extension is a request for a file. No client-side route in the product has
 * one — every slug is kebab-case and every id is a ULID — and a prerendered
 * route is matched from the manifest before this is consulted, so a route that
 * grew one would still be served.
 *
 * Only the *last* segment decides, so `/blog/v1.2-notes/comments` stays a
 * route. The 12-character bound is what `.webmanifest` needs and is past every
 * web asset extension in use; it keeps a long dotted slug from being read as a
 * filename.
 */
export function looksLikeAssetRequest(url: string): boolean {
  const pathOnly = url.split('?')[0]!.split('#')[0]!;
  const lastSegment = pathOnly.slice(pathOnly.lastIndexOf('/') + 1);
  return /\.[A-Za-z0-9]{1,12}$/.test(lastSegment);
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
 * An upstream base URL, or a refusal that names the variable it came from.
 *
 * The valuation service parses its own `AI_URL` / `ENGINE_URL` through
 * `z.string().url()`; the same three variables here were read straight out of
 * the environment. A scheme-less `VALUATION_URL=127.0.0.1:3001` — the obvious
 * way to write it, and the way the systemd unit's own comment describes the
 * address — does fail, but it fails as an unhandled `TypeError: Invalid URL`
 * raised inside `@fastify/reply-from` while the plugin is registering. The
 * stack names `reply-from/lib/request.js`; nothing in it names `VALUATION_URL`,
 * and the whole /api surface of the public origin is what did not come up.
 *
 * `probeReady` takes the other two, where the equivalent mistake is quieter
 * still: a bad `AI_URL` is a readiness check that fails for a reason that reads
 * like the AI service being down.
 */
function upstreamUrl(value: string, variable: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(
      `${variable} is not a URL — got "${value}". It needs a scheme, e.g. http://127.0.0.1:3001`,
    );
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`${variable} must be http or https — got "${value}"`);
  }
  return value;
}

/**
 * Web/BFF: serves the built React SPA and proxies /api/* to the valuation
 * service so the browser talks to a single origin (no CORS, no exposed ports).
 */
export function buildApp(opts: WebAppOptions = {}): FastifyInstance {
  const app = Fastify({
    loggerInstance: createLogger({ service: 'web' }),
    // The BFF is where a browser request enters the estate, so it is where the
    // id that ties the whole chain together is minted. Honouring an inbound
    // header lets a load balancer or a synthetic check supply its own.
    //
    // `requestIdHeader: false` plus `genReqId` rather than the header option,
    // because the header option adopts whatever arrived without looking at it
    // — and this is the hop a browser talks to. Whatever is adopted here is
    // stamped on the proxied call, bound by the valuation service, forwarded
    // again to the engine, the AI gateway and the renderer, and written on
    // every log line of all five. See `acceptableRequestId`.
    requestIdHeader: false,
    genReqId: (req) => requestIdFromHeaders(req.headers),
    // Caddy terminates TLS and dials this service, so the socket peer is Caddy
    // on every request. This is also the hop that decides the client identity
    // for the whole estate: the proxy below restamps X-Forwarded-For from the
    // address resolved here, so the valuation service inherits this answer
    // rather than forming its own from a header it cannot vouch for.
    trustProxy: trustedProxies(),
  }) as unknown as FastifyInstance;

  // Bind the request id to the async context, so a line written through
  // anything other than `req.log` still carries it — `app.log` in a route, a
  // module-level logger, a hook, or work that outlives the response. Fastify
  // has already resolved `req.id` from the inbound x-request-id (or minted
  // one) by the time this fires.
  //
  // The mixin that reads it has been on every service's logger since it was
  // written; only the valuation service ever fed it. In the other two
  // `currentRequestId()` answered undefined, so the field was quietly absent
  // from exactly the lines it exists for — the ones with no `req` in scope.
  app.addHook('onRequest', (req, _reply, done) => {
    bindRequestId(String(req.id));
    done();
  });
  const staticRoot = opts.staticRoot ?? process.env.WEB_STATIC_ROOT ?? defaultStaticRoot;
  const hasStatic = existsSync(staticRoot);

  // Security headers for the served SPA (audit B-1 P1 / F-2). This is the HTML
  // origin, so it carries the real CSP: self-hosted JS/CSS only, images from
  // https/data, styles allow inline (Tailwind/injected), analytics hosts allowed
  // for consent-gated scripts. Framing is denied and HSTS is enabled.
  //
  // The inline theme resolver in each document is admitted by hash — see
  // inlineScriptHashes. Analytics needs no such treatment: gtm.js and gtag.js
  // are injected as `src` scripts (web-frontend/src/lib/analytics.ts), so the
  // host allowances above cover them.
  // `hasStatic` is false in every unit test that builds the app without a
  // frontend, and the absence is already the operator's own choice there — the
  // warning inside belongs to a root that exists and yielded nothing.
  const scriptHashes = hasStatic ? inlineScriptHashes(staticRoot, app.log) : [];
  void app.register(helmet, {
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        'default-src': ["'self'"],
        'base-uri': ["'self'"],
        'object-src': ["'none'"],
        'frame-ancestors': ["'none'"],
        'form-action': ["'self'"],
        'script-src': ["'self'", ...ANALYTICS_SCRIPT, ...scriptHashes],
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
  // helmet sets no Permissions-Policy at all, so the HTML origin — the one
  // surface where the header actually constrains a script — was sending none
  // (round 74). The web policy deliberately leaves the media and clipboard
  // families at their defaults; see securityHeaders.ts for what breaks if they
  // are named here instead.
  registerPermissionsPolicy(app, WEB_PERMISSIONS_POLICY);

  registerProblemHandler(app);

  const valuationUrl = upstreamUrl(
    opts.valuationUrl ?? process.env.VALUATION_URL ?? 'http://127.0.0.1:3001',
    'VALUATION_URL',
  );
  const aiUrl = upstreamUrl(opts.aiUrl ?? process.env.AI_URL ?? 'http://127.0.0.1:3002', 'AI_URL');
  const engineUrl = upstreamUrl(
    opts.engineUrl ?? process.env.ENGINE_URL ?? 'http://127.0.0.1:3003',
    'ENGINE_URL',
  );

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
  // Let a request that is already being served finish before `close()` takes
  // its socket away — Fastify 5 does not, see drain.ts. This is the only one of
  // the five units a browser talks to directly, so a request truncated by a
  // restart here is one a person is watching. Registered before the proxy so it
  // counts the proxied /api round trips too, and discounted when the proxied
  // response closes rather than when it was forwarded.
  const requestDrain = registerRequestDrain(app);

  /**
   * Scrape endpoint (shared/prometheus.ts).
   *
   * This is the origin the public actually reaches — Caddy proxies every path
   * on port 3000 straight through — so the gate is the whole story here. With
   * no `METRICS_TOKEN` (or `INTERNAL_SERVICE_TOKEN`) set in production the
   * route is not registered at all, because this body names every route the
   * platform has and how often each one fails.
   */
  const metricsRegistry = new MetricsRegistry();
  registerHttpMetrics(app, metricsRegistry);
  registerProcessMetrics(metricsRegistry, 'web');
  // The ceiling this process is running under, beside what it is holding.
  // Round 99 gave every unit a MemoryMax, which means a service can now be
  // SIGKILLed by the cgroup limiter and restarted by systemd inside a few
  // seconds, leaving nothing in this process's own output to say it happened.
  // No-op off Linux and on a cgroup v1 host — see cgroupMemory.ts.
  registerCgroupMemoryMetrics(metricsRegistry);
  metricsRegistry.gauge(
    'http_requests_in_flight',
    'Requests currently being served',
    () => requestDrain.inFlight,
  );
  registerMetricsEndpoint(app, { registry: metricsRegistry, service: 'web' });

  void app.register(httpProxy, {
    upstream: valuationUrl,
    prefix: '/api',
    rewritePrefix: '/api',
    replyOptions: {
      // Stamp the proxied request with this request's id so the valuation
      // service — and the engine/AI calls it makes in turn — log under the same
      // id as the browser call that started it. Without this the chain breaks
      // at the first hop: each service downstream mints its own.
      rewriteRequestHeaders: (req, headers) => ({
        ...headers,
        [REQUEST_ID_HEADER]: String(req.id),
        // Collapse the forwarded chain to the one address this hop resolved.
        //
        // Passing the inbound header through unchanged is not enough. A request
        // that arrives without one — anything reaching the published port 3000
        // directly rather than through Caddy — would forward none, and the
        // valuation service would fall back to its socket peer, which is this
        // process: every such client sharing a single throttle bucket again,
        // for the one route class that skipped the proxy we control.
        //
        // Restamping also drops whatever the client prepended. `req.ip` is
        // already the rightmost address no trusted hop vouched for, so what is
        // sent on is the answer this hop reached, not the raw claim it started
        // from — and the valuation service, whose peer is loopback and trusted,
        // reads exactly that. One place decides who the client is.
        'x-forwarded-for': req.ip,
      }),
    },
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
      // @fastify/static v10 hands this the Fastify reply, where v8 handed it the
      // raw ServerResponse. Same hook, different object: `reply.header` rather
      // than `res.setHeader`.
      setHeaders: (reply, filePath) => {
        void reply.header('cache-control', cacheControlFor(filePath));
      },
    });

    // The loader names the cause when there is a file it could not use; this
    // covers the remaining one, which is that the build produced none at all.
    const prerendered = loadPrerenderManifest(staticRoot, app.log);
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
      if (file === undefined && looksLikeAssetRequest(req.url)) {
        // A file that is not there. Say so, rather than handing back the shell
        // under a 200 — see looksLikeAssetRequest.
        return reply.code(404).type('text/plain; charset=utf-8').send('Not Found');
      }
      void reply.header('cache-control', HTML_CACHE_CONTROL);
      return reply.sendFile(file ?? 'index.html');
    });
  } else {
    app.log.warn({ staticRoot }, 'frontend build not found — serving API proxy only');
  }

  return app;
}
