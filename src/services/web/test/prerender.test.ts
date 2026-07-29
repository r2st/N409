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
});
