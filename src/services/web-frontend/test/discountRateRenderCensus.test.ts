/**
 * A concluded discount rate reads the same in the app as in the report.
 *
 * DLOM and DLOC are not decorative percentages: they are the last two steps of
 * the conclusion, and the schedule that derives the value states the rate the
 * reader is expected to multiply by. The server settled that at
 * `reportSummary.formatExactPercent` — as many decimals as the rate actually
 * has, up to four — after finding the summary page printing "31.4%" for a DLOM
 * the exhibit five pages later derived at 31.42%.
 *
 * The Calculations tab was struck at one decimal all along, so the analyst who
 * ran the calculation and the board that reads the PDF generated from that same
 * run saw two different rates. The rule is now one rule; this pins both halves
 * of it: the frontend helper agrees with the server's on the values that
 * separate them, and no surface holding a concluded rate re-rounds it locally.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { formatExactPercent } from '../src/lib/format';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '../src');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) return walk(full);
    return /\.tsx?$/.test(full) ? [full] : [];
  });
}

const FILES = walk(SRC).map((file) => ({
  file: path.relative(SRC, file).split(path.sep).join('/'),
  text: readFileSync(file, 'utf8'),
}));

/**
 * The server's rule, transcribed from `reportSummary.formatExactPercent`. Kept
 * here as an independent statement of it: if the two implementations ever
 * disagree the comparison below fails, which is the whole point of restating a
 * server rule in the browser.
 */
function serverRule(fraction: number, minDigits = 1, maxDigits = 4): string {
  const pct = fraction * 100;
  for (let d = minDigits; d < maxDigits; d += 1) {
    if (Math.abs(Number(pct.toFixed(d)) - pct) < 1e-9) return `${pct.toFixed(d)}%`;
  }
  return `${pct.toFixed(maxDigits)}%`;
}

describe('concluded discount rates render at the precision they were concluded at', () => {
  it('agrees with the server on rates a tenth of a point cannot express', () => {
    // 0.3142 is the case that named the defect; the rest walk the rungs the
    // helper steps through before giving up at four places.
    for (const rate of [0.3142, 0.25, 0.305, 0.123456, 0.0001, 0.35, 0.0725, 1]) {
      expect(formatExactPercent(rate)).toBe(serverRule(rate));
    }
    expect(formatExactPercent(0.3142)).toBe('31.42%');
    expect(formatExactPercent(0.25)).toBe('25.0%');
    // Past four decimals of a percent the rate is reported as far as it goes,
    // the same place the server stops.
    expect(formatExactPercent(0.123456789)).toBe('12.3457%');
  });

  it('shows an em-dash rather than a number for a rate that is not there', () => {
    // A run with no DLOM must not read as a DLOM of zero — "0.0%" is a claim
    // the calculation did not make.
    for (const absent of [null, undefined, '', Number.NaN, 'n/a']) {
      expect(formatExactPercent(absent as never)).toBe('—');
    }
  });

  it('is looking at a source tree', () => {
    expect(FILES.length).toBeGreaterThan(50);
  });

  it('re-rounds a concluded rate nowhere', () => {
    /*
     * A line naming a concluded rate and calling `toFixed` on the same line is
     * the shape that produced the drift: `${(discounts.dlom * 100).toFixed(1)}%`.
     * The parameter *forms* — `dlom_method`, `dloc_studies`, the analyst's own
     * input fields — are not the concluded rate and are excluded by requiring
     * the bare word.
     */
    const offenders: string[] = [];
    for (const { file, text } of FILES) {
      text.split('\n').forEach((line, i) => {
        if (!/\b(dlom|dloc)\b\s*[)\s*.]/.test(line)) return;
        if (/toFixed\(|toPrecision\(/.test(line)) offenders.push(`${file}:${i + 1}`);
      });
    }
    expect(offenders).toEqual([]);
  });

  it('would catch the pattern it is looking for', () => {
    const broken = '`${(discounts.dlom * 100).toFixed(1)}%`';
    expect(/\b(dlom|dloc)\b\s*[)\s*.]/.test(broken) && /toFixed\(/.test(broken)).toBe(true);
    expect(formatExactPercent(0.314)).not.toBe(formatExactPercent(0.3142));
  });
});
