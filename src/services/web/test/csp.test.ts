import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildApp, inlineScriptHashes } from '../src/app.js';

const sha256 = (body: string): string =>
  `'sha256-${createHash('sha256').update(body, 'utf8').digest('base64')}'`;

/** Executable inline scripts in a document, as CSP would judge them. */
function executableInlineScripts(html: string): string[] {
  const bodies: string[] = [];
  for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    const attrs = match[1] ?? '';
    if (/\bsrc\s*=/i.test(attrs)) continue;
    const type = /\btype\s*=\s*["']?([^"'\s>]+)/i.exec(attrs)?.[1];
    if (type && type !== 'module' && !/^(text|application)\/(java|ecma)script$/i.test(type)) continue;
    bodies.push(match[2] ?? '');
  }
  return bodies;
}

const scriptSrcOf = (csp: string): string =>
  csp.split(';').find((directive) => directive.trim().startsWith('script-src')) ?? '';

function rootWith(files: Record<string, string>): string {
  const root = mkdtempSync(path.join(tmpdir(), 'n409-csp-'));
  for (const [name, body] of Object.entries(files)) {
    const full = path.join(root, name);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, body);
  }
  return root;
}

describe('inlineScriptHashes', () => {
  it('hashes an executable inline script', () => {
    const script = 'document.documentElement.setAttribute("data-theme","dark");';
    const root = rootWith({ 'index.html': `<!doctype html><head><script>${script}</script></head>` });
    expect(inlineScriptHashes(root)).toEqual([sha256(script)]);
  });

  it('ignores external scripts — a src is governed by its URL, not a hash', () => {
    const root = rootWith({
      'index.html': '<!doctype html><script src="/assets/main-abc123.js"></script>',
    });
    expect(inlineScriptHashes(root)).toEqual([]);
  });

  it('ignores application/ld+json — data blocks are never executed', () => {
    const root = rootWith({
      'index.html':
        '<!doctype html><script type="application/ld+json">{"@type":"Organization"}</script>',
    });
    expect(inlineScriptHashes(root)).toEqual([]);
  });

  it('hashes type="module" and JavaScript MIME types', () => {
    const root = rootWith({
      'a.html': '<!doctype html><script type="module">export const a = 1;</script>',
      'b.html': '<!doctype html><script type="text/javascript">var b = 2;</script>',
    });
    expect(inlineScriptHashes(root)).toEqual(
      [sha256('export const a = 1;'), sha256('var b = 2;')].sort(),
    );
  });

  it('walks prerendered subdirectories, deduplicating the shared script', () => {
    const shared = '<script>var t = 1;</script>';
    const root = rootWith({
      'index.html': `<!doctype html>${shared}`,
      'pricing/index.html': `<!doctype html>${shared}`,
      'compare/carta/index.html': `<!doctype html>${shared}<script>var u = 2;</script>`,
    });
    expect(inlineScriptHashes(root)).toEqual([sha256('var t = 1;'), sha256('var u = 2;')].sort());
  });

  it('is byte-stable across calls, so the served header is cacheable', () => {
    const root = rootWith({
      'index.html': '<!doctype html><script>var a = 1;</script>',
      'b/index.html': '<!doctype html><script>var b = 2;</script>',
      'c/index.html': '<!doctype html><script>var c = 3;</script>',
    });
    expect(inlineScriptHashes(root)).toEqual(inlineScriptHashes(root));
  });

  it('returns nothing for a missing directory rather than throwing', () => {
    expect(inlineScriptHashes(path.join(tmpdir(), `n409-absent-${randomUUID()}`))).toEqual([]);
  });
});

