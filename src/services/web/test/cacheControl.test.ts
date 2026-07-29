/**
 * Cache-Control on the static SPA.
 *
 * @fastify/static was registered with no `maxAge`, so every built file — including
 * the content-hashed bundles under /assets/ that can never change meaning — went
 * out with no Cache-Control at all and every repeat visitor re-downloaded the
 * whole app. The fix has to be per-file, not global: the HTML names the hashed
 * bundles, so caching *it* would pin a visitor to a shipped-over build.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildApp, cacheControlFor, HTML_CACHE_CONTROL, IMMUTABLE_CACHE_CONTROL } from '../src/app.js';

function staticSite() {
  const root = mkdtempSync(path.join(tmpdir(), 'n409-cache-'));
  mkdirSync(path.join(root, 'assets'));
  writeFileSync(path.join(root, 'index.html'), '<!doctype html><title>N409</title>SPA-SHELL');
  writeFileSync(path.join(root, 'assets', 'index-a1b2c3d4.js'), 'console.log(1)');
  writeFileSync(path.join(root, 'assets', 'index-e5f6a7b8.css'), 'body{}');
  writeFileSync(path.join(root, 'robots.txt'), 'User-agent: *');
  mkdirSync(path.join(root, 'pricing'));
  writeFileSync(path.join(root, 'pricing', 'index.html'), '<!doctype html>PRERENDERED');
  writeFileSync(
    path.join(root, 'prerender-manifest.json'),
    JSON.stringify({ routes: { '/pricing': 'pricing/index.html' } }),
  );
  return root;
}

describe('cacheControlFor', () => {
  it('marks hashed assets immutable for a year', () => {
    expect(cacheControlFor('/build/assets/index-a1b2c3d4.js')).toBe(IMMUTABLE_CACHE_CONTROL);
    expect(cacheControlFor('/build/assets/index-e5f6a7b8.css')).toBe(IMMUTABLE_CACHE_CONTROL);
    expect(IMMUTABLE_CACHE_CONTROL).toContain('max-age=31536000');
    expect(IMMUTABLE_CACHE_CONTROL).toContain('immutable');
  });

  it('handles Windows-style separators', () => {
    expect(cacheControlFor('C:\\build\\assets\\index-a1b2c3d4.js')).toBe(IMMUTABLE_CACHE_CONTROL);
  });

  it('never caches HTML, however deep', () => {
    expect(cacheControlFor('/build/index.html')).toBe(HTML_CACHE_CONTROL);
    expect(cacheControlFor('/build/pricing/index.html')).toBe(HTML_CACHE_CONTROL);
    expect(HTML_CACHE_CONTROL).toBe('no-cache');
  });

  it('does not treat a stable root file as immutable', () => {
    // robots.txt and og-image.png keep their names across deploys, so a
    // year-long immutable cache would make a correction unshippable.
    const policy = cacheControlFor('/build/robots.txt');
    expect(policy).not.toContain('immutable');
    expect(policy).toContain('max-age=3600');
  });

  it('does not mistake a non-asset path containing the word assets', () => {
    expect(cacheControlFor('/build/my-assets-guide.html')).toBe(HTML_CACHE_CONTROL);
  });
});

describe('web service cache headers', () => {
  const root = staticSite();

  it('serves hashed bundles as immutable', async () => {
    const app = buildApp({ staticRoot: root });
    const js = await app.inject({ method: 'GET', url: '/assets/index-a1b2c3d4.js' });
    expect(js.statusCode).toBe(200);
    expect(js.headers['cache-control']).toBe(IMMUTABLE_CACHE_CONTROL);

    const css = await app.inject({ method: 'GET', url: '/assets/index-e5f6a7b8.css' });
    expect(css.headers['cache-control']).toBe(IMMUTABLE_CACHE_CONTROL);
    await app.close();
  });

  it('serves the SPA shell with no-cache', async () => {
    const app = buildApp({ staticRoot: root });
    const res = await app.inject({ method: 'GET', url: '/' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe(HTML_CACHE_CONTROL);
    await app.close();
  });

  it('serves a client-side route fallback with no-cache', async () => {
    const app = buildApp({ staticRoot: root });
    const res = await app.inject({ method: 'GET', url: '/valuations/01ARZ3NDEKTSV4RRFFQ69G5FAV' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe(HTML_CACHE_CONTROL);
    await app.close();
  });

  it('serves a prerendered marketing page with no-cache', async () => {
    const app = buildApp({ staticRoot: root });
    const res = await app.inject({ method: 'GET', url: '/pricing' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('PRERENDERED');
    expect(res.headers['cache-control']).toBe(HTML_CACHE_CONTROL);
    await app.close();
  });
});
