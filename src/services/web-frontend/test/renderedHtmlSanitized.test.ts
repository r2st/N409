import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ifMatch } from '../src/lib/api';
import { sanitizeHtml } from '../src/lib/m2';

const src = (p: string) => readFileSync(join(__dirname, '..', 'src', p), 'utf8');

/**
 * Every `dangerouslySetInnerHTML` in the app goes through `sanitizeHtml`.
 *
 * Most of these strings are already sanitized or escaped server-side, so this
 * is defence in depth rather than a live hole being closed. It is worth
 * asserting mechanically anyway: the server-side guarantee lives in a different
 * service, and "this field happens to be safe today" is exactly the kind of
 * invariant that a new field, importer or fixture quietly breaks. The grep
 * below fails the build when a new sink is added without the pass.
 */
const SINKS = [
  'components/BoardApprovalPanel.tsx',
  'pages/BoardSignPage.tsx',
  'pages/HelpPage.tsx',
  'pages/marketing/BlogPages.tsx',
  'pages/AuditorPortalPage.tsx',
  'pages/valuation/ReportTab.tsx',
];

describe('rendered HTML is sanitized at every sink', () => {
  it.each(SINKS)('%s pipes its HTML through sanitizeHtml', (file) => {
    const text = src(file);
    for (const match of text.matchAll(/dangerouslySetInnerHTML=\{\{\s*__html:\s*([^}]+)\}\}/g)) {
      expect(match[1], `${file}: ${match[1]!.trim()}`).toMatch(/sanitizeHtml\(/);
    }
  });

  /**
   * Catches a *new* file introducing an unguarded sink. The list above is only
   * a guard if something insists it stays complete.
   */
  it('has no sink outside the reviewed list', () => {
    const root = join(__dirname, '..', 'src');
    const found: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (
          /\.tsx?$/.test(entry.name) &&
          readFileSync(full, 'utf8').includes('dangerouslySetInnerHTML=')
        ) {
          found.push(full.slice(root.length + 1));
        }
      }
    };
    walk(root);
    expect(found.sort()).toEqual([...SINKS].sort());
  });
});

/**
 * The risk the extra pass introduces is stripping legitimate content, not
 * letting anything through — the board resolution is server-rendered from a
 * fixed template, and if the allowlist disagreed with that template the
 * document would silently lose its headings.
 */
describe('sanitizeHtml preserves board resolution markup', () => {
  const RESOLUTION =
    '<h1>Resolution of the Board of Directors of Acme, Inc.</h1>\n' +
    '<p><strong>Valuation date:</strong> 2026-01-31</p>\n' +
    '<h2>Methodology</h2>\n' +
    '<p>Backsolve to the Series A, with an OPM allocation.</p>';

  it('keeps every tag the server template emits', () => {
    const out = sanitizeHtml(RESOLUTION);
    for (const tag of ['<h1>', '<h2>', '<p>', '<strong>']) expect(out).toContain(tag);
    expect(out).toContain('Backsolve to the Series A');
  });

  /** Sanitizing twice must equal sanitizing once, or the second pass is a bug. */
  it('is idempotent, so a server-sanitized body is unchanged', () => {
    expect(sanitizeHtml(sanitizeHtml(RESOLUTION))).toBe(sanitizeHtml(RESOLUTION));
  });

  it('still removes script that reached the field another way', () => {
    const out = sanitizeHtml(`${RESOLUTION}<script>fetch('//evil')</script>`);
    expect(out).not.toContain('<script');
  });
});

describe('ifMatch', () => {
  it('quotes the version as an entity tag', () => {
    expect(ifMatch(7)).toEqual({ 'if-match': '"7"' });
  });

  /**
   * A payload with no version must send no header at all: `If-Match:
   * "undefined"` would be rejected as malformed and break the save outright,
   * where omitting it correctly falls back to last-write-wins.
   */
  it('sends nothing when there is no version to assert', () => {
    expect(ifMatch(undefined)).toBeUndefined();
  });
});
