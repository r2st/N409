import { describe, expect, it } from 'vitest';
import {
  inferClassType,
  parseCapTable,
  parseCsv,
  parseCsvSheet,
  parseNumericCell,
  presetByKey,
  sniffDelimiter,
  toWaterfallInputs,
  validateCapTable,
  type CapTableEntry,
} from '../../src/domain/capTable.js';
import { capTableTotals } from '../../src/domain/workbookTabs.js';

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

    it('strips the BOM "Save as CSV UTF-8" writes', () => {
      // Left in place it becomes part of the first header name, and the first
      // column of a cap table is the one that matters most.
      const rows = parseCsv('﻿class,shares\nCommon,100\n');
      expect(Object.keys(rows[0]!)).toEqual(['class', 'shares']);
    });

    it('reads semicolon-delimited CSV, which is what Excel writes in most of Europe', () => {
      const rows = parseCsv('class;shares;price\nCommon;8000000;0.10\n');
      expect(rows[0]).toEqual({ class: 'Common', shares: '8000000', price: '0.10' });
    });

    it('reads tab-delimited text, which is what a spreadsheet paste produces', () => {
      const rows = parseCsv('class\tshares\nCommon\t8000000\n');
      expect(rows[0]).toEqual({ class: 'Common', shares: '8000000' });
    });

    it('does not let a comma inside a quoted header outvote the real delimiter', () => {
      const rows = parseCsv('"Acme, Inc";shares\nCommon;100\n');
      expect(rows[0]).toEqual({ 'Acme, Inc': 'Common', shares: '100' });
    });

    it('keeps duplicate columns distinct instead of letting the last one win', () => {
      // Carta exports granted and outstanding shares under the same label.
      const { headers, rows } = parseCsvSheet('class,shares,shares\nCommon,100,90\n');
      expect(headers).toEqual(['class', 'shares', 'shares (2)']);
      expect(rows[0]).toEqual({ class: 'Common', shares: '100', 'shares (2)': '90' });
    });

    it('drops unnamed columns rather than collapsing them onto one key', () => {
      // A trailing separator and a spacer column both produce these.
      const { headers, rows } = parseCsvSheet('class,,shares,\nCommon,x,100,y\n');
      expect(headers).toEqual(['class', 'shares']);
      expect(rows[0]).toEqual({ class: 'Common', shares: '100' });
    });

    it('reports the header row for a file that has no data rows', () => {
      // The mapping UI needs the columns before a single row exists; deriving
      // them from the first row's keys gave it nothing to show.
      expect(parseCsvSheet('class,shares,price\n').headers).toEqual(['class', 'shares', 'price']);
    });

    it('reports headers in source order', () => {
      expect(parseCsvSheet('zeta,alpha,middle\n1,2,3\n').headers).toEqual(['zeta', 'alpha', 'middle']);
    });

    it('has nothing to say about an empty file', () => {
      expect(parseCsvSheet('')).toEqual({ headers: [], rows: [], lines: [], totalRows: 0 });
      expect(parseCsvSheet('\n\n')).toEqual({ headers: [], rows: [], lines: [], totalRows: 0 });
    });
  });

  describe('sniffDelimiter', () => {
    it('defaults to a comma when the header has no separator at all', () => {
      expect(sniffDelimiter('class\nCommon\n')).toBe(',');
    });

    it('picks the separator that appears most often in the header', () => {
      expect(sniffDelimiter('a,b,c\n')).toBe(',');
      expect(sniffDelimiter('a;b;c\n')).toBe(';');
      expect(sniffDelimiter('a\tb\tc\n')).toBe('\t');
    });

    it('reads only the header line, not the data below it', () => {
      // A data row full of semicolons inside quoted prose must not re-decide
      // the delimiter for a file whose header is plainly comma-separated.
      expect(sniffDelimiter('class,note\nCommon,"a; b; c; d"\n')).toBe(',');
    });

    it('ignores separators inside quotes', () => {
      expect(sniffDelimiter('"a,b,c,d";x\n')).toBe(';');
    });

    it('handles a header with no trailing newline', () => {
      expect(sniffDelimiter('a;b')).toBe(';');
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
      // Both of them, which this has always been named for and only ever
      // checked the first of: `Total` was kept as a security class, and the
      // assertion of 1 entry pinned it there. See the totals-row group in
      // `capTableAdversarialImport` for what that cost on a sheet whose totals
      // row carried the sum rather than a blank.
      const rows = [
        { class: '', shares: '' },
        { class: 'Total', shares: '' },
      ];
      expect(parseCapTable(rows, presetByKey('generic')!.mapping)).toHaveLength(0);
    });

    it('numbers each entry with its line in the sheet, not its place in the output', () => {
      // The two are not the same once anything is skipped, and every real
      // export has a totals row. An issue reported against "the third entry"
      // points at the wrong line the moment one row above it is dropped.
      // Through the CSV parser, because that is where the numbering is decided:
      // it drops blank lines, so by the third entry the array index and the
      // file line have diverged by two.
      const sheet = parseCsvSheet(
        ['class,shares', 'Common Stock,8000000', '', 'Series A,2000000', '', 'Options,1000000'].join('\n'),
      );
      const entries = parseCapTable(sheet.rows, presetByKey('generic')!.mapping, sheet.lines);
      expect(entries).toHaveLength(3);
      // Header is line 1. The blank lines are gone from `rows`, and the
      // numbering still tracks the file rather than the array.
      expect(entries.map((e) => e.source_row)).toEqual([2, 4, 6]);
    });

    it('counts the physical lines a quoted cell spans, not the records', () => {
      // A record is not a line. `notes` holds two embedded newlines, so the row
      // below it is the fifth line of the file — and a counter that only ticks
      // on the newline *ending* a record called it the third, sending the
      // reader two lines above the row with the problem. Multi-line cells are
      // ordinary in exports that carry a notes or legend column, and
      // `capTableCsvParity` already pins a header that spans two lines.
      const sheet = parseCsvSheet(
        [
          'class,shares,notes',
          'Common Stock,8000000,"founder grant',
          'board minutes 2019-04-02',
          'see schedule B"',
          'Series A,2000000,ok',
        ].join('\n'),
      );
      expect(sheet.rows).toHaveLength(2);
      expect(sheet.lines).toEqual([2, 5]);
    });

    it('counts the lines a quoted header spans as well', () => {
      // The header is the one multi-line cell that shifts *every* data row.
      const sheet = parseCsvSheet('"Security\nClass",shares\nCommon,100\nSeries A,200');
      expect(sheet.lines).toEqual([3, 4]);
    });

    it('counts a CRLF inside a quoted cell once', () => {
      const sheet = parseCsvSheet('class,notes\r\nCommon,"a\r\nb"\r\nSeries A,ok\r\n');
      expect(sheet.lines).toEqual([2, 4]);
    });

    it('counts a lone CR inside a quoted cell', () => {
      // Classic-Mac line endings still turn up in files exported by old tools.
      const sheet = parseCsvSheet('class,notes\nCommon,"a\rb"\nSeries A,ok');
      expect(sheet.lines).toEqual([2, 4]);
    });

    it('points a validation error at the spreadsheet row the reader can open', () => {
      const sheet = parseCsvSheet(['class,shares', 'Common Stock,8000000', '', 'Series A,n/a'].join('\n'));
      const entries = parseCapTable(sheet.rows, presetByKey('generic')!.mapping, sheet.lines);
      const v = validateCapTable(entries);
      // Series A is the fourth line of the file and the second surviving entry;
      // reporting "3" would send the reader to the blank line above it.
      const bad = v.issues.find((i) => i.security_class === 'Series A');
      expect(bad?.row).toBe(4);
      expect(bad?.message).toContain('Row 4');
    });

    it('identifies a nameless row, which previously identified nothing at all', () => {
      // `missing_class` is the one issue with no class name to quote, so
      // without the row it read "A row is missing a security class name" and
      // left the reader to find which of 300 it meant.
      const sheet = parseCsvSheet(['class,shares', 'Common Stock,8000000', ',250000'].join('\n'));
      const v = validateCapTable(parseCapTable(sheet.rows, presetByKey('generic')!.mapping, sheet.lines));
      const missing = v.issues.find((i) => i.code === 'missing_class');
      expect(missing?.row).toBe(3);
      expect(missing?.message).toContain('Row 3');
    });

    it('omits the row when no source lines were supplied, rather than inventing one', () => {
      // Rows can arrive without any file behind them, and the array index only
      // equals the file line for a sheet with no blank lines — which no real
      // export is. A confident wrong number sends someone to the wrong line.
      const v = validateCapTable([
        {
          security_class: 'Common',
          class_type: 'common',
          shares: -1,
          price_per_share: null,
          invested_amount: null,
          liquidation_multiple: null,
          seniority: null,
          conversion_ratio: null,
        },
      ]);
      const bad = v.issues.find((i) => i.code === 'bad_shares');
      expect(bad?.row).toBeUndefined();
      expect(bad?.message).not.toContain('Row');
      expect(bad?.security_class).toBe('Common');
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

    it('accepts an absent seniority, which toWaterfallInputs defaults to the top rank', () => {
      const v = validateCapTable([{ ...good[1]!, seniority: null }]);
      expect(v.issues.some((i) => i.code === 'bad_seniority')).toBe(false);
      expect(toWaterfallInputs([{ ...good[1]!, seniority: null }]).preferred[0]!.seniority).toBe(1);
    });

    /**
     * The stack order the platform supplies for itself, said out loud.
     *
     * A blank seniority column is read as pari passu, and that reading decides
     * who is paid out of the first dollar of an exit. It was stated in one
     * place only — `graphIssues.partial_seniority`, on the graph endpoint —
     * and only for the mixed case, so the ordinary wholly-blank sheet (the
     * Pulley preset maps no seniority column at all) went through the import
     * screen, the stored validation and the workbook without a word.
     */
    describe('a preference stack whose order nobody stated', () => {
      const pref = (security_class: string, seniority: number | null) => ({
        ...good[1]!,
        security_class,
        seniority,
      });

      it('warns when no preferred class states a seniority', () => {
        const v = validateCapTable([pref('Series Seed', null), pref('Series A', null)]);
        expect(v.valid).toBe(true);
        const issue = v.issues.find((i) => i.code === 'no_seniority');
        expect(issue?.severity).toBe('warning');
        expect(issue?.message).toContain('pari passu');
      });

      it('warns when only some of them do, in the words the graph uses', () => {
        const v = validateCapTable([pref('Series Seed', 1), pref('Series A', null)]);
        expect(v.issues.find((i) => i.code === 'partial_seniority')?.message).toContain(
          '1 of 2 preferred classes',
        );
        expect(v.issues.some((i) => i.code === 'no_seniority')).toBe(false);
      });

      it('says nothing when every class states one, or when there is only one class', () => {
        const stated = validateCapTable([pref('Series Seed', 1), pref('Series A', 2)]);
        const lone = validateCapTable([pref('Series Seed', null)]);
        for (const v of [stated, lone]) {
          expect(v.issues.some((i) => i.code === 'no_seniority' || i.code === 'partial_seniority')).toBe(
            false,
          );
        }
      });
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
    /*
     * The summary's fully-diluted count is a denominator, not a tally: it is
     * what an equity value is divided by to reach a price per share, and the
     * engine reaches it as `Σ shares × conversion_ratio` (waterfall.py). Summing
     * the four kind buckets instead counted every preferred share 1:1 and so
     * ignored a column this importer maps, validates and stores.
     */
    describe('as-converted fully diluted', () => {
      const ratchet = (conversion_ratio: number | null): CapTableEntry[] => [
        good[0]!,
        { ...good[1]!, conversion_ratio },
        good[2]!,
      ];

      it('converts preferred through its ratio', () => {
        // 8M common + 2M preferred at 2:1 + 1M options = 13M, not 11M.
        expect(validateCapTable(ratchet(2)).summary.fully_diluted_shares).toBe(13_000_000);
      });

      it('agrees with the workbook tab on the same entries', () => {
        for (const ratio of [null, 1, 1.5, 2, 3]) {
          const entries = ratchet(ratio);
          expect(capTableTotals(entries).fully_diluted_shares).toBe(
            validateCapTable(entries).summary.fully_diluted_shares,
          );
        }
      });

      it('leaves the raw share tally alone', () => {
        // `total_shares` and the per-kind buckets stay pre-conversion — they
        // answer "what is on the sheet", which is a different question.
        const v = validateCapTable(ratchet(2));
        expect(v.summary.total_shares).toBe(11_000_000);
        expect(v.summary.preferred_shares).toBe(2_000_000);
      });

      it('counts a broken ratio 1:1 rather than dropping the class', () => {
        // 0 is refused as `bad_conversion`; the denominator must still be the
        // whole table, because callers that only read the summary divide by it.
        const v = validateCapTable(ratchet(0));
        expect(v.valid).toBe(false);
        expect(v.summary.fully_diluted_shares).toBe(11_000_000);
      });

      it('does not convert common, options or warrants', () => {
        // Only preferred carries a ratio in the engine's model, so a stray one
        // on another kind must not multiply it.
        const strayed = [{ ...good[0]!, conversion_ratio: 5 }, good[1]!, good[2]!];
        expect(validateCapTable(strayed).summary.fully_diluted_shares).toBe(11_000_000);
      });
    });

    /*
     * The other figure the workbook tab and this summary both compute, and the
     * other one they disagreed on: a preferred class priced but with no stated
     * amount invested. Carta's "Amount Invested" is optional and plenty of
     * sheets carry only a round price, so this is an ordinary export rather
     * than a malformed one.
     */
    describe('a priced class with no stated invested amount', () => {
      const priced = (): CapTableEntry[] => [
        good[0]!,
        { ...good[1]!, invested_amount: null, price_per_share: 1.5, shares: 2_000_000 },
        good[2]!,
      ];

      it('derives the preference from price × shares', () => {
        // 2,000,000 × 1.5 × 1× = 3,000,000, not nothing.
        expect(validateCapTable(priced()).summary.total_preference_stack).toBe(3_000_000);
      });

      it('agrees with the workbook tab, which reported it as having raised nothing', () => {
        const totals = capTableTotals(priced());
        expect(totals.invested_capital).toBe(3_000_000);
        expect(totals.liquidation_preference).toBe(3_000_000);
      });

      it('agrees with the engine feed, which has derived it all along', () => {
        expect(toWaterfallInputs(priced()).preferred[0]!.invested_amount).toBe(3_000_000);
      });

      it('carries the multiple through the derived base', () => {
        const twoX = priced();
        twoX[1] = { ...twoX[1]!, liquidation_multiple: 2 };
        expect(validateCapTable(twoX).summary.total_preference_stack).toBe(6_000_000);
        expect(capTableTotals(twoX).liquidation_preference).toBe(6_000_000);
      });

      it('still reports nothing when there is neither an amount nor a price', () => {
        const bare = priced();
        bare[1] = { ...bare[1]!, price_per_share: null };
        const v = validateCapTable(bare);
        expect(v.summary.total_preference_stack).toBe(0);
        expect(v.issues.some((i) => i.code === 'no_investment')).toBe(true);
        expect(capTableTotals(bare).liquidation_preference).toBe(0);
      });
    });

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
