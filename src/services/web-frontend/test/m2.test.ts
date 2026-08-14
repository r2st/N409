import { describe, expect, it } from 'vitest';
import { expectSubQuadratic } from './support/complexity.js';
import { formatWorkbookValue, sanitizeHtml, REPORT_VISIBLE_STATES } from '../src/lib/m2';

describe('sanitizeHtml (client mirror)', () => {
  it('keeps whitelisted tags and strips attributes', () => {
    expect(sanitizeHtml('<p style="x" onclick="evil()">a <strong class="y">b</strong></p>')).toBe(
      '<p>a <strong>b</strong></p>',
    );
  });

  it('removes script/style with content and drops unknown tags', () => {
    expect(sanitizeHtml('<script>alert(1)</script><div>text</div>')).toBe('text');
    expect(sanitizeHtml('<img src=x onerror=alert(1)>ok')).toBe('ok');
  });

  it('normalizes br', () => {
    expect(sanitizeHtml('a<br />b')).toBe('a<br>b');
  });

  it('leaves an unterminated comment or raw-text element where it stands', () => {
    expect(sanitizeHtml('a<!--b<p>c')).toBe('a<!--b<p>c');
    expect(sanitizeHtml('<p>ok</p><script>alert(1)')).toBe('<p>ok</p>alert(1)');
    expect(sanitizeHtml('<script>a<style>b</style>c')).toBe('ac');
  });

  it('sanitizes markers that are never closed in linear time', () => {
    // ReportTab sanitizes each section on every render, so a stored section of
    // `<!--` froze the tab of everyone who opened the report — not just the
    // author who saved it. What is asserted is the exponent rather than a
    // wall-clock ceiling: the ceiling was a property of the CI box, and it
    // flaked accordingly.
    for (const marker of ['<!--', '<script>', '<style>']) {
      expectSubQuadratic({
        input: (chars) => marker.repeat(Math.ceil(chars / marker.length)),
        run: sanitizeHtml,
        size: 25_000,
      });
    }
  });
});

describe('formatWorkbookValue', () => {
  it('formats currency, number, percent and null', () => {
    expect(formatWorkbookValue(null, 'currency')).toBe('—');
    expect(formatWorkbookValue(5100000, 'currency')).toBe(
      (5100000).toLocaleString(undefined, { maximumFractionDigits: 0 }),
    );
    expect(formatWorkbookValue(0.6667, 'percent')).toBe(
      `${(66.67).toLocaleString(undefined, { maximumFractionDigits: 1 })}%`,
    );
    expect(formatWorkbookValue(6.5, 'number')).toBe(
      (6.5).toLocaleString(undefined, { maximumFractionDigits: 2 }),
    );
  });
});

describe('REPORT_VISIBLE_STATES', () => {
  it('matches the server policy states', () => {
    expect([...REPORT_VISIBLE_STATES].sort()).toEqual(['draft_accepted', 'drafted', 'published']);
  });
});

/**
 * Input shapes that used to make the sanitizer quadratic.
 *
 * Both regexes it was built from ended in `[^>]*>`, so on input with no `>` in
 * it the engine ran to the end of the document from every `<`, failed,
 * backtracked the whole way, and started again one character along. 12.5k
 * characters of `"<p"` cost 36ms, 25k 140ms, 50k 567ms and 100k 2.27s — a clean
 * 4x per doubling — against 3ms for ordinary editor HTML of the same size, with
 * 100,000 the per-section limit `reports.ts` already allows.
 *
 * The budgets below are set an order of magnitude under the quadratic timings
 * and two orders above what the scan needs, so they fail on a return of the
 * exponent rather than on a slow machine.
 */
describe('sanitizeHtml on input with no closing bracket', () => {
  it('sanitizes a section-sized run of unterminated tags in linear time', () => {
    expectSubQuadratic({ input: (n) => '<p'.repeat(n / 2), run: sanitizeHtml, size: 25_000 });
  });

  it('sanitizes a section-sized run of junk leads in linear time', () => {
    // `"<3"` exercises the second regex, the junk-tag sweep, which was
    // quadratic in exactly the same way and by exactly the same amount.
    expectSubQuadratic({ input: (n) => '<3'.repeat(n / 2), run: sanitizeHtml, size: 25_000 });
  });

  it('keeps the text of an unterminated tag rather than eating the rest', () => {
    expect(sanitizeHtml('<p>kept</p><p')).toBe('<p>kept</p><p');
    expect(sanitizeHtml('5 < 6')).toBe('5 < 6');
  });

  it('leaves a bare "<>" alone — it was never a junk tag', () => {
    expect(sanitizeHtml('text<><')).toBe('text<><');
    expect(sanitizeHtml('><>')).toBe('><>');
  });

  it('keeps text in front of a dropped tag when the "<" before it never closed', () => {
    // The junk sweep runs over what the whitelist pass *left*: the `>` that
    // would have closed `<3` was consumed with the `<img>`, so `<3` is text.
    expect(sanitizeHtml('<3<img src=x onerror=y>')).toBe('<3');
    expect(sanitizeHtml('<3<svg>')).toBe('<3');
  });

  it('still strips everything it stripped before', () => {
    expect(sanitizeHtml('<p>ok</p><script>alert(1)</script>')).toBe('<p>ok</p>');
    expect(sanitizeHtml('<img src=x onerror=alert(1)>text')).toBe('text');
    expect(sanitizeHtml('<3 onerror=alert(1)>text')).toBe('text');
    expect(sanitizeHtml('<a href="javascript:alert(1)">x</a>')).toBe('<a>x</a>');
    expect(sanitizeHtml('<a href="https://ok.example">x</a>')).toBe('<a href="https://ok.example">x</a>');
    expect(sanitizeHtml('<p onclick="boom()">x</p>')).toBe('<p>x</p>');
  });

  // Kept in step with the server policy in valuation/src/domain/report.ts: a
  // blog article has to be able to link to /pricing, and a protocol-relative
  // URL is the off-site link that a naive relative-path rule would admit.
  it('keeps a site-relative href and rejects a protocol-relative one', () => {
    expect(sanitizeHtml('<a href="/pricing">x</a>')).toBe('<a href="/pricing">x</a>');
    expect(sanitizeHtml('<a href="//evil.example/x">x</a>')).toBe('<a>x</a>');
    expect(sanitizeHtml('<a href="pricing">x</a>')).toBe('<a>x</a>');
  });
});
