import { describe, expect, it } from 'vitest';
import {
  levelOfValueExhibit,
  operatingMetricsExhibit,
  rollforwardExhibit,
  type ExhibitContext,
} from '../../src/domain/reportExhibits.js';

/**
 * Three exhibits whose fallback arms had never rendered: the level-of-value
 * reconciliation, the roll-forward bridge, and Appendix II-1's operating series.
 *
 * `reportExhibitsDegraded.test.ts` makes the general case for why these matter —
 * `results` is jsonb, so a thin shape is not hypothetical but simply *older*,
 * and today's code re-renders a calculation stored a year ago every time
 * somebody reopens the report. What follows is the same argument applied to the
 * three schedules it did not reach.
 *
 * The roll-forward one is the sharpest. Its guard is not about a missing field
 * at all: an *unapplied* run describes an anchor the calculation did not use, so
 * a bridge printed from it would be describing a different valuation than the
 * one the report concludes. That schedule appears in a signed opinion under the
 * client's name.
 */

const CTX: ExhibitContext = {
  currency: 'USD',
  companyName: 'Northwind Robotics, Inc.',
  valuationDate: '2026-06-30',
};

describe('level-of-value reconciliation', () => {
  const withLevels = (over: Record<string, unknown> = {}) => ({
    approaches: {
      income_dcf: { weight: 0.4 },
      market_multiples: { weight: 0.6 },
    },
    discounts: {
      dloc: 0.1,
      dloc_detail: {
        minority_basis_weight: 0.6,
        approach_levels: { income_dcf: 'control', market_multiples: 'minority' },
        ...over,
      },
    },
  });

  it('drops entirely when there are no approach levels to reconcile', () => {
    expect(levelOfValueExhibit({}, CTX)).toBeNull();
    expect(levelOfValueExhibit({ discounts: { dloc_detail: {} } }, CTX)).toBeNull();
  });

  it('drops when the minority basis weight is absent', () => {
    // Without it the exhibit has no denominator for the sentence it exists to
    // write, and half a reconciliation is worse than none.
    const results = withLevels();
    delete (results.discounts.dloc_detail as Record<string, unknown>).minority_basis_weight;
    expect(levelOfValueExhibit(results, CTX)).toBeNull();
  });

  it('derives the control weight as the remainder when it is not stated', () => {
    const html = levelOfValueExhibit(withLevels(), CTX)!.html;
    // 1 − 0.6 = 40% control-based.
    expect(html).toContain('40%');
    expect(html).toContain('60%');
  });

  it('prints an em-dash for an approach carrying no weight', () => {
    // An approach that was struck but not weighted still has a level of value,
    // and the row must say so rather than printing 0% as though it had been
    // weighted to nothing.
    const results = withLevels();
    results.approaches = { income_dcf: {}, market_multiples: { weight: 0.6 } } as never;
    const html = levelOfValueExhibit(results, CTX)!.html;
    expect(html).toContain('—');
  });

  it('prints an unfamiliar level and approach key as themselves', () => {
    // The mapping is a lookup with a fallback rather than an exhaustive switch,
    // precisely so a level the engine grows later reads as itself instead of
    // rendering blank in a signed document.
    const results = withLevels({
      approach_levels: { some_new_approach: 'quasi_marketable' },
    });
    const html = levelOfValueExhibit(results, CTX)!.html;
    expect(html).toContain('some_new_approach');
    expect(html).toContain('quasi_marketable');
  });

  it('carries the appraiser’s own note when the engine flagged double counting', () => {
    // The finding is printed only when `double_counts_minority` is the engine's
    // own judgement, and its note is printed as written rather than re-derived —
    // so this page cannot disagree with the pre-flight warning the analyst saw
    // about the same calculation.
    const withNote = levelOfValueExhibit(
      withLevels({ double_counts_minority: true, note: 'Board elected to hold the discount.' }),
      CTX,
    )!.html;
    expect(withNote).toContain('Board elected to hold the discount.');

    // And falls back to stating the reasoning itself when no note was recorded.
    const without = levelOfValueExhibit(withLevels({ double_counts_minority: true }), CTX)!.html;
    expect(without).toContain('discounts a second time');

    // Not flagged: no finding at all, rather than a finding with empty text.
    const clean = levelOfValueExhibit(withLevels(), CTX)!.html;
    expect(clean).not.toContain('discounts a second time');
  });
});

