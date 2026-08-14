import { describe, expect, it } from 'vitest';
import {
  parseCapTable,
  parseCsv,
  parseCsvSheet,
  parseNumericCell,
  sniffDelimiter,
  toWaterfallInputs,
  validateCapTable,
  type CapTableEntry,
} from '../../src/domain/capTable.js';

/**
 * The cap-table importer's edges: sheets that are shaped wrong rather than
 * merely wrong, and the validation paths a well-formed fixture never reaches.
 *
 * Separate from capTable.test.ts, which walks the happy path of each function.
 */

const entry = (over: Partial<CapTableEntry> = {}): CapTableEntry => ({
  security_class: 'Common Stock',
  class_type: 'common',
  shares: 1_000_000,
  price_per_share: null,
  invested_amount: null,
  liquidation_multiple: null,
  seniority: null,
  conversion_ratio: null,
  ...over,
});

const codes = (entries: CapTableEntry[]): string[] => validateCapTable(entries).issues.map((i) => i.code);

describe('parseNumericCell — the values a sheet library can hand back', () => {
  it('refuses a non-finite number rather than storing it as a share count', () => {
    // xlsx cells arrive already typed, so `NaN` and `Infinity` reach here as
    // numbers rather than as strings — a divide-by-zero in someone's formula.
    expect(parseNumericCell(Number.NaN)).toBeNull();
    expect(parseNumericCell(Number.POSITIVE_INFINITY)).toBeNull();
    expect(parseNumericCell(Number.NEGATIVE_INFINITY)).toBeNull();
  });
});

describe('sniffDelimiter — quoting in the header', () => {
  it('does not let an escaped quote flip it in and out of a quoted header cell', () => {
    // `"Series ""A"" Preferred"` holds two doubled quotes. Read as four state
    // changes instead of two escapes, the rest of the header line lands
    // "inside quotes" and its separators stop counting — so a semicolon export
    // sniffs as a comma and the whole sheet parses as one column.
    const header = 'class;"Series ""A"" Preferred";shares;price\nx;y;z;w';
    expect(sniffDelimiter(header)).toBe(';');
  });

  it('falls back to a comma when the first line has no separator at all', () => {
    expect(sniffDelimiter('justoneheader')).toBe(',');
    expect(sniffDelimiter('')).toBe(',');
  });
});

describe('parseCsvSheet — rows that are not the shape of the header', () => {
  it('reads a doubled quote inside a field as one quote', () => {
    const rows = parseCsv('class,shares\n"Series ""A"" Preferred",500\n');
    expect(rows[0]).toEqual({ class: 'Series "A" Preferred', shares: '500' });
  });

  it('fills a short row with blanks rather than dropping the columns', () => {
    // Trailing empty columns are routinely omitted by the exporter.
    const rows = parseCsv('class,shares,price,invested\nCommon,1000\n');
    expect(rows[0]).toEqual({ class: 'Common', shares: '1000', price: '', invested: '' });
  });

  it('ignores cells past the last named column', () => {
    const sheet = parseCsvSheet('class,shares\nCommon,1000,junk,more\n');
    expect(sheet.headers).toEqual(['class', 'shares']);
    expect(sheet.rows[0]).toEqual({ class: 'Common', shares: '1000' });
  });

  it('answers a sheet with nothing in it with empty everything', () => {
    expect(parseCsvSheet('')).toEqual({ headers: [], rows: [], lines: [] });
    expect(parseCsvSheet('\n\n  \n')).toEqual({ headers: [], rows: [], lines: [] });
  });
});

describe('parseCapTable — a mapping with holes in it', () => {
  const rows = [{ Class: 'Series A Preferred', Shares: '2,000,000', Price: '1.25' }];

  it('leaves a column the mapping does not name as null', () => {
    // The mapping UI lets a column go unassigned; an unassigned optional column
    // must read as "not stated", never as a guess at a neighbouring column.
    const entries = parseCapTable(rows, { security_class: 'Class', shares: 'Shares' });
    expect(entries).toHaveLength(1);
    expect(entries[0]!.price_per_share).toBeNull();
    expect(entries[0]!.invested_amount).toBeNull();
    expect(entries[0]!.liquidation_multiple).toBeNull();
    expect(entries[0]!.seniority).toBeNull();
    expect(entries[0]!.conversion_ratio).toBeNull();
  });

  it('matches a source column regardless of its case', () => {
    const entries = parseCapTable(rows, {
      security_class: 'class',
      shares: 'SHARES',
      price_per_share: 'price',
    });
    expect(entries[0]!.security_class).toBe('Series A Preferred');
    expect(entries[0]!.shares).toBe(2_000_000);
    expect(entries[0]!.price_per_share).toBe(1.25);
  });

  it('reads a row whose class cell is missing as an unnamed row, not a skipped one', () => {
    // Name absent but shares present: the row is real and its missing name is
    // the finding, so it must survive to be reported rather than be filtered
    // out with the blank and totals rows.
    const entries = parseCapTable([{ Shares: '1000' }], { security_class: 'Class', shares: 'Shares' });
    expect(entries).toHaveLength(1);
    expect(entries[0]!.security_class).toBe('');
    expect(codes(entries)).toContain('missing_class');
  });

  it('classifies from the name when the type cell says something unknown', () => {
    const entries = parseCapTable([{ Class: 'Series B Preferred', Shares: '10', Type: 'Equity-ish' }], {
      security_class: 'Class',
      shares: 'Shares',
      class_type: 'Type',
    });
    expect(entries[0]!.class_type).toBe('preferred');
  });
});

