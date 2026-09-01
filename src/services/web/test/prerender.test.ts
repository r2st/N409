import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildApp, loadPrerenderManifest, manifestKey } from '../src/app.js';

/**
 * The marketing site is a client-rendered SPA, so its per-page metadata is
 * baked into one static document per route at build time. Serving the generic
 * shell for those routes instead means every link shared into Slack, LinkedIn
 * or X unfurls blank — those crawlers never run the JavaScript that would fill
 * the tags in. These tests cover the serving half of that contract.
 */

/** A dist directory with a shell, two prerendered routes, and a manifest. */
function buildStaticRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'n409-prerender-'));
  writeFileSync(path.join(root, 'index.html'), '<!doctype html><title>N409</title>HOME-DOC');

  mkdirSync(path.join(root, 'pricing'), { recursive: true });
  writeFileSync(
    path.join(root, 'pricing', 'index.html'),
    '<!doctype html><title>Pricing · N409</title>PRICING-DOC',
  );

  mkdirSync(path.join(root, 'products', '409a-valuation'), { recursive: true });
  writeFileSync(
    path.join(root, 'products', '409a-valuation', 'index.html'),
    '<!doctype html><title>409A Valuation · N409</title>PRODUCT-DOC',
  );

  writeFileSync(
    path.join(root, 'prerender-manifest.json'),
    JSON.stringify({
      routes: {
        '/': 'index.html',
        '/pricing': 'pricing/index.html',
        '/products/409a-valuation': 'products/409a-valuation/index.html',
      },
    }),
  );
  return root;
}

describe('manifestKey', () => {
  it('normalises the root', () => {
    expect(manifestKey('/')).toBe('/');
    expect(manifestKey('')).toBe('/');
  });

  it('drops the query string so campaign links still match', () => {
    // Marketing links carry utm parameters almost by definition.
    expect(manifestKey('/pricing?utm_source=linkedin&utm_campaign=q3')).toBe('/pricing');
    expect(manifestKey('/pricing#faq')).toBe('/pricing');
  });

  it('drops a trailing slash', () => {
    expect(manifestKey('/pricing/')).toBe('/pricing');
    expect(manifestKey('/products/409a-valuation/')).toBe('/products/409a-valuation');
  });
});

describe('loadPrerenderManifest', () => {
  it('reads the route map emitted by the frontend build', () => {
    const manifest = loadPrerenderManifest(buildStaticRoot());
    expect(manifest.get('/pricing')).toBe('pricing/index.html');
    expect(manifest.size).toBe(3);
  });

  it('returns an empty map when the build predates prerendering', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'n409-noprerender-'));
    writeFileSync(path.join(root, 'index.html'), 'SPA-SHELL');
    expect(loadPrerenderManifest(root).size).toBe(0);
  });

  it('tolerates a corrupt or unexpected manifest rather than failing to boot', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'n409-badmanifest-'));
    writeFileSync(path.join(root, 'index.html'), 'SPA-SHELL');
    writeFileSync(path.join(root, 'prerender-manifest.json'), '{ not json');
    expect(loadPrerenderManifest(root).size).toBe(0);

    writeFileSync(path.join(root, 'prerender-manifest.json'), '{"routes":{"/a":42}}');
    expect(loadPrerenderManifest(root).size).toBe(0);
  });

  /**
   * Three causes, one empty map (R305, methodology M11).
   *
   * A build that did not prerender, a manifest that will not parse, and a
   * manifest whose `routes` is not an object were all `new Map()`, and the
   * caller's one line said "no prerender manifest" for each. Two of the three
   * are a file this process read and rejected — a build or deploy fault with a
   * fix — and the operator was told the opposite, that nothing was produced.
   *
   * The consequence is why it is worth a line at all: every marketing route
   * falls back to the generic shell, so every unfurler that does not run
   * JavaScript shows a blank preview, and the pages themselves look perfect to
   * a human. Nothing surfaces it until somebody pastes a link.
   */
  it('says which of the two unusable manifests it found, rather than "none"', () => {
    const lines: Array<{ fields: Record<string, unknown>; message: string }> = [];
    const log = {
      warn: (fields: Record<string, unknown>, message: string) => lines.push({ fields, message }),
    };
    const root = mkdtempSync(path.join(tmpdir(), 'n409-badmanifest-log-'));
    writeFileSync(path.join(root, 'index.html'), 'SPA-SHELL');

    writeFileSync(path.join(root, 'prerender-manifest.json'), '{ not json');
    expect(loadPrerenderManifest(root, log).size).toBe(0);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.message).toMatch(/present but could not be read/);
    expect(lines[0]!.fields.err).toBeInstanceOf(Error);

    writeFileSync(path.join(root, 'prerender-manifest.json'), '{"routes":42}');
    expect(loadPrerenderManifest(root, log).size).toBe(0);
    expect(lines).toHaveLength(2);
    expect(lines[1]!.message).toMatch(/no routes object/);
  });

  it('says nothing when the manifest is simply absent — that line is the caller\u2019s', () => {
    // The vacuity guard's other half: a loader that warned on every empty
    // answer would double the "no prerender manifest" line on the ordinary
    // build-predates-prerendering case and say nothing new.
    const lines: string[] = [];
    const log = { warn: (_f: Record<string, unknown>, message: string) => lines.push(message) };
    const root = mkdtempSync(path.join(tmpdir(), 'n409-noprerender-log-'));
    writeFileSync(path.join(root, 'index.html'), 'SPA-SHELL');
    expect(loadPrerenderManifest(root, log).size).toBe(0);
    expect(lines).toEqual([]);
  });

  it('says nothing on a manifest it could use', () => {
    const lines: string[] = [];
    const log = { warn: (_f: Record<string, unknown>, message: string) => lines.push(message) };
    expect(loadPrerenderManifest(buildStaticRoot(), log).size).toBe(3);
    expect(lines).toEqual([]);
  });
});

