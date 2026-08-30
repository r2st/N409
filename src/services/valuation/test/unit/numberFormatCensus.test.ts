import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { numberFormat } from '../../src/domain/numberFormat.js';
import { formatCurrency } from '../../src/domain/reportSummary.js';
import { sourceFiles } from '../support/sourceFiles.js';

/**
 * A formatter built where a value is formatted, rather than where the module
 * is loaded.
 *
 * `new Intl.NumberFormat(...)` resolves a locale, loads the numbering data and
 * compiles a pattern; `.format(n)` on an existing one is a few hundred
 * nanoseconds. The ratio between them is about a hundred to one, which is
 * invisible on a dashboard cell and decisive on a report: the schedules behind
 * the largest cap table this platform stores called `formatCurrency` thousands
 * of times to build four exhibits, and **three quarters of the whole
 * assembly** was spent inside the constructor — 26.6ms of it, on the valuation
 * service's event loop, before the render was even handed to the report
 * service. Memoising the formatters took the same four exhibits to 1.9ms,
 * byte-for-byte identical.
 *
 * Twelve modules in this service had already noticed and hoisted a module-level
 * `const INT = new Intl.NumberFormat('en-US')`. The ones that could not hoist
 * are exactly the ones that take a *parameter* — a currency code from the
 * engagement, a digit count from the caller — and those are the money
 * formatters, which is to say the hot ones. `domain/numberFormat.ts` is where
 * a parameterised formatter comes from now.
 *
 * So the rule this holds is positional, and deliberately crude: a
 * `new Intl.NumberFormat(` at the left margin is a module-level constant, built
 * once when the module loads, and is fine. An indented one is inside a function
 * — built once per call, however many times that is — and should come from
 * `numberFormat` instead. The crudeness is the point: it needs no parser, it
 * cannot be fooled by a rename, and the shape it describes is the shape that
 * costs.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** The `src/` tree: this file sits at `src/services/valuation/test/unit`. */
const SRC = path.resolve(HERE, '../../../..');

/**
 * The server trees. `services/web-frontend` is absent for the reason
 * `hostLocaleCensus` leaves it out — the browser formats for one reader at a
 * time, and a component rebuilding a formatter per render is React's problem
 * rather than this rule's.
 */
const ROOTS = ['services/valuation/src', 'services/web/src', 'services/report/src', 'packages'];

const isBuildOutput = (file: string): boolean => file.split(path.sep).includes('dist');

/**
 * The memo itself, which is where the one surviving indented constructor lives
 * and has to. Named rather than pattern-excluded so a second exemption has to
 * be argued for here.
 */
const MEMO = 'services/valuation/src/domain/numberFormat.ts';

/** Indented — i.e. inside something, which for a formatter means inside a call. */
const PER_CALL_FORMATTER = /^\s+.*\bnew Intl\.NumberFormat\(/;

const isProse = (line: string): boolean => /^(\/\/|\/\*|\*)/.test(line.trim());

interface Hit {
  file: string;
  line: number;
  text: string;
}

function perCallFormatters(): Hit[] {
  const hits: Hit[] = [];
  for (const root of ROOTS) {
    for (const file of sourceFiles(path.join(SRC, root))) {
      if (isBuildOutput(file)) continue;
      const rel = path.relative(SRC, file).split(path.sep).join('/');
      if (rel === MEMO) continue;
      readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          if (isProse(line)) return;
          if (PER_CALL_FORMATTER.test(line)) hits.push({ file: rel, line: i + 1, text: line.trim() });
        });
    }
  }
  return hits;
}

describe('an Intl formatter is built once, not once per value', () => {
  it('scans every tree it claims to', () => {
    for (const root of ROOTS) expect(existsSync(path.join(SRC, root)), root).toBe(true);
    // The exemption has to name a file that exists, or it is silently doing
    // nothing and the memo could have been deleted underneath it.
    expect(existsSync(path.join(SRC, MEMO)), MEMO).toBe(true);
  });

  it('builds no number formatter inside a function', () => {
    // The fix is `numberFormat(locale, options)` from `domain/numberFormat.ts`,
    // which memoises on exactly those two arguments. A formatter that genuinely
    // has to be constructed per call — none does today — belongs at the margin
    // with a note saying why.
    expect(perCallFormatters()).toEqual([]);
  });

  it('still recognises both spellings it is looking for', () => {
    // The vacuity guard: the assertion above passes for a pattern that has
    // stopped matching anything at all.
    for (const form of [
      "  const f = new Intl.NumberFormat('en-US');",
      "    return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(v);",
      "\tconst int = (v: number) => new Intl.NumberFormat('en-US').format(v);",
    ]) {
      expect(PER_CALL_FORMATTER.test(form), form).toBe(true);
    }
    // …and does not condemn the module-level constants it exists to allow.
    for (const form of [
      "const INT = new Intl.NumberFormat('en-US');",
      "const FRACTIONAL_SHARES = new Intl.NumberFormat('en-US', { maximumFractionDigits: 4 });",
    ]) {
      expect(PER_CALL_FORMATTER.test(form), form).toBe(false);
    }
  });
});

describe('the memo hands back the same formatter and the same string', () => {
  it('returns one instance per locale-and-options pair', () => {
    const a = numberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });
    const b = numberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });
    expect(a).toBe(b);
    // Options are part of the identity, or a four-decimal per-share figure
    // would be served the two-decimal formatter built for the money column.
    expect(numberFormat('en-US', { maximumFractionDigits: 4 })).not.toBe(numberFormat('en-US'));
    expect(numberFormat('en-GB')).not.toBe(numberFormat('en-US'));
  });

  it('formats what the un-memoised constructor formatted', () => {
    for (const [value, currency, digits] of [
      [1234.5678, 'USD', 4],
      [1234.5678, 'USD', 2],
      [-987654.321, 'EUR', 2],
      [0, 'GBP', 4],
    ] as const) {
      expect(formatCurrency(value, currency, digits)).toBe(
        new Intl.NumberFormat('en-US', {
          style: 'currency',
          currency,
          minimumFractionDigits: digits,
          maximumFractionDigits: digits,
        }).format(value),
      );
    }
  });

  it('leaves an unusable currency code throwing, so its caller still catches it', () => {
    // `formatCurrency` falls back to `CODE 1.23` for a code `Intl` refuses, and
    // it can only do that if the memo re-throws rather than caching a failure.
    expect(() => numberFormat('en-US', { style: 'currency', currency: 'nope' })).toThrow();
    expect(formatCurrency(1.23, 'nope', 2)).toBe('nope 1.23');
  });
});
