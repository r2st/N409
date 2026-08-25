import { describe, expect, it } from 'vitest';
import {
  DEFAULT_HEADLINE_LABELS,
  SPECIALTY_KINDS,
  headlineLabels,
  specialtyHeadline,
  specialtyEngineRequest,
  type SpecialtyKind,
} from '../../src/domain/specialty.js';
import {
  valuationWorkbookSheets,
  type ValuationWorkbookInput,
  type WorkbookCalculation,
} from '../../src/export/valuationWorkbook.js';
import { validateCapTable, type CapTableEntry } from '../../src/domain/capTable.js';
import type { XlsxSheet } from '../../src/export/xlsx.js';

/**
 * What the two headline columns are *called* where a reader is given nothing
 * else.
 *
 * `calculations.equity_value` and `calculations.fmv_per_share` are 409A columns
 * by name, and every specialty engine writes into them because they are the
 * columns the row has. On four kinds the figure that lands there is not the
 * figure the column is named after — an IFRS 2 total expense, an ASC 820
 * portfolio total, the value of a transferred interest, an EMI/CSOP *actual*
 * market value — and two surfaces state them with a caption and no other
 * context: the exported auditor workbook and the external auditor portal.
 *
 * The exhibits have always named these correctly; only the two caption-only
 * surfaces did not. So the assertions here are in two halves — that the
 * vocabulary covers every kind and says the right thing, and that the workbook
 * actually uses it.
 */

const GENERATED_AT = new Date('2026-07-29T09:00:00Z');

const ENTRIES: CapTableEntry[] = [
  {
    security_class: 'Ordinary',
    class_type: 'common',
    shares: 5_000_000,
    price_per_share: null,
    invested_amount: null,
    liquidation_multiple: null,
    seniority: null,
    conversion_ratio: null,
  },
  {
    security_class: 'Series A Preferred',
    class_type: 'preferred',
    shares: 1_000_000,
    price_per_share: 2,
    invested_amount: 2_000_000,
    liquidation_multiple: 1,
    seniority: 1,
    conversion_ratio: 1,
  },
];

function calculation(overrides: Partial<WorkbookCalculation> = {}): WorkbookCalculation {
  return {
    engine_version: '3.1.0',
    status: 'succeeded',
    inputs: {},
    results: {},
    equity_value: '12000000',
    fmv_per_share: '1.95',
    diagnostics: [],
    created_at: new Date('2026-07-01T00:00:00Z'),
    ...overrides,
  };
}

function input(kind: string, currency = 'USD'): ValuationWorkbookInput {
  return {
    valuation: {
      number: 'V-2026-0100',
      company_name: 'Acme, Inc.',
      kind,
      state: 'published',
      currency,
      created_at: null,
      published_at: null,
    },
    cells: [],
    capTable: { entries: ENTRIES, validation: validateCapTable(ENTRIES) },
    grants: [],
    fmvPerShare: 1.95,
    generatedAt: GENERATED_AT,
    calculation: calculation(),
  };
}

function sheet(sheets: XlsxSheet[], name: string): XlsxSheet {
  const found = sheets.find((s) => s.name === name);
  if (!found) throw new Error(`no sheet named ${name}; got ${sheets.map((s) => s.name).join(', ')}`);
  return found;
}

/**
 * Every caption in a sheet, as printed. Column 0 on the two two-column sheets;
 * the waterfall indents its trailing conclusion into column 1, under the
 * security-class column, so both are read.
 */
function captions(s: XlsxSheet, column = 0): string[] {
  return s.rows.map((r) => {
    const cell = r[column];
    return cell === null || cell === undefined ? '' : String(cell);
  });
}