describe('validateCapTable — the paths a clean sheet never takes', () => {
  it('warns on a security class listed twice, case-insensitively', () => {
    const issues = validateCapTable([
      entry({ security_class: 'Series A Preferred', class_type: 'preferred', invested_amount: 1 }),
      entry({ security_class: 'series a preferred', class_type: 'preferred', invested_amount: 1 }),
    ]).issues;
    const dup = issues.find((i) => i.code === 'duplicate_class');
    expect(dup?.severity).toBe('warning');
    expect(dup?.message).toContain('series a preferred');
    // A duplicate is a modelling question, not a refusal — the import stands.
    expect(issues.some((i) => i.severity === 'error')).toBe(false);
  });

  it('counts warrants into the fully diluted total', () => {
    const summary = validateCapTable([
      entry({ shares: 4_000_000 }),
      entry({ security_class: '2023 Warrants', class_type: 'warrant', shares: 250_000 }),
      entry({ security_class: 'Option Pool', class_type: 'option', shares: 1_000_000 }),
    ]).summary;
    expect(summary.warrant_shares).toBe(250_000);
    expect(summary.fully_diluted_shares).toBe(5_250_000);
    expect(summary.total_shares).toBe(5_250_000);
  });

  it('says so when it defaults a missing liquidation preference to 1x', () => {
    const result = validateCapTable([
      entry({
        security_class: 'Series A',
        class_type: 'preferred',
        shares: 1_000_000,
        invested_amount: 5_000_000,
      }),
      entry({ security_class: 'Option Pool', class_type: 'option', shares: 1 }),
    ]);
    const note = result.issues.find((i) => i.code === 'default_liq_pref');
    expect(note?.severity).toBe('warning');
    // Defaulted, not dropped: the stack is the invested amount at 1x.
    expect(result.summary.total_preference_stack).toBe(5_000_000);
    expect(result.valid).toBe(true);
  });

  it('warns that the stack is understated when a preferred row carries neither figure', () => {
    const result = validateCapTable([
      entry({
        security_class: 'Series A',
        class_type: 'preferred',
        shares: 1_000_000,
        liquidation_multiple: 1,
      }),
      entry({ security_class: 'Option Pool', class_type: 'option', shares: 1 }),
    ]);
    expect(result.issues.map((i) => i.code)).toContain('no_investment');
    expect(result.summary.total_preference_stack).toBe(0);
  });

  /**
   * Mis-map the shares column and every row parses to null, which becomes 0.
   * Row by row that is only a warning — a retired class is a real line — so the
   * table came back `valid` and the PUT persisted a cap table with no
   * denominator to divide an equity value by.
   */
  it('refuses a table whose rows between them hold no shares', () => {
    const result = validateCapTable([
      entry({ security_class: 'Common Stock', shares: 0 }),
      entry({ security_class: 'Series A', class_type: 'preferred', shares: 0, invested_amount: 1 }),
    ]);
    expect(result.valid).toBe(false);
    const err = result.issues.find((i) => i.code === 'no_shares');
    expect(err?.severity).toBe('error');
    expect(err?.message).toContain('2 rows');
    expect(err?.message).toContain('shares column');
  });

  it('does not raise it for an empty sheet, which has its own message', () => {
    const codesFound = validateCapTable([]).issues.map((i) => i.code);
    expect(codesFound).toContain('empty');
    expect(codesFound).not.toContain('no_shares');
  });

  it('does not raise it as soon as one row holds shares', () => {
    const result = validateCapTable([
      entry({ security_class: 'Common Stock', shares: 1 }),
      entry({ security_class: 'Retired Series Seed', shares: 0 }),
      entry({ security_class: 'Option Pool', class_type: 'option', shares: 1 }),
    ]);
    expect(result.issues.map((i) => i.code)).not.toContain('no_shares');
    expect(result.issues.filter((i) => i.code === 'zero_shares')).toHaveLength(1);
    expect(result.valid).toBe(true);
  });
});

describe('toWaterfallInputs — the figures it has to supply itself', () => {
  it('derives the preference from price × shares when there is no invested amount', () => {
    const [pref] = toWaterfallInputs([
      entry({
        security_class: 'Series A',
        class_type: 'preferred',
        shares: 2_000_000,
        price_per_share: 1.25,
      }),
    ]).preferred;
    expect(pref!.invested_amount).toBe(2_500_000);
  });

  it('falls back to zero when the row carries neither, rather than to NaN', () => {
    const [pref] = toWaterfallInputs([
      entry({ security_class: 'Series A', class_type: 'preferred', shares: 2_000_000 }),
    ]).preferred;
    expect(pref!.invested_amount).toBe(0);
    // The other three defaults the engine's schema requires.
    expect(pref!.liquidation_multiple).toBe(1);
    expect(pref!.conversion_ratio).toBe(1);
    expect(pref!.seniority).toBe(1);
  });

  it('numbers unstated seniorities in cap-table order', () => {
    const { preferred } = toWaterfallInputs([
      entry({ security_class: 'Common', class_type: 'common' }),
      entry({ security_class: 'Series B', class_type: 'preferred', shares: 1 }),
      entry({ security_class: 'Series A', class_type: 'preferred', shares: 1 }),
    ]);
    expect(preferred.map((p) => [p.security_class, p.seniority])).toEqual([
      ['Series B', 1],
      ['Series A', 2],
    ]);
  });

  it('counts warrants with the common, and the pool on its own', () => {
    const inputs = toWaterfallInputs([
      entry({ shares: 4_000_000 }),
      entry({ security_class: '2023 Warrants', class_type: 'warrant', shares: 250_000 }),
      entry({ security_class: 'Option Pool', class_type: 'option', shares: 1_000_000 }),
    ]);
    expect(inputs.common_shares).toBe(4_250_000);
    expect(inputs.option_pool_shares).toBe(1_000_000);
  });
});
