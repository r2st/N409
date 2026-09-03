import { describe, expect, it } from 'vitest';
import {
  MAX_CAP_TABLE_ENTRIES,
  MAX_CAP_TABLE_ISSUES,
  validateCapTable,
  type CapTableEntry,
} from '../../src/domain/capTable.js';

/**
 * The per-entry rules are a product, and nothing bounded the result
 * (R402, methodology M8).
 *
 * A register of preferred classes with no price recorded raises `no_investment`
 * on every row. It is valid, saveable, and the ordinary shape of a share
 * register off a transfer agent — so at `MAX_CAP_TABLE_ENTRIES` the validation
 * carried 2,001 issue objects with a prose sentence each: 342 kB of JSON,
 * re-derived on every read, sent on every read of the cap-table tab and drawn as
 * 2,001 list items.
 *
 * The cap is disclosed rather than silent, and `valid` is deliberately computed
 * over the *uncapped* list — the assertion below that a table cannot be
 * truncated into validity is the one that matters, since `valid` is what gates
 * the save.
 */
function entries(n: number, over: Partial<Record<string, unknown>> = {}): CapTableEntry[] {
  return Array.from({ length: n }, (_, i) => ({
    security_class: `Series ${i}`,
    class_type: i === 0 ? 'common' : 'preferred',
    shares: 100_000 + i,
    price_per_share: null, // → `no_investment`, one per row
    invested_amount: null,
    liquidation_multiple: 1,
    participating: false,
    participation_cap: null,
    conversion_ratio: 1,
    seniority: (i % 5) + 1,
    holder: `Holder ${i}`,
    source_row: i + 2,
    ...over,
  })) as unknown as CapTableEntry[];
}

describe('cap-table validation bounds its own issue list (R402, M8)', () => {
  it('leaves an ordinary table untouched and says nothing was dropped', () => {
    const v = validateCapTable(entries(40));
    expect(v.issues.length).toBeGreaterThan(0);
    expect(v.issues.length).toBeLessThanOrEqual(MAX_CAP_TABLE_ISSUES);
    expect(v.issues_truncated).toBe(0);
  });

  it('caps a systematic finding on a full-size register and reports the remainder', () => {
    const v = validateCapTable(entries(MAX_CAP_TABLE_ENTRIES));
    expect(v.issues.length).toBe(MAX_CAP_TABLE_ISSUES);
    // Every dropped issue is accounted for: kept + reported = what was found.
    expect(v.issues.length + v.issues_truncated).toBeGreaterThanOrEqual(MAX_CAP_TABLE_ENTRIES);
    // The payload is what this is about, and it is a difference: deepen the
    // table tenfold and the document must not grow with it.
    const small = JSON.stringify(validateCapTable(entries(200))).length;
    const large = JSON.stringify(v).length;
    expect(large).toBeLessThan(small * 1.2);
    expect(large).toBeLessThan(60_000);
  });

  it('cannot truncate a table into validity', () => {
    // Enough warnings to fill the cap on their own, plus one row that errors.
    const rows = entries(MAX_CAP_TABLE_ENTRIES);
    (rows[7] as unknown as { shares: number }).shares = -5;
    const v = validateCapTable(rows);
    expect(v.valid).toBe(false);
    // And the error is visible, not cut off behind a page of warnings.
    expect(v.issues.some((i) => i.severity === 'error')).toBe(true);
    expect(v.issues[0]!.severity).toBe('error');
  });

  it('keeps every error when errors alone overrun the cap', () => {
    const rows = entries(MAX_CAP_TABLE_ENTRIES).map((e) => ({
      ...(e as object),
      shares: -1,
    })) as unknown as CapTableEntry[];
    const v = validateCapTable(rows);
    expect(v.valid).toBe(false);
    expect(v.issues).toHaveLength(MAX_CAP_TABLE_ISSUES);
    expect(v.issues.every((i) => i.severity === 'error')).toBe(true);
    expect(v.issues_truncated).toBeGreaterThan(0);
  });
});
