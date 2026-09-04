import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { optionalText } from '../../src/domain/optionalText.js';
import { sourceFiles } from '../support/sourceFiles.js';

/**
 * The four person-profile columns, and the five doors that write them.
 *
 * `blankLabelCensus` is the sweep for a *required* label and it exempts a
 * field with no floor on a stated premise: "`''` and `'   '` are the same
 * answer there". This file is that premise being false for one family of
 * fields, and the doors being brought back into agreement.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '../../src');

describe('the display-name idiom these columns are read through', () => {
  /** `routes/stream.ts`, `routes/savedViews.ts`, `repos/firmDashboard.ts` ×2. */
  const display = (first: string | null, last: string | null, email: string) =>
    [first, last].filter(Boolean).join(' ') || email;

  it('falls back to the address for a NULL name', () => {
    expect(display(null, null, 'ada@acme.com')).toBe('ada@acme.com');
  });

  it('falls back to the address for an empty string too', () => {
    expect(display('', '', 'ada@acme.com')).toBe('ada@acme.com');
  });

  it('does NOT fall back for whitespace — the two blanks differ here', () => {
    expect(display('   ', '   ', 'ada@acme.com')).not.toBe('ada@acme.com');
    expect(display('   ', '   ', 'ada@acme.com').trim()).toBe('');
  });
});

describe('domain/optionalText', () => {
  const schema = optionalText(100);

  it('stores NULL for every spelling of a cleared field', () => {
    for (const blank of [null, '', '   ', '\t', '\n  \n', ' ']) {
      const parsed = schema.safeParse(blank);
      expect(parsed.success, JSON.stringify(blank)).toBe(true);
      if (parsed.success) expect(parsed.data, JSON.stringify(blank)).toBeNull();
    }
  });

  it('keeps a real name, trimmed', () => {
    expect(schema.parse('  Ada Lovelace  ')).toBe('Ada Lovelace');
  });

  /**
   * The bound is counted after the trim, as `routes/account.ts` has always
   * counted it: a name at the ceiling with a trailing space is not over it.
   */
  it('counts the bound after trimming', () => {
    expect(schema.parse(`${'a'.repeat(100)}  `)).toHaveLength(100);
    expect(schema.safeParse('a'.repeat(101)).success).toBe(false);
  });
});

/**
 * Every writer of `first_name` / `last_name` / `job_title` / `company_name`,
 * held to "the blank is normalised or refused, by name".
 *
 * Scanned rather than listed, because the point of the round was that one of
 * five doors had drifted and nothing said so. Each entry names what handles it
 * so a reviewer can go and read that instead of trusting this comment.
 */
const NORMALISERS = [
  'optionalText(', // trims, stores NULL for a blank
  'nonBlankText(', // refuses a whitespace-only value outright
  '.trim()', // rewrites the blank before any floor or reader sees it
];

const PROFILE_COLUMNS = ['first_name', 'last_name', 'job_title', 'company_name'];

interface Site {
  file: string;
  line: number;
  text: string;
}

/** A profile column declared as a zod field in a request schema. */
function schemaSites(): Site[] {
  const found: Site[] = [];
  const key = new RegExp(`^\\s*(${PROFILE_COLUMNS.join('|')})\\s*:\\s*(.+)$`);
  for (const file of sourceFiles(SRC)) {
    const rel = path.relative(SRC, file).split(path.sep).join('/');
    // Inputs only. `domain/partnerApiContract.ts` declares the *response*
    // shapes the published OpenAPI is generated from; nothing is parsed
    // against them, so a bound there normalises nothing and needs to.
    if (!rel.startsWith('routes/')) continue;
    readFileSync(file, 'utf8')
      .split('\n')
      .forEach((text, i) => {
        const trimmed = text.trim();
        if (trimmed.startsWith('*') || trimmed.startsWith('//')) return;
        const m = key.exec(text);
        if (!m) return;
        // Only declarations, not the object literals that carry the value on.
        if (!/\bz\.|nonBlankText\(|optionalText\(|OptionalText\(/.test(m[2]!)) return;
        found.push({ file: rel, line: i + 1, text: trimmed });
      });
  }
  return found;
}

describe('every door onto a profile column normalises the blank', () => {
  const sites = schemaSites();

  it('is looking at a population, not at nothing', () => {
    expect(sites.length).toBeGreaterThanOrEqual(6);
    expect(sites.map((s) => s.file)).toContain('routes/adminUsers.ts');
    expect(sites.map((s) => s.file)).toContain('routes/account.ts');
  });

  it('leaves no profile field on a bare z.string()', () => {
    const offenders = sites
      .filter((s) => !NORMALISERS.some((n) => s.text.includes(n)))
      .map((s) => `${s.file}:${s.line}  ${s.text}`);
    expect(
      offenders,
      `a profile name stored as sent keeps '   ', which the display-name idiom ` +
        `reads as a name rather than as nothing:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });

  it('has one definition of the optional spelling, not two', () => {
    const local = sites.filter((s) => s.text.includes('OptionalText('));
    expect(local, `use optionalText from domain/optionalText.js`).toEqual([]);
  });
});
