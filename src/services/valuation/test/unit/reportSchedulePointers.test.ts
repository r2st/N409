import { describe, expect, it } from 'vitest';
import {
  CLASS_VOLATILITY_SCHEDULE,
  DISCOUNT_RATE_SCHEDULE,
  RENDER_RESOLVED_MARKERS,
  TEMPLATE_VAR_NAMES,
  templateForKind,
} from '../../src/domain/report.js';
import { SCHEDULE_CATALOGUE, buildExhibits } from '../../src/domain/reportExhibits.js';
import { reportFigures } from '../../src/domain/reportFigures.js';
import { VALUATION_KINDS } from '../../src/domain/valuation.js';
import type { CalculationRow } from '../../src/repos/calculations.js';

/**
 * The schedules the report builds, and whether the body ever mentions them.
 *
 * A 409A ships up to twenty-one schedules. Eleven of them were built, indexed
 * and printed with no chapter naming any of them: the guideline company set,
 * the discount-rate build-up, the historical statements, the operating metrics,
 * the stage-return ladder, the PWERM scenarios, the OPM arithmetic, both
 * allocation sensitivities, the level-of-value classification and the
 * roll-forward. Every one is the supporting detail for a chapter that exists —
 * and a reader reached it only by leafing through the back of the report,
 * which for the peer set and the discount-rate build-up is the difference
 * between a supported conclusion and an asserted one.
 *
 * Nothing caught it because both halves were individually right: `reportReview`
 * grades a pointer at a schedule that was *not* built (`dangling_exhibit_
 * reference`), and no check asked the opposite question. This is that question.
 */

const CATALOGUE_IDS = SCHEDULE_CATALOGUE.map((s) => s.id);