describe('headline label vocabulary', () => {
  it('covers every specialty kind', () => {
    // Driven off SPECIALTY_KINDS rather than a hand-written list: a twelfth
    // engine added without a caption would otherwise silently inherit the 409A
    // wording, which is the bug this exists for.
    expect(SPECIALTY_KINDS.length).toBeGreaterThan(0);
    for (const kind of SPECIALTY_KINDS) {
      const labels = headlineLabels(kind);
      expect(labels, kind).not.toBe(DEFAULT_HEADLINE_LABELS);
      expect(typeof labels.equity === 'string' || labels.equity === null, kind).toBe(true);
      expect(typeof labels.perShare === 'string' || labels.perShare === null, kind).toBe(true);
    }
  });

  it('gives 409A-engine kinds the 409A wording', () => {
    for (const kind of ['409a', '718', 'secondary', 'unknown-future-kind']) {
      expect(headlineLabels(kind)).toEqual(DEFAULT_HEADLINE_LABELS);
    }
    expect(DEFAULT_HEADLINE_LABELS).toEqual({
      equity: 'Concluded equity value',
      perShare: 'Concluded FMV per share',
    });
  });

  it('names the four figures that are not what the column is called', () => {
    // EMI and CSOP conclude on the *actual* market value — the restricted
    // figure the scheme grants at. The unrestricted value is the larger one.
    expect(headlineLabels('emi').perShare).toBe('Actual market value (AMV) per share');
    expect(headlineLabels('csop').perShare).toBe('Actual market value (AMV) per share');
    // An ASC 820 measurement values positions, not equity.
    expect(headlineLabels('820').equity).toBe('Total fair value');
    // A gift & estate appraisal concludes on the transferred interest, which
    // specialtyHeadline picks over the entity value deliberately.
    expect(headlineLabels('gifts').equity).toBe('Concluded value of the transferred interest');
    // An IFRS 2 run concludes an expense.
    expect(headlineLabels('ifrs2').equity).toBe('Total expense');
  });

  it('says nothing rather than captioning a figure the kind never produces', () => {
    // A per-share row on any of these would be a blank cell under a caption
    // that promises a number, which reads as a failed calculation.
    for (const kind of ['820', 'gifts', 'ifrs2', 'fmv'] as const) {
      expect(headlineLabels(kind).perShare, kind).toBeNull();
    }
    for (const kind of ['qsbs', 'ppa', 'goodwill', 'ip'] as const) {
      expect(headlineLabels(kind), kind).toEqual({ equity: null, perShare: null });
    }
  });

  it('captions nothing where specialtyHeadline contributes nothing', () => {
    /*
     * The two halves have to agree in both directions, and only one of them is
     * a judgement about wording: a kind that writes a column and captions
     * nothing hides the figure, and a kind that captions a column it never
     * writes promises one that is always empty.
     *
     * Read off the dispatcher rather than restated — a headline moved from null
     * to a real figure without a caption is exactly the drift this catches.
     */
    const NEVER_WRITES: SpecialtyKind[] = ['qsbs', 'ppa', 'goodwill', 'ip'];
    for (const kind of NEVER_WRITES) {
      const headline = specialtyHeadline(
        kind,
        { path: '/engine/v1/none', body: {} },
        { equity_value: 1, fmv_per_share: 1, total_expense: 1, total_fair_value: 1, concluded_value: 1 },
      );
      expect(headline, kind).toEqual({ equityValue: null, fmvPerShare: null });
      expect(headlineLabels(kind), kind).toEqual({ equity: null, perShare: null });
    }
  });
});

describe('the exported workbook uses the vocabulary', () => {
  it('captions an EMI per-share figure as the actual market value', () => {
    const sheets = valuationWorkbookSheets(input('emi', 'GBP'));
    expect(captions(sheet(sheets, 'Summary'))).toContain('Actual market value (AMV) per share');
    expect(captions(sheet(sheets, 'Summary'))).not.toContain('Concluded FMV per share');
    expect(captions(sheet(sheets, 'Calculation'))).toContain('Actual market value (AMV) per share (GBP)');
    // The waterfall states it too, under the preference stack it is measured
    // against — the third of the three sheets that print this figure.
    const waterfall = captions(sheet(sheets, 'Waterfall'), 1);
    expect(waterfall).toContain('Actual market value (AMV) per share (GBP)');
    expect(waterfall.join('|')).not.toContain('Concluded FMV per share');
  });

  it('does not call an IFRS 2 total expense an equity value', () => {
    const sheets = valuationWorkbookSheets(input('ifrs2'));
    const calc = captions(sheet(sheets, 'Calculation'));
    expect(calc).toContain('Total expense (USD)');
    expect(calc).not.toContain('Concluded equity value (USD)');
    // And no per-share row at all: an IFRS 2 award has a fair value per award,
    // which is not a per-share figure and would be read as one.
    expect(calc.join('|')).not.toContain('per share');
    expect(captions(sheet(sheets, 'Summary')).join('|')).not.toContain('per share');
    expect(captions(sheet(sheets, 'Waterfall'), 1).join('|')).not.toContain('per share');
  });

  it('leaves a 409A workbook exactly as it was', () => {
    const sheets = valuationWorkbookSheets(input('409a'));
    expect(captions(sheet(sheets, 'Summary'))).toContain('Concluded FMV per share');
    expect(captions(sheet(sheets, 'Calculation'))).toContain('Concluded equity value (USD)');
    expect(captions(sheet(sheets, 'Calculation'))).toContain('Concluded FMV per share (USD)');
    expect(captions(sheet(sheets, 'Waterfall'), 1)).toContain('Concluded FMV per share (USD)');
  });

  it('captions the ESOP equity value as the one supplied, not one concluded', () => {
    const sheets = valuationWorkbookSheets(input('esop'));
    expect(captions(sheet(sheets, 'Calculation'))).toContain('Appraised equity value (USD)');
    // The per-share conclusion on an ESOP run *is* a fair market value per
    // share, so that caption is unchanged.
    expect(captions(sheet(sheets, 'Calculation'))).toContain('Concluded FMV per share (USD)');
  });
});

describe('the request builders and the captions describe the same engines', () => {
  it('every specialty kind that dispatches has a caption decision recorded', () => {
    for (const kind of SPECIALTY_KINDS) {
      // `specialtyEngineRequest` throws SpecialtyInputError on missing answers,
      // which is fine — what matters is that the kind is dispatchable at all,
      // so a caption exists for every engine the platform can actually run.
      let dispatches = true;
      try {
        specialtyEngineRequest(kind, {}, {});
      } catch (err) {
        dispatches = (err as Error).constructor.name === 'SpecialtyInputError';
      }
      expect(dispatches, kind).toBe(true);
      expect(headlineLabels(kind), kind).toBeDefined();
    }
  });
});