describe('roll-forward bridge', () => {
  // `prior_valuation_date` is a `date` column, and the driver hands one back as
  // midnight *local* — not the midnight UTC that `new Date('…T00:00:00Z')`
  // builds. The two coincide only on a UTC host, which is why the fixture read
  // that way for as long as it did. See src/domain/calendarDate.ts.
  const pgDate = (y: number, m: number, d: number) => new Date(y, m - 1, d);
  const run = (over: Record<string, unknown> = {}) =>
    ({
      applied_at: new Date('2026-06-30T00:00:00Z'),
      prior_valuation_number: 'V-2025-0007',
      prior_valuation_date: pgDate(2025, 6, 30),
      new_valuation_date: '2026-06-30',
      annual_accretion: 0.25,
      years_elapsed: 1,
      prior_equity_value: 10_000_000,
      rolled_equity_value: 12_500_000,
      material_changes: [],
      requires_full_revaluation: false,
      calibration_steps: [
        { step: 'prior_equity_value', value: 10_000_000 },
        { step: 'time_accretion', value: 12_500_000 },
      ],
      ...over,
    }) as never;

  it('drops when no run is attached at all', () => {
    expect(rollforwardExhibit({}, CTX)).toBeNull();
  });

  it('drops an unapplied run rather than bridging from an anchor nobody used', () => {
    // The guard that matters. A bridge printed from a run the calculation did
    // not adopt describes a different valuation than the one concluded, in a
    // document signed in the client's name.
    expect(rollforwardExhibit({}, { ...CTX, rollforward: run({ applied_at: null }) })).toBeNull();
  });

  it('drops a run whose calibration trail is empty', () => {
    expect(rollforwardExhibit({}, { ...CTX, rollforward: run({ calibration_steps: [] }) })).toBeNull();
  });

  it('reads a date the driver handed back as a Date or as a string alike', () => {
    const asDate = rollforwardExhibit({}, { ...CTX, rollforward: run() })!.html;
    const asString = rollforwardExhibit(
      {},
      { ...CTX, rollforward: run({ prior_valuation_date: '2025-06-30T00:00:00Z' }) },
    )!.html;
    expect(asDate).toContain('2025-06-30');
    expect(asString).toContain('2025-06-30');
  });

  it('omits the prior engagement number when there is none', () => {
    const html = rollforwardExhibit({}, { ...CTX, rollforward: run({ prior_valuation_number: null }) })!.html;
    expect(html).toContain('valued as of 2025-06-30');
    // No stray separator left where the number would have been.
    expect(html).not.toContain(', valued as of');
  });

  it('states the accretion factor only when the step carries one', () => {
    const without = rollforwardExhibit({}, { ...CTX, rollforward: run() })!.html;
    expect(without).not.toContain('factor');

    const withFactor = rollforwardExhibit(
      {},
      {
        ...CTX,
        rollforward: run({
          calibration_steps: [{ step: 'time_accretion', value: 12_500_000, factor: 1.25 }],
        }),
      },
    )!.html;
    expect(withFactor).toContain('1.2500x');
  });

  it('prefers the step’s own rate and horizon over the run’s headline figures', () => {
    // A step that states its own terms is the authority for its own line —
    // otherwise a multi-step trail prints every line at the same rate.
    const html = rollforwardExhibit(
      {},
      {
        ...CTX,
        rollforward: run({
          calibration_steps: [{ step: 'time_accretion', value: 12_500_000, annual_rate: 0.4, years: 2.5 }],
        }),
      },
    )!.html;
    expect(html).toContain('40.0%');
    expect(html).toContain('2.50 years');
  });

  it('names a new priced round and an analyst adjustment for what they are', () => {
    const html = rollforwardExhibit(
      {},
      {
        ...CTX,
        rollforward: run({
          calibration_steps: [
            { step: 'new_round_post_money', value: 20_000_000 },
            { step: 'adjustment', value: -1_000_000, label: 'Litigation reserve' },
          ],
        }),
      },
    )!.html;
    expect(html).toContain('New priced round, post-money');
    expect(html).toContain('Litigation reserve');
  });

  it('labels an unlabelled adjustment, and an unknown step as itself', () => {
    // Exhaustive rather than defaulting: a step the engine grows later reads as
    // itself instead of silently printing under someone else's label.
    const html = rollforwardExhibit(
      {},
      {
        ...CTX,
        rollforward: run({
          calibration_steps: [
            { step: 'adjustment', value: -5_000 },
            { step: 'secondary_transaction_evidence', value: 1_000 },
          ],
        }),
      },
    )!.html;
    expect(html).toContain('Adjustment');
    expect(html).toContain('secondary_transaction_evidence');
  });
});

