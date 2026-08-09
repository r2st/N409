import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CONTROL_PREMIUM_STUDIES,
  DEFAULT_CONTROL_PREMIUM_SET,
  DEFAULT_PRE_IPO_SET,
  DEFAULT_RESTRICTED_STOCK_SET,
  PRE_IPO_RECENCY_YEAR,
  PRE_IPO_STUDIES,
  RESTRICTED_STOCK_STUDIES,
  RULE_144_AMENDMENT_YEAR,
  THIN_STUDY_SET,
  type StudyRow,
} from '../src/components/valuation/StudySelector';

/**
 * The study pickers list the engine's tables from a copy in the frontend, so
 * the checkboxes render without a round trip. This is the guard that makes the
 * copy safe: it reads the Python the engine actually blends from and asserts
 * the copy row for row. A study added, repriced or renamed in the engine fails
 * here — rather than reaching an analyst as a name the pre-flight rejects, or
 * (worse) a table quietly missing the row they meant to select.
 */

// Resolved from the package root rather than `import.meta.url`: Vite serves
// test modules under a `/@fs/…` URL, which `readFileSync` cannot open.
const source = (file: string) =>
  readFileSync(resolve(process.cwd(), '../engine-wrapper/app/engine', file), 'utf8');

const DLOM_PY = source('dlom.py');
const DLOC_PY = source('dloc.py');

/** The rows of a `NAME: tuple[dict, ...] = ( … )` literal, one dict per line. */
function parseTable(py: string, name: string, valueKey: 'discount' | 'premium'): StudyRow[] {
  const start = py.indexOf(`${name}: tuple[dict, ...] = (`);
  expect(start, `${name} not found`).toBeGreaterThan(-1);
  const end = py.indexOf('\n)', start);
  expect(end, `${name} is unterminated`).toBeGreaterThan(start);
  const body = py.slice(start, end);

  const rows: StudyRow[] = [];
  for (const line of body.split('\n')) {
    const study = /"study":\s*"([^"]+)"/.exec(line);
    if (!study?.[1]) continue;
    const value = new RegExp(`"${valueKey}":\\s*([0-9.]+)`).exec(line);
    const from = /"period_start":\s*(\d+)/.exec(line);
    const to = /"period_end":\s*(\d+)/.exec(line);
    const statistic = /"statistic":\s*"(median|mean)"/.exec(line);
    const row: StudyRow = { study: study[1] };
    if (value?.[1]) row[valueKey] = Number(value[1]);
    if (from?.[1]) row.period_start = Number(from[1]);
    if (to?.[1]) row.period_end = Number(to[1]);
    if (statistic?.[1]) row.statistic = statistic[1] as 'median' | 'mean';
    rows.push(row);
  }
  expect(rows.length, `${name} parsed as empty`).toBeGreaterThan(0);
  return rows;
}

/** The names of a `NAME: tuple[str, ...] = ( … )` literal. */
function parseNameSet(py: string, name: string): string[] {
  const start = py.indexOf(`${name}: tuple[str, ...] = (`);
  expect(start, `${name} not found`).toBeGreaterThan(-1);
  const end = py.indexOf('\n)', start);
  const body = py.slice(start, end);
  return Array.from(body.matchAll(/"([^"]+)"/g)).map((m) => m[1] as string);
}

/** An `NAME = 123` module constant. */
function parseInt_(py: string, name: string): number {
  const m = new RegExp(`^${name} = (\\d+)$`, 'm').exec(py);
  expect(m?.[1], `${name} not found`).toBeDefined();
  return Number(m?.[1]);
}

describe('study tables mirror the engine', () => {
  it('reproduces the restricted-stock table', () => {
    expect(RESTRICTED_STOCK_STUDIES).toEqual(parseTable(DLOM_PY, 'RESTRICTED_STOCK_STUDIES', 'discount'));
  });

  it('reproduces the pre-IPO table', () => {
    expect(PRE_IPO_STUDIES).toEqual(parseTable(DLOM_PY, 'PRE_IPO_STUDIES', 'discount'));
  });

  it('reproduces the control-premium table', () => {
    // The engine's rows carry `indicative: True`, which is a fact about the
    // conclusion rather than something to select on, so the picker's copy does
    // not repeat it — hence a comparison on the fields the picker shows.
    const parsed = parseTable(DLOC_PY, 'CONTROL_PREMIUM_STUDIES', 'premium');
    expect(CONTROL_PREMIUM_STUDIES).toEqual(parsed);
  });

  it('reproduces the default sets', () => {
    // The restricted-stock default is computed, not listed: the studies that
    // observed only post-amendment placements, keyed on period_start.
    const postAmendment = parseTable(DLOM_PY, 'RESTRICTED_STOCK_STUDIES', 'discount')
      .filter((r) => (r.period_start ?? 0) >= RULE_144_AMENDMENT_YEAR)
      .map((r) => r.study);
    expect(DEFAULT_RESTRICTED_STOCK_SET).toEqual(postAmendment);
    expect(DEFAULT_PRE_IPO_SET).toEqual(parseNameSet(DLOM_PY, 'DEFAULT_PRE_IPO_SET'));
    expect(DEFAULT_CONTROL_PREMIUM_SET).toEqual(parseNameSet(DLOC_PY, 'DEFAULT_CONTROL_PREMIUM_SET'));
  });

  it('reproduces the thresholds the notes quote', () => {
    expect(RULE_144_AMENDMENT_YEAR).toBe(parseInt_(DLOM_PY, 'RULE_144_AMENDMENT_YEAR'));
    expect(PRE_IPO_RECENCY_YEAR).toBe(parseInt_(DLOM_PY, 'PRE_IPO_RECENCY_YEAR'));
    // Shared threshold, same value in both engine modules.
    expect(THIN_STUDY_SET).toBe(parseInt_(DLOM_PY, 'THIN_STUDY_SET'));
    expect(THIN_STUDY_SET).toBe(parseInt_(DLOC_PY, 'THIN_STUDY_SET'));
  });

  it('keeps the two DLOM families disjoint', () => {
    // The engine's premise for giving them separate columns: a name selected in
    // one family must not silently resolve in the other.
    const rs = new Set(RESTRICTED_STOCK_STUDIES.map((r) => r.study));
    expect(PRE_IPO_STUDIES.filter((r) => rs.has(r.study))).toEqual([]);
  });
});
