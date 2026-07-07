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

  it('strips javascript:, data:, and relative hrefs down to a bare anchor', () => {
    expect(sanitizeHtml('<a href="javascript:alert(1)">x</a>')).toBe('<a>x</a>');
    expect(sanitizeHtml('<a href="data:text/html,evil">x</a>')).toBe('<a>x</a>');
    expect(sanitizeHtml('<a href="/local/path">x</a>')).toBe('<a>x</a>');
    expect(sanitizeHtml('<a>x</a>')).toBe('<a>x</a>');
  });

  it('escapes quotes inside a kept href', () => {
    expect(sanitizeHtml('<a href=\'https://ex.com/a"b\'>x</a>')).toBe(
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
