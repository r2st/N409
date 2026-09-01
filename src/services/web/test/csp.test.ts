import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
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
  /**
   * An empty hash set is served, and until R305 nothing said so (M11).
   *
   * The CSP goes out either way. Every inline script in the built documents is
   * then blocked by the browser, which reports it as a console message on the
   * visitor's machine and nowhere else — the site works, the theme resolver
   * does not run, and the flash of the wrong theme this directive exists to
   * prevent is back on every cold load, silently.
   *
   * The two causes are said apart because they are different faults: no
   * documents at all means the static root is missing or the build did not
   * land, and everything else served from that directory is broken too;
   * documents with no inline script is a frontend change.
   */
  const capture = () => {
    const lines: Array<{ fields: Record<string, unknown>; message: string }> = [];
    return {
      lines,
      log: {
        warn: (fields: Record<string, unknown>, message: string) => lines.push({ fields, message }),
      },
    };
  };

  it('says so when a static root that exists yields no hashes', () => {
    const { lines, log } = capture();
    const root = rootWith({ 'index.html': '<!doctype html><script src="/assets/main.js"></script>' });
    expect(inlineScriptHashes(root, log)).toEqual([]);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.message).toMatch(/any inline script in the built documents will be blocked/);
    expect(lines[0]!.fields.documents).toBe(1);
  });

  it('says a different thing when there are no documents at all', () => {
    const { lines, log } = capture();
    const root = rootWith({});
    expect(inlineScriptHashes(root, log)).toEqual([]);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.message).toMatch(/nothing to serve/);
    expect(lines[0]!.fields.documents).toBe(0);
  });

  it('says nothing when it found hashes', () => {
    // The vacuity guard. A warning on every boot is a warning nobody reads.
    const { lines, log } = capture();
    const root = rootWith({ 'index.html': '<!doctype html><script>var t = 1;</script>' });
    expect(inlineScriptHashes(root, log)).toHaveLength(1);
    expect(lines).toEqual([]);
  });

  /**
   * R340, methodology M5 — the half the vacuity guard above cannot see.
   *
   * A document that cannot be read contributes no hashes, so every inline
   * script on that page is blocked by the browser and reported nowhere but the
   * visitor's console. With any other document's hashes present the count is
   * nonzero and the `hashes.size === 0` warning never fires, so the outcome the
   * warning exists for is reached one file at a time in silence.
   */
  /**
   * chmod does not stop root, and a suite run as root would otherwise fail
   * these two rather than skip them. `unreadable` reports whether the mode
   * actually took.
   */
  const unreadable = (dir: string): boolean => {
    try {
      readdirSync(dir);
      return false;
    } catch {
      return true;
    }
  };
  const fileUnreadable = (file: string): boolean => {
    try {
      readFileSync(file);
      return false;
    } catch {
      return true;
    }
  };

  it('says which document it could not read, and keeps the rest', () => {
    const { lines, log } = capture();
    const root = rootWith({
      'index.html': '<!doctype html><script>var t = 1;</script>',
      'unreadable.html': '<!doctype html><script>var u = 2;</script>',
    });
    const target = path.join(root, 'unreadable.html');
    chmodSync(target, 0o000);
    try {
      if (!fileUnreadable(target)) return; // running as root

      // The readable document still contributes; the CSP is partial, not absent.
      expect(inlineScriptHashes(root, log)).toEqual([sha256('var t = 1;')]);
      expect(lines).toHaveLength(1);
      expect(lines[0]!.message).toMatch(/inline scripts will be blocked by the CSP/);
      expect(String(lines[0]!.fields.file)).toContain('unreadable.html');
    } finally {
      chmodSync(path.join(root, 'unreadable.html'), 0o644);
    }
  });

  it('says which directory it could not list', () => {
    const { lines, log } = capture();
    const root = rootWith({ 'index.html': '<!doctype html><script>var t = 1;</script>' });
    const sub = path.join(root, 'help');
    mkdirSync(sub);
    writeFileSync(path.join(sub, 'a.html'), '<!doctype html><script>var v = 3;</script>');
    chmodSync(sub, 0o000);
    try {
      if (!unreadable(sub)) return; // running as root

      // A whole subtree gone, and the root's own hash keeps the count nonzero.
      expect(inlineScriptHashes(root, log)).toEqual([sha256('var t = 1;')]);
      expect(lines).toHaveLength(1);
      expect(lines[0]!.message).toMatch(/could not list a directory/);
      expect(String(lines[0]!.fields.dir)).toContain('help');
    } finally {
      chmodSync(sub, 0o755);
    }
  });

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
      'index.html': '<!doctype html><script type="application/ld+json">{"@type":"Organization"}</script>',
    });
    expect(inlineScriptHashes(root)).toEqual([]);
  });

  it('hashes type="module" and JavaScript MIME types', () => {
    const root = rootWith({
      'a.html': '<!doctype html><script type="module">export const a = 1;</script>',
      'b.html': '<!doctype html><script type="text/javascript">var b = 2;</script>',
    });
    expect(inlineScriptHashes(root)).toEqual([sha256('export const a = 1;'), sha256('var b = 2;')].sort());
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
  const dist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../web-frontend/dist');
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
