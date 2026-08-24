import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildApp, looksLikeAssetRequest } from '../src/app.js';

/**
 * A missing file must answer "missing".
 *
 * The SPA fallback used to serve `index.html` — as `text/html`, under a 200 —
 * for every path the static plugin did not claim, files included. Two things
 * came out of that, and the second one is the one nobody sees.
 */
const root = mkdtempSync(path.join(tmpdir(), 'n409-assets-'));
writeFileSync(path.join(root, 'index.html'), '<!doctype html><title>N409</title>SPA-SHELL');
writeFileSync(path.join(root, 'robots.txt'), 'User-agent: *');
mkdirSync(path.join(root, 'assets'), { recursive: true });
writeFileSync(path.join(root, 'assets', 'index-NEWHASH.js'), 'export default 1;');

mkdirSync(path.join(root, 'pricing'), { recursive: true });
writeFileSync(path.join(root, 'pricing', 'index.html'), '<!doctype html>PRICING');
writeFileSync(
  path.join(root, 'prerender-manifest.json'),
  JSON.stringify({ routes: { '/pricing': 'pricing/index.html' } }),
);

describe('a request for a file that is not there', () => {
  /**
   * Vite fingerprints its chunks and empties `dist/` before writing, so the
   * instant a deploy lands every hashed URL the previous build named is gone.
   * A tab that was already open navigates to a lazy route, asks for its old
   * chunk, and used to be handed the HTML shell with a 200: the browser refuses
   * the module on its MIME type, the dynamic import rejects, and `React.lazy`
   * caches that rejection for the life of the page — so the boundary's "Try
   * again" could never succeed. The tab was bricked until someone reloaded.
   */
  it('404s a hashed chunk from a previous build instead of serving the shell', async () => {
    const app = buildApp({ staticRoot: root });
    const res = await app.inject({ method: 'GET', url: '/assets/DashboardPage-OLDHASH.js' });
    expect(res.statusCode).toBe(404);
    expect(res.headers['content-type']).not.toContain('text/html');
    expect(res.body).not.toContain('SPA-SHELL');
    await app.close();
  });

  /**
   * The quieter half, and the one that outlives the tab: a missing font, image,
   * stylesheet or manifest answered "success", so a half-built or half-shipped
   * `dist/` looked perfectly healthy to a CDN, an uptime check, and anything
   * reading the access log.
   */
  it.each([
    '/favicon.ico',
    '/og-image.png',
    '/assets/brand-OLD.css',
    '/fonts/inter.woff2',
    '/site.webmanifest',
  ])('does not report success for a missing %s', async (url) => {
    const app = buildApp({ staticRoot: root });
    const res = await app.inject({ method: 'GET', url });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('still serves files that are actually there', async () => {
    const app = buildApp({ staticRoot: root });
    const js = await app.inject({ method: 'GET', url: '/assets/index-NEWHASH.js' });
    expect(js.statusCode).toBe(200);
    const txt = await app.inject({ method: 'GET', url: '/robots.txt' });
    expect(txt.statusCode).toBe(200);
    expect(txt.body).toContain('User-agent');
    await app.close();
  });
});

describe('client-side routes are untouched by the rule', () => {
  it.each([
    '/',
    '/valuations/01ARZ3NDEKTSV4RRFFQ69G5FAV',
    '/valuations/01ARZ3NDEKTSV4RRFFQ69G5FAV/workbook',
    '/compare/carta-vs-pulley',
    '/blog/what-is-a-409a',
    '/dashboard?tab=open',
  ])('serves the shell for %s', async (url) => {
    const app = buildApp({ staticRoot: root });
    const res = await app.inject({ method: 'GET', url });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('SPA-SHELL');
    await app.close();
  });

  /**
   * The manifest is consulted first, so a prerendered route keeps winning even
   * if one ever grows something the extension test would read as a filename.
   */
  it('serves the prerendered document for a route in the manifest', async () => {
    const app = buildApp({ staticRoot: root });
    const res = await app.inject({ method: 'GET', url: '/pricing' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('PRICING');
    await app.close();
  });
});

describe('looksLikeAssetRequest', () => {
  it.each([
    '/assets/index-abc123.js',
    '/assets/style-abc123.css',
    '/favicon.ico',
    '/fonts/inter-latin.woff2',
    '/sw.js',
    '/assets/logo.svg?v=2',
    '/robots.txt#top',
  ])('reads %s as a file', (url) => expect(looksLikeAssetRequest(url)).toBe(true));

  it.each([
    '/',
    '/pricing',
    '/pricing/',
    '/valuations/01ARZ3NDEKTSV4RRFFQ69G5FAV',
    '/compare/carta-vs-pulley',
    // A dot inside an earlier segment is not a filename — only the last segment
    // decides, or a route like this would start 404ing.
    '/blog/v1.2-release-notes/comments',
    '/search?q=file.pdf',
  ])('reads %s as a route', (url) => expect(looksLikeAssetRequest(url)).toBe(false));
});
