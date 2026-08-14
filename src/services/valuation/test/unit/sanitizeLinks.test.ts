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
