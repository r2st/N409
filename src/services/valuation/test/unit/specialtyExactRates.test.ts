/**
 * The specialty schedules state a derivable rate exactly, like the 409A ones.
 *
 * Every specialty exhibit that concludes a value does it by stepping through
 * rates — a level-of-value ladder, a gift bridge, a UMV-to-AMV table, a
 * capitalization division — and each step prints the rate next to the amount it
 * produced. Rounded to a tenth of a point those two disagree: the ESOP sample's
 * DLOC is 1 − 1/1.22, and at "18.0%" the reader recomputing the row beneath it
 * lands $20,328 away from the figure printed there.
 *
 * `reportSummary.formatExactPercent` is the rule the 409A deliverable adopted
 * for exactly this; the specialty side reaches it through `exactPct`. This
 * fixes which fields must go through it, so the next derivation rate added to
 * one of these tables is a failure here rather than a schedule a reviewer
 * cannot reproduce.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { formatExactPercent } from '../../src/domain/reportSummary.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SOURCE = readFileSync(path.resolve(HERE, '../../src/domain/specialtyExhibits.ts'), 'utf8');

/**
 * Fields whose printed rate an amount on the same schedule is derived from.
 *
 * Weights are deliberately absent: a weight is read rather than multiplied
 * through, and the 409A exhibits state those at whole points for the same
 * reason. So are `exclusion_percentage` and `cumulative_pct`, which are
 * statutory or descriptive percentages nothing on the page divides by.
 */
const DERIVABLE = [
  'dloc',
  'dlom',
  'effective_discount',
  'minority_discount',
  'restriction_discount',
  'cap_rate',
  'discount_rate',
  'long_term_growth',
];

/**
 * Rates that name a derivable field and are still read rather than multiplied.
 *
 * The PPA allocation's rate column is the WACC/IRR/WARA reconciliation input —
 * stated so a reviewer can compare it against the acquirer's cost of capital,
 * with nothing on that table derived from it.
 */
const READ_ONLY = ['pct(record(i.assumptions)?.discount_rate)'];

/**
 * `pct(...)` calls, tolerating one level of nested parentheses.
 *
 * The flat `[^()]*` form is what a first draft reaches for and it is blind to
 * exactly the arguments most likely to hold a rate — `pct(record(x)?.rate)` —
 * so a call it cannot parse would have read as a call that is not there.
 */
function pctCalls(text: string): string[] {
  return [...text.matchAll(/\bpct\(((?:[^()]|\([^()]*\))*)\)/g)].map((m) => (m[1] ?? '').trim());
}

describe('specialty exhibits state a derivable rate at the precision it was applied', () => {
  it('is reading the file it thinks it is', () => {
    expect(SOURCE).toContain('function exactPct(');
    expect(SOURCE).toContain('function pct(');
  });

  it('sees the nested-argument calls a flat matcher would miss', () => {
    expect(pctCalls('x = pct(record(i.assumptions)?.discount_rate)')).toEqual([
      'record(i.assumptions)?.discount_rate',
    ]);
    expect(pctCalls(SOURCE).length).toBeGreaterThan(8);
  });

  it('hands every derivable rate to exactPct and none of them to pct', () => {
    const rounded: string[] = [];
    for (const arg of pctCalls(SOURCE)) {
      if (READ_ONLY.includes(`pct(${arg})`)) continue;
      const hit = DERIVABLE.find((field) => new RegExp(`\\.${field}\\b`).test(arg));
      if (hit) rounded.push(`${hit}: pct(${arg})`);
    }
    expect(rounded).toEqual([]);
  });

  it('has not left an exemption standing for a call that is gone', () => {
    // An allowlist entry outliving its call site silently widens the rule.
    const calls = pctCalls(SOURCE).map((a) => `pct(${a})`);
    expect(READ_ONLY.filter((entry) => !calls.includes(entry))).toEqual([]);
  });

  it('still rounds the rates that are read rather than multiplied', () => {
    // The rule is narrow on purpose. If weights had been swept along with it,
    // three equal indications would print "33.3333%" three times.
    expect(SOURCE).toContain('pct(weights[key], 0)');
  });

  it('would catch the pattern it is looking for', () => {
    const broken = "['Less discount for lack of control', pct(specialty.dloc) ?? '—']";
    const found = pctCalls(broken).some((arg) => DERIVABLE.some((f) => new RegExp(`\\.${f}\\b`).test(arg)));
    expect(found).toBe(true);
    // And the difference it makes on the sample that named it.
    expect(formatExactPercent(0.180327868852459)).toBe('18.0328%');
  });
});
