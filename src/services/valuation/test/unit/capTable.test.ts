import { describe, expect, it } from 'vitest';
import {
  inferClassType,
  parseCapTable,
  parseCsv,
  parseNumericCell,
  presetByKey,
  toWaterfallInputs,
  validateCapTable,
  type CapTableEntry,
} from '../../src/domain/capTable.js';

describe('capTable', () => {
  describe('parseNumericCell', () => {
    it('strips currency formatting', () => {
      expect(parseNumericCell('$1,234.50')).toBe(1234.5);
      expect(parseNumericCell('10000')).toBe(10000);
      expect(parseNumericCell('')).toBeNull();
      expect(parseNumericCell('n/a')).toBeNull();
      expect(parseNumericCell(42)).toBe(42);
    });
  });

  describe('inferClassType', () => {
    it('classifies from the security name', () => {
      expect(inferClassType('Common Stock')).toBe('common');
      expect(inferClassType('Series A Preferred')).toBe('preferred');
      expect(inferClassType('Option Pool')).toBe('option');
      expect(inferClassType('Warrant 2023')).toBe('warrant');
      expect(inferClassType('Founder Shares')).toBe('common');
    });
  });

  describe('parseCsv', () => {
    it('parses headers, quoted fields and CRLF', () => {
      const rows = parseCsv('class,shares,price\r\n"Common, A",1000,"1.50"\nSeries A,500,2\n');
      expect(rows).toHaveLength(2);
      expect(rows[0]).toEqual({ class: 'Common, A', shares: '1000', price: '1.50' });
      expect(rows[1]).toEqual({ class: 'Series A', shares: '500', price: '2' });
    });

    it('skips blank lines', () => {
      expect(parseCsv('a,b\n\n1,2\n')).toHaveLength(1);
    });
  });

  describe('parseCapTable', () => {
    it('maps generic columns and infers type', () => {
      const rows = [
        { class: 'Common Stock', shares: '8,000,000', price: '0.10' },
        { class: 'Series A Preferred', shares: '2000000', price: '1.00', invested: '2000000' },
        { class: 'Option Pool', shares: '1000000' },
      ];
      const entries = parseCapTable(rows, presetByKey('generic')!.mapping);
      expect(entries).toHaveLength(3);
      expect(entries[0]).toMatchObject({ security_class: 'Common Stock', class_type: 'common', shares: 8_000_000 });
      expect(entries[1]).toMatchObject({ class_type: 'preferred', shares: 2_000_000, invested_amount: 2_000_000 });
      expect(entries[2]).toMatchObject({ class_type: 'option', shares: 1_000_000 });
    });

    it('honours an explicit type column', () => {
      const rows = [{ class: 'Weird Name', type: 'preferred', shares: '100' }];
      const entries = parseCapTable(rows, presetByKey('generic')!.mapping);
      expect(entries[0]!.class_type).toBe('preferred');
    });

    it('skips blank/total rows', () => {
      const rows = [{ class: '', shares: '' }, { class: 'Total', shares: '' }];
      expect(parseCapTable(rows, presetByKey('generic')!.mapping)).toHaveLength(1);
    });
  });

  describe('validateCapTable', () => {
    const good: CapTableEntry[] = [
      { security_class: 'Common', class_type: 'common', shares: 8_000_000, price_per_share: 0.1, invested_amount: null, liquidation_multiple: null, seniority: null, conversion_ratio: null },
      { security_class: 'Series A', class_type: 'preferred', shares: 2_000_000, price_per_share: 1, invested_amount: 2_000_000, liquidation_multiple: 1, seniority: 1, conversion_ratio: 1 },
      { security_class: 'Options', class_type: 'option', shares: 1_000_000, price_per_share: null, invested_amount: null, liquidation_multiple: null, seniority: null, conversion_ratio: null },
    ];

    it('accepts a well-formed cap table and summarises it', () => {
      const v = validateCapTable(good);
      expect(v.valid).toBe(true);
      expect(v.summary.fully_diluted_shares).toBe(11_000_000);
      expect(v.summary.total_preference_stack).toBe(2_000_000);
      expect(v.summary.option_shares).toBe(1_000_000);
    });

    it('errors on negative shares', () => {
      const v = validateCapTable([{ ...good[0]!, shares: -5 }]);
      expect(v.valid).toBe(false);
      expect(v.issues.some((i) => i.code === 'bad_shares')).toBe(true);
    });

    it('errors on an empty table', () => {
      const v = validateCapTable([]);
      expect(v.valid).toBe(false);
      expect(v.issues.some((i) => i.code === 'empty')).toBe(true);
    });

    it('warns (not errors) on missing liquidation preference and no option pool', () => {
      const v = validateCapTable([
        { security_class: 'Series B', class_type: 'preferred', shares: 100, price_per_share: 5, invested_amount: 500, liquidation_multiple: null, seniority: null, conversion_ratio: null },
      ]);
      expect(v.valid).toBe(true);
      expect(v.issues.some((i) => i.code === 'default_liq_pref')).toBe(true);
      expect(v.issues.some((i) => i.code === 'no_option_pool')).toBe(true);
    });

    it('errors on a non-positive conversion ratio', () => {
      const v = validateCapTable([{ ...good[1]!, conversion_ratio: 0 }]);
      expect(v.valid).toBe(false);
      expect(v.issues.some((i) => i.code === 'bad_conversion')).toBe(true);
    });
  });

  describe('toWaterfallInputs', () => {
    it('projects common + options + preferred stack', () => {
      const entries: CapTableEntry[] = [
        { security_class: 'Common', class_type: 'common', shares: 8_000_000, price_per_share: null, invested_amount: null, liquidation_multiple: null, seniority: null, conversion_ratio: null },
        { security_class: 'Warrants', class_type: 'warrant', shares: 100_000, price_per_share: null, invested_amount: null, liquidation_multiple: null, seniority: null, conversion_ratio: null },
        { security_class: 'Options', class_type: 'option', shares: 1_000_000, price_per_share: null, invested_amount: null, liquidation_multiple: null, seniority: null, conversion_ratio: null },
        { security_class: 'Series A', class_type: 'preferred', shares: 2_000_000, price_per_share: 1, invested_amount: null, liquidation_multiple: null, seniority: null, conversion_ratio: null },
      ];
      const w = toWaterfallInputs(entries);
      expect(w.common_shares).toBe(8_100_000); // common + warrants
      expect(w.option_pool_shares).toBe(1_000_000);
      expect(w.preferred).toHaveLength(1);
      // invested defaulted from price × shares; liq multiple + conversion default to 1.
      expect(w.preferred[0]).toMatchObject({ invested_amount: 2_000_000, liquidation_multiple: 1, conversion_ratio: 1, seniority: 1 });
    });
  });
});