/** Every `{{#exhibit:X}}` id the 409A body is conditional on. */
function conditionalIds(html: string): Set<string> {
  return new Set([...html.matchAll(/\{\{#exhibit:([A-Za-z0-9-]+)\}\}/g)].map((m) => m[1]!));
}

const template409a = templateForKind('409a');
const body409a = template409a.sections.map((s) => s.html).join('\n');

describe('every schedule the report prints is named by a chapter', () => {
  const pointers = conditionalIds(body409a);

  it.each(CATALOGUE_IDS)('%s is pointed at from the body', (id) => {
    const descriptor = SCHEDULE_CATALOGUE.find((s) => s.id === id)!;
    if (descriptor.always) {
      /*
       * A schedule printed on every report needs no condition, and the four
       * that are — the cap table, the reconciliation, the allocation and the
       * discounts — are named in prose. Asserting on the printed name rather
       * than on a pointer is deliberate: wrapping an unconditional schedule in
       * `EXHIBIT_IF` would make its mention disappear on the one run where the
       * builder unexpectedly returned nothing, which is the run a reader most
       * needs to see the gap on.
       */
      expect(body409a, `Exhibit ${id} is always printed and no chapter names it`).toContain(
        `${descriptor.kind} ${id}</strong>`,
      );
      return;
    }
    expect(
      pointers,
      `${descriptor.kind} ${id} — ${descriptor.name} — is built and never pointed at`,
    ).toContain(id);
  });

  it('points at nothing that is not a schedule or a declared sub-block', () => {
    // The other direction, and the one `reportReview` already grades at render
    // time — here at build time, so a typo in a skeleton is a failing test
    // rather than a chapter that silently drops out of every report.
    const known = new Set<string>([...CATALOGUE_IDS, CLASS_VOLATILITY_SCHEDULE, DISCOUNT_RATE_SCHEDULE]);
    for (const kind of VALUATION_KINDS) {
      for (const section of templateForKind(kind).sections) {
        for (const id of conditionalIds(section.html)) {
          expect(known, `${kind}/${section.key} points at ${id}`).toContain(id);
        }
      }
    }
  });

  it('closes every conditional block it opens', () => {
    // `{{#exhibit:F-2}}` with a mistyped closing tag is not dropped — the
    // regex simply does not match, and both markers print literally in the PDF.
    for (const kind of VALUATION_KINDS) {
      for (const section of templateForKind(kind).sections) {
        const opens = [...section.html.matchAll(/\{\{#exhibit:([A-Za-z0-9-]+)\}\}/g)].map((m) => m[1]!);
        const closes = [...section.html.matchAll(/\{\{\/exhibit:([A-Za-z0-9-]+)\}\}/g)].map((m) => m[1]!);
        expect(closes.sort(), `${kind}/${section.key}`).toEqual(opens.sort());
      }
    }
  });
});

/**
 * The producibility guard, extended into the blocks it could not see.
 *
 * `reportPdfAllKinds` asserts that every `{{figure}}` in a skeleton has a
 * producer in `reportFigures` — but it reads the body *after*
 * `resolveExhibitReferences` has run against an empty exhibit list, so every
 * marker inside an `{{#exhibit:…}}` block is dropped before it is checked. That
 * is precisely where the income approach's assumptions live, and it is where a
 * permanently-literal placeholder would be hardest to notice: it appears only
 * on the reports that built the schedule, which are the reports that go out.
 */
const FULLY_POPULATED = {
  status: 'succeeded',
  inputs: { inputs: {} },
  results: {
    fmv_per_share: 1.2345,
    equity_value: 42_000_000,
    common_equity_value: 19_500_000,
    fully_diluted_common: 8_000_000,
    marketable_value_per_share: 2.4375,
    discounts: { dloc: 0.1, dlom: 0.25 },
    assumptions: { volatility: 0.65, risk_free_rate: 0.042, time_to_exit_years: 3.5 },
    market_movement: { factor: 1.0412, index_return: 0.0824, index_name: 'S&P 500' },
    approaches: {
      income: {
        discount_rate: 0.25,
        forecast_years: 5,
        terminal_method: 'gordon',
        terminal_detail: { terminal_growth: 0.03 },
      },
    },
  },
} as unknown as CalculationRow;

describe('a figure inside a conditional block still has a producer', () => {
  it('resolves every marker in every skeleton, blocks included', () => {
    const producible = new Set(Object.keys(reportFigures(FULLY_POPULATED, 'USD')));
    expect(producible.size).toBeGreaterThan(10);

    for (const kind of VALUATION_KINDS) {
      for (const section of templateForKind(kind).sections) {
        for (const m of section.html.matchAll(/\{\{([a-z0-9_]+)\}\}/g)) {
          const name = m[1]!;
          if (TEMPLATE_VAR_NAMES.has(name)) continue;
          if (RENDER_RESOLVED_MARKERS.has(name)) continue;
          expect(
            producible.has(name),
            `${kind}/${section.key}: {{${name}}} has no producer in reportFigures`,
          ).toBe(true);
        }
      }
    }
  });
});

/**
 * The three assumptions the income chapter now states.
 *
 * "Missing key assumptions" is the standard finding against a 409A that fails
 * review, and the discount rate is what it is usually about. Exhibit C has
 * printed it for as long as the exhibit has existed; the chapter that describes
 * the approach could only instruct an author to state it, and where nobody
 * typed over the instruction the delivered report described a DCF and never
 * said what rate it discounted at.
 */
describe('the income approach states what it assumed', () => {
  const calc = (income: Record<string, unknown>, requested: Record<string, unknown> = {}) =>
    ({
      status: 'succeeded',
      inputs: { inputs: { income: requested } },
      results: { approaches: { income } },
    }) as unknown as CalculationRow;

  it('states the rate, the forecast length and the Gordon growth rate', () => {
    const figures = reportFigures(
      calc({
        discount_rate: 0.25,
        forecast_years: 5,
        terminal_method: 'gordon',
        terminal_detail: { terminal_growth: 0.03 },
      }),
      'USD',
    );
    expect(figures.discount_rate).toBe('25.00%');
    expect(figures.forecast_years).toBe('5');
    expect(figures.terminal_basis).toBe('a perpetual growth rate of 3.00% beyond the forecast period');
  });

  it('names the exit multiple and its denominator instead, where that was the method', () => {
    /*
     * The reason this is one prose figure rather than a `{{terminal_growth}}`
     * rate: an exit-multiple terminal value has no growth rate, so a rate
     * placeholder would resolve on one of the two methods and stay literal on
     * the other — in a signed PDF, on whichever half of the engagements used
     * the method nobody tested.
     */
    const figures = reportFigures(
      calc({
        discount_rate: 0.22,
        forecast_years: 7,
        terminal_method: 'exit_multiple',
        terminal_detail: { exit_multiple: 8, terminal_metric_basis: 'ebitda' },
      }),
      'USD',
    );
    expect(figures.terminal_basis).toBe('an exit multiple of 8.0x applied to the terminal-year EBITDA');
    expect(figures.discount_rate).toBe('22.00%');
  });

  it('falls back to the request for a calculation stored before the engine recorded it', () => {
    // `income_dcf` records the rate on the result now; every calculation stored
    // before it did has the rate only on the request it was called with, and
    // those reports must re-render with the figure rather than the marker.
    const figures = reportFigures(
      calc(
        { pv_explicit: 3_100_000 },
        { discount_rate: 0.28, terminal_growth: 0.025, free_cash_flows: [1, 2, 3] },
      ),
      'USD',
    );
    expect(figures.discount_rate).toBe('28.00%');
    expect(figures.forecast_years).toBe('3');
    expect(figures.terminal_basis).toBe('a perpetual growth rate of 2.50% beyond the forecast period');
  });

  it('produces no rate at all where neither the result nor the request has one', () => {
    /*
     * The case `DISCOUNT_RATE_SCHEDULE` exists for. A run that reused a prior
     * period's income approach has the approach on the result and no rate
     * anywhere — so `{{discount_rate}}` must be absent from the figures, and
     * the sentence that names it must be dropped with Exhibit C's rate row.
     */
    const figures = reportFigures(calc({ pv_explicit: 3_100_000 }), 'USD');
    expect(figures.discount_rate).toBeUndefined();
  });

  it('says nothing about the income approach where none was run', () => {
    const figures = reportFigures(
      {
        status: 'succeeded',
        inputs: { inputs: {} },
        results: { fmv_per_share: 1 },
      } as unknown as CalculationRow,
      'USD',
    );
    expect(figures.discount_rate).toBeUndefined();
    expect(figures.terminal_basis).toBeUndefined();
  });
});

describe('Exhibit C declares whether it printed a rate', () => {
  const ctx = { currency: 'USD', valuationDate: '2026-06-30' } as Parameters<typeof buildExhibits>[1];

  const run = (income: Record<string, unknown>, requested: Record<string, unknown>) =>
    buildExhibits(
      {
        status: 'succeeded',
        inputs: { inputs: { income: requested } },
        results: { approaches: { income } },
      } as unknown as CalculationRow,
      ctx,
    ).find((s) => s.heading.startsWith('Exhibit C '));

  it('declares the sub-block when the rate is on the result', () => {
    const c = run({ discount_rate: 0.25, equity_value: 1 }, { free_cash_flows: [1, 2] });
    expect(c?.schedules).toContain(DISCOUNT_RATE_SCHEDULE);
  });

  it('does not declare it when there is no rate to print', () => {
    const c = run({ equity_value: 1 }, { free_cash_flows: [1, 2] });
    expect(c).toBeDefined();
    expect(c?.schedules ?? []).not.toContain(DISCOUNT_RATE_SCHEDULE);
  });
});