describe('serving prerendered marketing routes', () => {
  const root = buildStaticRoot();

  it('serves the route-specific document, not the shell', async () => {
    const app = buildApp({ staticRoot: root });
    const res = await app.inject({ method: 'GET', url: '/pricing' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('PRICING-DOC');
    expect(res.body).toContain('<title>Pricing · N409</title>');
    await app.close();
  });

  it('serves nested product routes', async () => {
    const app = buildApp({ staticRoot: root });
    const res = await app.inject({ method: 'GET', url: '/products/409a-valuation' });
    expect(res.body).toContain('PRODUCT-DOC');
    await app.close();
  });

  it('matches routes carrying campaign parameters', async () => {
    const app = buildApp({ staticRoot: root });
    const res = await app.inject({ method: 'GET', url: '/pricing?utm_source=x' });
    expect(res.body).toContain('PRICING-DOC');
    await app.close();
  });

  it('still falls back to the shell for application routes', async () => {
    const app = buildApp({ staticRoot: root });
    const res = await app.inject({ method: 'GET', url: '/valuations/01ARZ3NDEKTSV4RRFFQ69G5FAV' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('HOME-DOC');
    await app.close();
  });

  it('does not let a crafted path escape the static root', async () => {
    // Only manifest keys map to files, and each maps to a name the build chose
    // — nothing derived from the request reaches the filesystem.
    const app = buildApp({ staticRoot: root });
    for (const url of ['/../../etc/passwd', '/pricing/../../../etc/passwd']) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.body).not.toContain('root:');
    }
    await app.close();
  });

  it('does not let a percent-encoded separator escape the static root', async () => {
    // The plain `..` case above is the one a reader thinks of; the four
    // advisories that took @fastify/static from 8.3.0 to 10.1.3 were all about
    // the encoded and non-canonical spellings of it — `%2e%2e`, `%2f`, a
    // backslash, a doubly-encoded `%252e` — reaching the file layer after the
    // routing layer had already decided the path was fine
    // (GHSA-83w8-p2f5-377r, GHSA-8pvw-jcv7-9cmj). This is the estate's only
    // static server, so it is the only place they could have applied.
    const app = buildApp({ staticRoot: root });
    const crafted = [
      '/%2e%2e/%2e%2e/etc/passwd',
      '/..%2f..%2fetc/passwd',
      '/pricing/..%2f..%2f..%2fetc%2fpasswd',
      '/%252e%252e/%252e%252e/etc/passwd',
      '/..\\..\\etc\\passwd',
      '/pricing/%2e%2e%2f%2e%2e%2fetc%2fpasswd',
    ];
    for (const url of crafted) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.body, url).not.toContain('root:');
      // Whatever it answers, it must not be a file from outside the root: the
      // SPA fallback (index.html) and a refusal are both acceptable outcomes.
      if (res.statusCode === 200) expect(res.body, url).toContain('HOME-DOC');
    }
    await app.close();
  });

  it('serves a real prerendered route, so the traversal cases are not passing on a dead server', async () => {
    // The assertions above are all negative. If `buildApp` stopped serving
    // static files entirely they would pass for the wrong reason.
    const app = buildApp({ staticRoot: root });
    const res = await app.inject({ method: 'GET', url: '/pricing' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('PRICING-DOC');
    await app.close();
  });
});