describe('Appendix II-1 — operating series', () => {
  const sheet = (over: Record<string, unknown> = {}) =>
    ({
      key: 'operating_metrics',
      label: 'Operating metrics',
      columns: [
        { key: 'fy_minus_1', label: 'FY-1' },
        { key: 'fy_current', label: 'FY (current)' },
        { key: 'fy_plus_1', label: 'FY+1' },
      ],
      rows: [
        {
          key: 'arr',
          label: 'Annual recurring revenue',
          format: 'currency',
          cells: [
            { column_key: 'fy_minus_1', value: 4_000_000 },
            { column_key: 'fy_current', value: 6_000_000 },
            { column_key: 'fy_plus_1', value: 9_000_000 },
          ],
        },
        {
          key: 'customers',
          label: 'Customers',
          format: 'number',
          cells: [
            { column_key: 'fy_minus_1', value: null },
            { column_key: 'fy_current', value: null },
          ],
        },
      ],
      ...over,
    }) as never;

  it('drops when the workbook has no operating sheet in it', () => {
    expect(operatingMetricsExhibit(undefined, CTX)).toBeNull();
    expect(operatingMetricsExhibit([], CTX)).toBeNull();
    expect(operatingMetricsExhibit([sheet({ key: 'income_statement' })], CTX)).toBeNull();
  });

  it('ignores a sheet whose shape is not the one it expects', () => {
    // The caller resolved this workbook, and a shape that is not the expected
    // one must drop the appendix rather than throw out of a PDF render.
    expect(operatingMetricsExhibit([null as never, 'nonsense' as never], CTX)).toBeNull();
    expect(
      operatingMetricsExhibit([{ key: 'operating_metrics', columns: 'no', rows: 'no' } as never], CTX),
    ).toBeNull();
  });

  it('reports historical periods and drops the projection columns', () => {
    // The appendix is a record of what happened, not of what is planned —
    // management's operating plan is not an exhibit to this opinion.
    const html = operatingMetricsExhibit([sheet()], CTX)!.html;
    expect(html).toContain('FY-1');
    expect(html).toContain('FY (current)');
    expect(html).not.toContain('FY+1');
  });

  it('drops a row that is empty across every reported period', () => {
    // The workbook's schema is fixed, so a company that does not track customer
    // counts should not be shown a customer row full of dashes.
    const html = operatingMetricsExhibit([sheet()], CTX)!.html;
    expect(html).toContain('Annual recurring revenue');
    expect(html).not.toContain('Customers');
  });

  it('keeps a row that carries a single figure', () => {
    const partial = sheet({
      rows: [
        {
          key: 'employees',
          label: 'Employees (FTE)',
          format: 'number',
          cells: [
            { column_key: 'fy_minus_1', value: null },
            { column_key: 'fy_current', value: 48 },
          ],
        },
      ],
    });
    const html = operatingMetricsExhibit([partial], CTX)!.html;
    expect(html).toContain('Employees (FTE)');
    expect(html).toContain('48');
  });

  it('drops the appendix when every row is empty', () => {
    const blank = sheet({
      rows: [
        {
          key: 'arr',
          label: 'Annual recurring revenue',
          format: 'currency',
          cells: [{ column_key: 'fy_current', value: null }],
        },
      ],
    });
    expect(operatingMetricsExhibit([blank], CTX)).toBeNull();
  });

  it('drops it when every column is a projection', () => {
    const forecastOnly = sheet({ columns: [{ key: 'fy_plus_1', label: 'FY+1' }] });
    expect(operatingMetricsExhibit([forecastOnly], CTX)).toBeNull();
  });

  it('prints an em-dash for a row or column with no label', () => {
    const unlabelled = sheet({
      columns: [{ key: 'fy_current' }],
      rows: [{ key: 'arr', format: 'currency', cells: [{ column_key: 'fy_current', value: 6_000_000 }] }],
    });
    const html = operatingMetricsExhibit([unlabelled], CTX)!.html;
    expect(html).toContain('—');
  });
});