describe('served CSP admits the documents actually served', () => {
  it('permits the inline theme script instead of blocking it', async () => {
    const script = "document.documentElement.setAttribute('data-theme','dark');";
    const root = rootWith({ 'index.html': `<!doctype html><head><script>${script}</script></head>` });
    const app = buildApp({ staticRoot: root });
    const res = await app.inject({ method: 'GET', url: '/' });

    expect(scriptSrcOf(String(res.headers['content-security-policy']))).toContain(sha256(script));
    await app.close();
  });

  /**
   * The load-bearing one. Anything the service serves as HTML has to be
   * executable under the header the service serves with it — checked against
   * the response body rather than against a pinned constant, so editing the
   * theme script cannot silently reintroduce the block it was written to avoid.
   */
  it('admits every executable inline script in the response body', async () => {
    const root = rootWith({
      'index.html':
        '<!doctype html><head><script>var theme = 1;</script>' +
        '<script type="application/ld+json">{"@type":"WebSite"}</script>' +
        '<script src="/assets/main.js"></script></head>',
    });
    const app = buildApp({ staticRoot: root });
    const res = await app.inject({ method: 'GET', url: '/' });
    const scriptSrc = scriptSrcOf(String(res.headers['content-security-policy']));

    const inline = executableInlineScripts(res.body);
    expect(inline).toHaveLength(1);
    for (const body of inline) expect(scriptSrc).toContain(sha256(body));
    await app.close();
  });

  it('admits the inline script on a prerendered marketing route too', async () => {
    const script = 'var theme = 1;';
    const root = rootWith({
      'index.html': `<!doctype html><script>${script}</script>SHELL`,
      'pricing/index.html': `<!doctype html><script>${script}</script>PRICING`,
      'prerender-manifest.json': JSON.stringify({ routes: { '/pricing': 'pricing/index.html' } }),
    });
    const app = buildApp({ staticRoot: root });
    const res = await app.inject({ method: 'GET', url: '/pricing' });
    expect(res.body).toContain('PRICING');

    const scriptSrc = scriptSrcOf(String(res.headers['content-security-policy']));
    for (const body of executableInlineScripts(res.body)) expect(scriptSrc).toContain(sha256(body));
    await app.close();
  });

  it('keeps the hash allowance narrow — no unsafe-inline, no unsafe-eval', async () => {
    const root = rootWith({ 'index.html': '<!doctype html><script>var a = 1;</script>' });
    const app = buildApp({ staticRoot: root });
    const res = await app.inject({ method: 'GET', url: '/' });
    const csp = String(res.headers['content-security-policy']);

    expect(scriptSrcOf(csp)).not.toContain("'unsafe-inline'");
    expect(csp).not.toContain("'unsafe-eval'");
    // The host allowances that let consent-gated analytics load by src survive.
    expect(scriptSrcOf(csp)).toContain('https://www.googletagmanager.com');
    await app.close();
  });

  it('emits no hashes when no frontend build is present', async () => {
    const app = buildApp({ staticRoot: '/nonexistent' });
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(scriptSrcOf(String(res.headers['content-security-policy'] ?? ''))).not.toContain('sha256-');
    await app.close();
  });
});

/**
 * The BFF is the only origin a browser reaches, and it serves the SPA and
 * proxies the API under that one origin. Nothing it returns should carry a
 * CORS grant — see the matching assertion in the valuation service's
 * securityHeaders test for why the absence is load-bearing rather than
 * incidental.
 */
describe('single-origin posture', () => {
  it('answers a cross-origin request with no CORS grant at all', async () => {
    const root = rootWith({ 'index.html': '<!doctype html>SHELL' });
    const app = buildApp({ staticRoot: root });
    const res = await app.inject({
      method: 'GET',
      url: '/',
      headers: { origin: 'https://attacker.example' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
    expect(res.headers['access-control-allow-credentials']).toBeUndefined();
    await app.close();
  });

  it('denies framing, so the SPA cannot be clickjacked', async () => {
    const root = rootWith({ 'index.html': '<!doctype html>SHELL' });
    const app = buildApp({ staticRoot: root });
    const res = await app.inject({ method: 'GET', url: '/' });

    expect(String(res.headers['content-security-policy'])).toContain("frame-ancestors 'none'");
    expect(res.headers['x-frame-options']).toBe('DENY');
    await app.close();
  });
});

/**
 * Against the real build when one is present. This is what pins the production
 * document: the theme resolver in web-frontend/index.html is inline and
 * synchronous by design, and every prerendered document inherits it.
 */
describe('the built frontend', () => {
  const dist = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../web-frontend/dist',
  );
  const built = existsSync(path.join(dist, 'index.html'));

  it.skipIf(!built)('ships exactly one executable inline script, and CSP admits it', async () => {
    const app = buildApp({ staticRoot: dist });
    const res = await app.inject({ method: 'GET', url: '/' });
    const scriptSrc = scriptSrcOf(String(res.headers['content-security-policy']));

    const inline = executableInlineScripts(res.body);
    expect(inline).toHaveLength(1);
    expect(inline[0]).toContain('n409.theme');
    expect(scriptSrc).toContain(sha256(inline[0]!));
    await app.close();
  });
});
