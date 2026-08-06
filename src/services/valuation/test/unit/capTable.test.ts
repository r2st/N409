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

    it('reads accounting parentheses as a negative', () => {
      // The parentheses used to be stripped, so a repurchase row exported in
      // accounting notation became a positive holding of the same size.
      expect(parseNumericCell('(500,000)')).toBe(-500000);
      expect(parseNumericCell('$(1,234.50)')).toBe(-1234.5);
      expect(parseNumericCell('(0)')).toBe(0);
      expect(Object.is(parseNumericCell('(0)'), -0)).toBe(false);
      // Agrees with the sign the same figure carries written out.
      expect(parseNumericCell('(500,000)')).toBe(parseNumericCell('-500,000'));
    });

    it('rejects an unbalanced parenthesis instead of guessing', () => {
      expect(parseNumericCell('(500000')).toBeNull();
      expect(parseNumericCell('500000)')).toBeNull();
      expect(parseNumericCell('()')).toBeNull();
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
      expect(entries[0]).toMatchObject({
        security_class: 'Common Stock',
        class_type: 'common',
        shares: 8_000_000,
      });
      expect(entries[1]).toMatchObject({
        class_type: 'preferred',
        shares: 2_000_000,
        invested_amount: 2_000_000,
      });
      expect(entries[2]).toMatchObject({ class_type: 'option', shares: 1_000_000 });
    });

    it('honours an explicit type column', () => {
      const rows = [{ class: 'Weird Name', type: 'preferred', shares: '100' }];
      const entries = parseCapTable(rows, presetByKey('generic')!.mapping);
      expect(entries[0]!.class_type).toBe('preferred');
    });

    it('skips blank/total rows', () => {
      const rows = [
        { class: '', shares: '' },
        { class: 'Total', shares: '' },
      ];
      expect(parseCapTable(rows, presetByKey('generic')!.mapping)).toHaveLength(1);
    });

    it('flags a parenthesised share count instead of inflating the table', () => {
      // An accounting-notation repurchase row. Stripping the parentheses made
      // it a positive 500,000-share holding, which passed validation and
      // inflated the fully-diluted count that sets the per-share value.
      const rows = [
        { class: 'Common Stock', shares: '8,000,000', price: '0.10' },
        { class: 'Common Stock — repurchase', shares: '(500,000)' },
      ];
      const entries = parseCapTable(rows, presetByKey('generic')!.mapping);
      expect(entries[1]!.shares).toBe(-500_000);

      const v = validateCapTable(entries);
      expect(v.valid).toBe(false);
      expect(v.issues.some((i) => i.code === 'bad_shares')).toBe(true);
      expect(v.summary.fully_diluted_shares).not.toBe(8_500_000);
    });
  });

  describe('validateCapTable', () => {
    const good: CapTableEntry[] = [
      {
        security_class: 'Common',
        class_type: 'common',
        shares: 8_000_000,
        price_per_share: 0.1,
        invested_amount: null,
        liquidation_multiple: null,
        seniority: null,
        conversion_ratio: null,
      },
      {
        security_class: 'Series A',
        class_type: 'preferred',
        shares: 2_000_000,
        price_per_share: 1,
        invested_amount: 2_000_000,
        liquidation_multiple: 1,
        seniority: 1,
        conversion_ratio: 1,
      },
      {
        security_class: 'Options',
        class_type: 'option',
        shares: 1_000_000,
        price_per_share: null,
        invested_amount: null,
        liquidation_multiple: null,
        seniority: null,
        conversion_ratio: null,
      },
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
        {
          security_class: 'Series B',
          class_type: 'preferred',
          shares: 100,
          price_per_share: 5,
          invested_amount: 500,
          liquidation_multiple: null,
          seniority: null,
          conversion_ratio: null,
        },
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

    // Seniority orders the preference stack, and nothing used to check it.
    // `parseNumericCell` accepts any finite number, so these all imported as
    // `valid: true` and only failed later — in the engine, which refuses a
    // seniority that is not an integer >= 1, or silently in the workbook,
    // whose waterfall sheet sorts by this column and formats it as an integer.
    it.each([
      ['a zero rank, as 0-based exports write it', 0],
      ['a negative rank', -1],
      ['a fractional rank', 1.5],
    ])('errors on %s', (_label, seniority) => {
      const v = validateCapTable([{ ...good[1]!, seniority }]);
      expect(v.valid).toBe(false);
      const issue = v.issues.find((i) => i.code === 'bad_seniority');
      expect(issue?.security_class).toBe(good[1]!.security_class);
    });

    it('accepts an absent seniority, which toWaterfallInputs defaults positionally', () => {
      const v = validateCapTable([{ ...good[1]!, seniority: null }]);
      expect(v.issues.some((i) => i.code === 'bad_seniority')).toBe(false);
      expect(toWaterfallInputs([{ ...good[1]!, seniority: null }]).preferred[0]!.seniority).toBe(1);
    });

    it('accepts the ordinary ranks a preference stack is written with', () => {
      const v = validateCapTable([
        { ...good[1]!, security_class: 'Series B', seniority: 1 },
        { ...good[1]!, security_class: 'Series A', seniority: 2 },
      ]);
      expect(v.issues.some((i) => i.code === 'bad_seniority')).toBe(false);
    });

    it('names only the row that is wrong when the rest of the stack is fine', () => {
      const v = validateCapTable([
        { ...good[1]!, security_class: 'Series B', seniority: 1 },
        { ...good[1]!, security_class: 'Series A', seniority: 0 },
      ]);
      const bad = v.issues.filter((i) => i.code === 'bad_seniority');
      expect(bad).toHaveLength(1);
      expect(bad[0]!.security_class).toBe('Series A');
    });

    // The money columns behind the preference stack. `parseNumericCell` reads
    // `(5,000,000)` as −5,000,000 — the right reading of an accounting export,
    // and exactly how a negative figure arrives here. Shares were checked for
    // it and these were not, so a repurchase or contra row imported as valid
    // and put a negative preference into the auditor's workbook, into the
    // summary the import screen reports, and into an engine that refuses it.
    describe('negative money in the preference stack', () => {
      it.each([
        ['a negative invested amount', { invested_amount: -5_000_000 }, 'negative_investment'],
        ['a negative price per share', { price_per_share: -2.5 }, 'negative_price'],
      ])('errors on %s', (_label, patch, code) => {
        const v = validateCapTable([good[0]!, { ...good[1]!, ...patch }]);
        expect(v.valid).toBe(false);
        const issue = v.issues.find((i) => i.code === code);
        expect(issue?.security_class).toBe('Series A');
      });

      it('refuses the accounting-parenthesis form the parser produces', () => {
        const rows = parseCsv(
          'class,type,shares,invested\nCommon,common,8000000,\nSeries A,preferred,2000000,"(5,000,000)"\n',
        );
        const entries = parseCapTable(rows, {
          security_class: 'class',
          class_type: 'type',
          shares: 'shares',
          invested_amount: 'invested',
        });
        expect(entries[1]!.invested_amount).toBe(-5_000_000);
        expect(validateCapTable(entries).valid).toBe(false);
      });

      it('leaves a zero invested amount as the warning it already was', () => {
        const v = validateCapTable([good[0]!, { ...good[1]!, invested_amount: 0, price_per_share: 0 }]);
        expect(v.valid).toBe(true);
        expect(v.issues.some((i) => i.code === 'no_investment')).toBe(true);
      });

      it('checks the columns independently of each other', () => {
        // invested_amount wins over price × shares when both are present, but a
        // negative price is still a negative price.
        const v = validateCapTable([good[0]!, { ...good[1]!, price_per_share: -1 }]);
        expect(v.issues.some((i) => i.code === 'negative_price')).toBe(true);
        expect(v.issues.some((i) => i.code === 'negative_investment')).toBe(false);
      });
    });

    // Zero shares is a warning, not an error: it is a real thing for a row to
    // say, and refusing the import would lose every other row over it. But the
    // engine's rule is `shares must be positive`, so the row is the one that
    // turns the allocation into a 422 and this is the last place that knows
    // which row it was.
    it('warns that a zero-share row will be refused by the waterfall', () => {
      const v = validateCapTable([good[0]!, { ...good[1]!, shares: 0 }]);
      expect(v.valid).toBe(true);
      const issue = v.issues.find((i) => i.code === 'zero_shares');
      expect(issue?.severity).toBe('warning');
      expect(issue?.security_class).toBe('Series A');
    });

    it('does not warn about zero shares on an ordinary table', () => {
      expect(validateCapTable(good).issues.some((i) => i.code === 'zero_shares')).toBe(false);
    });
  });

  describe('toWaterfallInputs', () => {
    it('projects common + options + preferred stack', () => {
      const entries: CapTableEntry[] = [
        {
          security_class: 'Common',
          class_type: 'common',
          shares: 8_000_000,
          price_per_share: null,
          invested_amount: null,
          liquidation_multiple: null,
          seniority: null,
          conversion_ratio: null,
        },
        {
          security_class: 'Warrants',
          class_type: 'warrant',
          shares: 100_000,
          price_per_share: null,
          invested_amount: null,
          liquidation_multiple: null,
          seniority: null,
          conversion_ratio: null,
        },
        {
          security_class: 'Options',
          class_type: 'option',
          shares: 1_000_000,
          price_per_share: null,
          invested_amount: null,
          liquidation_multiple: null,
          seniority: null,
          conversion_ratio: null,
        },
        {
          security_class: 'Series A',
          class_type: 'preferred',
          shares: 2_000_000,
          price_per_share: 1,
          invested_amount: null,
          liquidation_multiple: null,
          seniority: null,
          conversion_ratio: null,
        },
      ];
      const w = toWaterfallInputs(entries);
      expect(w.common_shares).toBe(8_100_000); // common + warrants
      expect(w.option_pool_shares).toBe(1_000_000);
      expect(w.preferred).toHaveLength(1);
      // invested defaulted from price × shares; liq multiple + conversion default to 1.
      expect(w.preferred[0]).toMatchObject({
        invested_amount: 2_000_000,
        liquidation_multiple: 1,
        conversion_ratio: 1,
        seniority: 1,
      });
    });
  });
});
