import { describe, expect, it } from 'vitest';
import { sanitizeHtml } from '../../src/domain/report.js';

/** Gap 9 — links survive sanitization with a validated href only. */

describe('sanitizeHtml link support', () => {
  it('keeps http(s) and mailto hrefs, drops every other attribute', () => {
    expect(sanitizeHtml('<a href="https://ex.com/x" target="_blank" onclick="e()">docs</a>')).toBe(
      '<a href="https://ex.com/x">docs</a>',
    );
    expect(sanitizeHtml("<a href='http://ex.com'>x</a>")).toBe('<a href="http://ex.com">x</a>');
    expect(sanitizeHtml('<a href=mailto:a@b.co>mail</a>')).toBe('<a href="mailto:a@b.co">mail</a>');
  });

  it('strips javascript: and data: hrefs down to a bare anchor', () => {
    expect(sanitizeHtml('<a href="javascript:alert(1)">x</a>')).toBe('<a>x</a>');
    expect(sanitizeHtml('<a href="data:text/html,evil">x</a>')).toBe('<a>x</a>');
    expect(sanitizeHtml('<a>x</a>')).toBe('<a>x</a>');
  });

  // Blog articles link to /pricing and to the product page they are about. The
  // policy used to drop those to a bare anchor, which reads as a link, goes
  // nowhere, and tells the author nothing.
  it('keeps a site-relative href', () => {
    expect(sanitizeHtml('<a href="/pricing">x</a>')).toBe('<a href="/pricing">x</a>');
    expect(sanitizeHtml('<a href="/blog/what-is-a-409a-valuation#dlom">x</a>')).toBe(
      '<a href="/blog/what-is-a-409a-valuation#dlom">x</a>',
    );
  });

  // The one case a bare `^\/` would wave through: protocol-relative URLs are
  // off-site links that look like paths.
  it('rejects a protocol-relative href', () => {
    expect(sanitizeHtml('<a href="//evil.example/x">x</a>')).toBe('<a>x</a>');
    expect(sanitizeHtml('<a href="//evil.example">x</a>')).toBe('<a>x</a>');
  });

  // The same off-site link, spelled the way the URL parser reads rather than
  // the way the regex did. `\\` is `/` for a special scheme, and tab/LF/CR are
  // deleted before parsing — so each of these resolves to https://evil.example/
  // in every browser while starting with exactly one slash on the page.
  it('rejects a site-relative href the URL parser resolves off-site', () => {
    expect(sanitizeHtml('<a href="/\\evil.example/x">x</a>')).toBe('<a>x</a>');
    expect(sanitizeHtml('<a href="/\\\\evil.example">x</a>')).toBe('<a>x</a>');
    expect(sanitizeHtml('<a href="/\t/evil.example">x</a>')).toBe('<a>x</a>');
    expect(sanitizeHtml('<a href="/\n/evil.example">x</a>')).toBe('<a>x</a>');
    expect(sanitizeHtml('<a href="/\r/evil.example">x</a>')).toBe('<a>x</a>');
  });

  // Every one of the five above, plus the protocol-relative form and two that
  // normalise back to our own origin, put
  // through the parser they were written against. This is the assertion that
  // makes the guard falsifiable: if a spelling stops being caught, this notices
  // whether or not anyone thought to add it to the list above.
  it('admits no href that resolves to another origin', () => {
    const HOSTILE = [
      '//evil.example',
      '/\\evil.example',
      '/\\\\evil.example',
      '/\tevil.example',
      '/\t/evil.example',
      '/\n/evil.example',
      '/\r/evil.example',
      '/\t\\evil.example',
    ];
    for (const raw of HOSTILE) {
      const html = sanitizeHtml(`<a href="${raw}">x</a>`);
      const kept = /href="([^"]*)"/.exec(html)?.[1];
      const resolved = new URL(kept ?? '/', 'https://n409.app/a/b');
      expect({ raw, origin: resolved.origin }).toEqual({ raw, origin: 'https://n409.app' });
    }
  });

  // The normalisation is emitted, not merely tested against: a kept href that
  // was checked in one spelling and written in another puts the check back on
  // the wrong side of the parser.
  it('emits the href it validated', () => {
    expect(sanitizeHtml('<a href="/pri\tcing">x</a>')).toBe('<a href="/pricing">x</a>');
  });

  // Not a path at all — a relative href has to start at the site root, so a
  // bare word cannot resolve against whatever page happens to render it.
  it('rejects a document-relative href', () => {
    expect(sanitizeHtml('<a href="pricing">x</a>')).toBe('<a>x</a>');
    expect(sanitizeHtml('<a href="../admin">x</a>')).toBe('<a>x</a>');
  });

  it('escapes quotes inside a kept href', () => {
    expect(sanitizeHtml("<a href='https://ex.com/a\"b'>x</a>")).toBe(
      '<a href="https://ex.com/a&quot;b">x</a>',
    );
  });

  it('leaves the existing whitelist behaviour untouched', () => {
    expect(sanitizeHtml('<p onclick="e()">Hi <strong>there</strong></p>')).toBe(
      '<p>Hi <strong>there</strong></p>',
    );
    expect(sanitizeHtml('<p>ok</p><script>alert(1)</script>')).toBe('<p>ok</p>');
  });
});
