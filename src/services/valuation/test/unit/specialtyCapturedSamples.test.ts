/**
 * The six exhibits that had never been rendered against real engine output.
 *
 * Four kinds had captured payloads — 820, gifts, IFRS 2 and (as of R135) IP.
 * The other six did not, and R135's own note said what that costs: the IP
 * exhibit read six field names `value_intangible` does not return, every row it
 * built was dropped, and the deliverable for an asset priced by a discounted
 * royalty stream was one sentence stating a number. Nothing failed, because the
 * only payloads it had ever been shown were invented to match it.
 *
 * These are the remaining six, each rendered from `specialtySamples.ts` — JSON
 * the Python actually returned. Three findings, all of them things the HTML
 * tests could not have asked about because they were asserting on payloads
 * written to satisfy them:
 *
 *   - the PPA table printed `relief_from_royalty` and `meem`, the engine's own
 *     dispatch keys, in the Method column of a client deliverable;
 *   - the SMB method table printed no rate and no multiple, so the one
 *     arithmetic step each method takes was unstated and its conclusion
 *     uncheckable;
 *   - the EMI/CSOP exhibit had no line for `grant_umv`, which the result-key
 *     census excused as "the concluded UMV per share" — a different figure by
 *     five orders of magnitude.
 *
 * The last two are nested figures: `methods.*.cap_rate` and
 * `qualification.grant_umv` sit one level below a key the census counts as
 * read.
 */

import { describe, expect, it } from 'vitest';
import { buildSpecialtyExhibits } from '../../src/domain/specialtyExhibits.js';
import {
  SAMPLE_CSOP_RESULT,
  SAMPLE_EMI_RESULT,
  SAMPLE_IFRS2_CASH_RESULT,
  SAMPLE_IMPAIRMENT_LONG_LIVED_RESULT,
  SAMPLE_IP_COST_RESULT,
  SAMPLE_IP_MEEM_RESULT,
  SAMPLE_IP_RESULT,
  SAMPLE_IP_WWW_RESULT,
  SAMPLE_ESOP_RESULT,
  SAMPLE_FMV_RESULT,
  SAMPLE_GOODWILL_RESULT,
  SAMPLE_PPA_RESULT,
  SAMPLE_QSBS_RESULT,
} from '../../src/domain/specialtySamples.js';
import type { CalculationRow } from '../../src/repos/calculations.js';

const ctx = { currency: 'USD', companyName: 'Northwind Robotics, Inc.', valuationDate: '2026-03-31' };

function calc(kind: string, specialty: Record<string, unknown>): CalculationRow {
  return {
    id: '01J',
    valuation_id: '01K',
    engine_version: 'test',
    status: 'succeeded',
    inputs: {},
    results: { kind, specialty },
    equity_value: null,
    fmv_per_share: null,
    error: null,
    diagnostics: [],
    created_by: null,
    created_at: new Date(),
  };
}

function html(kind: string, specialty: Record<string, unknown>, currency = 'USD'): string {
  const sections = buildSpecialtyExhibits(calc(kind, specialty), { ...ctx, currency });
  expect(sections.length, `${kind} rendered no exhibit`).toBeGreaterThan(0);
  return sections.map((s) => s.html).join('\n');
}

/** Cell text, with the tags gone, so an assertion cannot pass on markup. */
const cells = (out: string): string[] =>
  [...out.matchAll(/<t[dh]>(.*?)<\/t[dh]>/g)].map((m) => m[1]!.replace(/<[^>]+>/g, '').trim());

describe('§1202 QSBS, against the payload qsbs_eligibility returns', () => {
  const out = () => html('qsbs', SAMPLE_QSBS_RESULT);

  it('prints every requirement with its own basis', () => {
    expect(cells(out())).toContain('Gross asset test');
    expect(out()).toContain('before issuance $41,000,000, immediately after $56,500,000, limit $75,000,000');
  });

  /**
   * The tier table renders only above one row, and only the post-OBBBA regime
   * has more than one. A pre-amendment sample would have exercised the guard
   * and not the table.
   */
  it('prints the tiered exclusion schedule with the tier not yet reached', () => {
    const out2 = out();
    expect(out2).toContain('2028-09-15');
    expect(out2).toContain('2029-09-15');
    expect(out2).toContain('2030-09-15');
    expect(cells(out2)).toContain('Not yet');
    expect(cells(out2)).toContain('Reached');
  });

  /** 75% now against a 100% ceiling — the two figures that were one field. */
  it('separates the exclusion available now from the ceiling', () => {
    expect(out()).toContain('exclusion percentage 75%, rising to 100% once fully held');
  });

  it('states the holding period against the three-year requirement, not five', () => {
    expect(out()).toContain('4.5 years held against the 3-year requirement — met (3-year date 2028-09-15)');
  });

  /**
   * §1202(b)(1) takes the *greater* of the lifetime remaining and ten times
   * basis, so the applicable cap is above two of the rows above it. Each of the
   * four components is a different number here; a row wired to the wrong field
   * would print a wrong one rather than the right one by coincidence.
   */
  it('prints all four cap components and the greater-of conclusion', () => {
    const c = cells(out());
    expect(c).toContain('$15,000,000'); // lifetime cap
    expect(c).toContain('$3,000,000'); // previously excluded
    expect(c).toContain('$12,000,000'); // lifetime remaining
    expect(c).toContain('$24,000,000'); // ten times basis, and the applicable cap
  });
});

describe('ASC 805 purchase price allocation', () => {
  const out = () => html('ppa', SAMPLE_PPA_RESULT);

  /**
   * `purchase_price_allocation` splices each method result in whole, so
   * `method` arrives as the dispatch key. The exhibit printed it with
   * `esc(String(...))` and "relief_from_royalty" reached the page.
   */
  it('names the methods in the words a report uses', () => {
    const c = cells(out());
    expect(c).toContain('Relief from royalty');
    expect(c).toContain('Multi-period excess earnings');
    expect(c).not.toContain('relief_from_royalty');
    expect(c).not.toContain('meem');
  });

  /**
   * The fair value in the allocation is already grossed up by the tax
   * amortization benefit. Stating only the grossed figure gives a reviewer no
   * way to see the step was taken.
   */
  it('shows each asset before the TAB and the factor applied to it', () => {
    const c = cells(out());
    expect(c).toContain('$2,329,892'); // developed technology before TAB
    expect(c).toContain('1.0750');
    expect(c).toContain('$2,504,571'); // and after
    expect(c).toContain('$3,626,939'); // customer relationships before TAB
    expect(c).toContain('1.0826');
  });

  it('takes goodwill as the residual and reconciles to the consideration', () => {
    const c = cells(out());
    expect(c).toContain('$48,000,000');
    expect(c).toContain('$7,419,647'); // total identifiable intangibles
    expect(c).toContain('$10,119,647'); // identifiable net assets
    expect(c).toContain('$37,880,353'); // goodwill
    expect(c).toContain('Goodwill (residual)');
  });

  /** A payload with no TAB (include_tab: false) drops the columns, not the table. */
  it('falls back to three columns when the method reported no TAB', () => {
    const out2 = html('ppa', {
      consideration_transferred: 5_000_000,
      tangible_net_assets: 1_000_000,
      total_intangible_value: 900_000,
      identifiable_net_assets: 1_900_000,
      goodwill: 3_100_000,
      bargain_purchase_gain: 0,
      intangibles: [{ name: 'Trade name', method: 'cost_approach', fair_value: 900_000 }],
    });
    expect(out2).toContain('Cost approach');
    expect(out2).not.toContain('Before TAB');
    expect(cells(out2)).toContain('$900,000');
  });
});

describe('ASC 350 goodwill impairment', () => {
  const out = () => html('goodwill', SAMPLE_GOODWILL_RESULT);

  it('names the reporting unit and prints the negative headroom', () => {
    expect(out()).toContain('Robotics Systems');
    expect(cells(out())).toContain('-$3,300,000');
  });

  it('captions the loss as a loss, and carries goodwill after it', () => {
    const c = cells(out());
    expect(c).toContain('Impairment loss');
    expect(c).toContain('$3,300,000');
    expect(c).toContain('$9,500,000');
  });

  /** The quantitative test was performed, so neither step-zero caption fires. */
  it('says nothing about a qualitative assessment that was not elected', () => {
    expect(out()).not.toContain('350-20-35-3');
  });
});

describe('ESOP level of value', () => {
  const out = () => html('esop', SAMPLE_ESOP_RESULT);

  /**
   * A control-basis engagement steps *down* through both discounts. The DLOC is
   * derived from a 22% control premium rather than supplied, so the rate on the
   * exhibit is an engine figure and not an echo of an input — 1 − 1/1.22, which
   * is 18.0328% and not 18%.
   *
   * The ladder is the derivation: each amount is the one above it less the rate
   * in its own label, and this is the exhibit a DOL reviewer recomputes. Stated
   * at a tenth of a point it could not be recomputed — $62,000,000 × 0.82 is
   * $50,840,000, $20,328 away from the marketable minority value on the very
   * next line. The DLOM is a round 12% and still reads as one.
   */
  it('orders the ladder from the appraised control value downward', () => {
    const c = cells(out());
    expect(c).toContain('Control');
    expect(c).toContain('$62,000,000');
    expect(c).toContain('Marketable minority (DLOC 18.0328%)');
    expect(c).toContain('$50,819,672');
    expect(c).toContain('Nonmarketable minority (DLOM 12.0%)');
    expect(c).toContain('$44,721,311');
    // The rate stated reproduces the amount beneath it, to the dollar.
    expect(Math.round(62_000_000 * (1 - 0.180328))).toBe(50_819_664);
  });

  it('prints the divisor the per-share conclusion was reached by', () => {
    expect(out()).toContain('Fair market value per share (4,000,000 shares outstanding)');
    expect(cells(out())).toContain('$11.1803');
  });

  /**
   * The per-year present values are the point of a repurchase study — the
   * obligation is a funding schedule, and a foot stating one PV for the whole
   * of it says how much and not when. They were dropped for every ESOP
   * engagement ever run.
   */
  it('prints the repurchase projection year by year with its present value', () => {
    const c = cells(out());
    expect(c).toContain('Present value');
    expect(c).toContain('$845,233'); // year 1 cost
    expect(c).toContain('$761,471'); // and its present value
    expect(c).toContain('1,128,000'); // year 1 remaining shares
    expect(c).toContain('$751,330'); // year 10 cost
    expect(c).toContain('$264,607'); // year 10 present value
    expect(c).toContain('$7,974,624'); // total
    expect(c).toContain('$4,748,503'); // and its present value
  });

  /** A run with no discount rate has no present values to print. */
  it('drops the present-value column when the projection was not discounted', () => {
    const undiscounted = {
      ...SAMPLE_ESOP_RESULT,
      repurchase_obligation: {
        schedule: [
          {
            year: 1,
            share_price: 11.74,
            shares_redeemed: 72_000,
            repurchase_cost: 845_233,
            remaining_shares: 1_128_000,
          },
        ],
        total_obligation: 845_233,
      },
    };
    const out2 = html('esop', undiscounted);
    expect(out2).not.toContain('Present value');
    expect(cells(out2)).toContain('$845,233');
  });
});

describe('SMB fair market value', () => {
  const out = () => html('fmv', SAMPLE_FMV_RESULT);

  it('normalizes to SDE through both addbacks and both deductions', () => {
    const c = cells(out());
    expect(c).toContain('Less: One time income');
    expect(c).toContain('Less: Fair market replacement wage');
    expect(c).toContain('$1,032,000');
  });

  /**
   * Every SMB method is one arithmetic step and each result carries both
   * operands, nested inside `methods`. The table printed the answers only:
   * three names, three amounts, three weights, no rate and no multiple.
   */
  it('states the rate or multiple each indicated value came from', () => {
    const c = cells(out());
    expect(c).toContain('SDE $1,032,000 ÷ 16.9%');
    expect(c).toContain('SDE $1,032,000 × 3.10');
    expect(c).toContain('Revenue $4,150,000 × 0.85');
  });

  it('derives the capitalization rate from the build-up and the growth rate', () => {
    expect(out()).toContain(
      'The capitalization rate is the build-up discount rate of 19.9% less long-term growth of 3.0%, or 16.9%.',
    );
  });

  it('spells the method names rather than humanizing the dispatch keys', () => {
    const c = cells(out());
    expect(c).toContain('SDE multiple');
    expect(c).not.toContain('Sde multiple');
  });

  it('weights the three indications to the conclusion', () => {
    const c = cells(out());
    expect(c).toContain('$6,106,509');
    expect(c).toContain('$3,199,200');
    expect(c).toContain('$3,527,500');
    expect(c).toContain('$4,266,003');
  });

  /** A run with no capitalization method has no cap rate to derive. */
  it('omits the capitalization-rate sentence when that method did not run', () => {
    const out2 = html('fmv', {
      methods: { sde_multiple: { sde: 500_000, multiple: 3, equity_value: 1_500_000 } },
      weights: { sde_multiple: 1 },
      equity_value: 1_500_000,
    });
    expect(out2).not.toContain('capitalization rate');
    expect(cells(out2)).toContain('SDE $500,000 × 3.00');
  });
});

describe('EMI and CSOP', () => {
  /**
   * `grant_umv` is the aggregate UMV of the grant — £175,500 here — and the
   * census excused it as "the concluded UMV per share", which is £1.95. Under
   * EMI the individual limit adds £60,000 of prior grants on top, so the
   * £235,500 the check states is neither figure.
   */
  it('prints the grant total, the individual total and the company total apart', () => {
    const c = cells(html('emi', SAMPLE_EMI_RESULT));
    expect(c).toContain('$1.9500'); // UMV per share
    expect(c).toContain('$175,500'); // this grant
    expect(c).toContain('$235,500'); // with prior grants, against the individual limit
    expect(c).toContain('$1,575,500'); // against the company limit
  });

  /** With no prior grants the two are one figure, and a repeated row reads as an error. */
  it('does not repeat the grant as an individual total when they are the same', () => {
    const c = cells(html('csop', SAMPLE_CSOP_RESULT));
    expect(c.filter((t) => t === '$175,500')).toHaveLength(1);
    expect(c).not.toContain('Counted against the individual limit, with prior grants');
  });

  it('names the scheme schedule the checks come from', () => {
    expect(cells(html('emi', SAMPLE_EMI_RESULT))).toContain('Schedule 5 check');
    expect(cells(html('csop', SAMPLE_CSOP_RESULT))).toContain('Schedule 4 check');
  });

  it('spells UMV in the check names', () => {
    const c = cells(html('csop', SAMPLE_CSOP_RESULT));
    expect(c).toContain('Exercise price not below UMV');
    expect(c).not.toContain('Exercise price not below umv');
  });

  it('carries the failed check through to the qualification conclusion', () => {
    const out2 = html('csop', SAMPLE_CSOP_RESULT);
    expect(out2).toContain('£175,500 UMV against the £60,000 limit');
    expect(cells(out2)).toContain('Fail');
    expect(out2).toContain('Scheme qualification: <strong>does not qualify</strong>');
  });

  /**
   * The engine writes its check details in sterling because the limits are
   * statutory sterling amounts; the per-share rows follow the engagement. A
   * non-sterling engagement therefore prints both symbols, and used to do so
   * with nothing saying why.
   */
  it('says so when the engagement currency is not the currency of the limits', () => {
    expect(html('emi', SAMPLE_EMI_RESULT, 'USD')).toContain('statutory sterling amounts');
    expect(html('emi', SAMPLE_EMI_RESULT, 'GBP')).not.toContain('statutory sterling amounts');
  });
});

/**
 * Three more payloads, for shapes one run of an engine cannot produce. Each is
 * a block the census had no way to sweep, because the only sample for its kind
 * did not contain it:
 *
 *   - `remeasurement` has contents only for a cash-settled award, and it is the
 *     block R134 found dropped in the first place;
 *   - `obsolescence` belongs to the cost approach, and the IP sample is an
 *     income method — R135 named it as unswept;
 *   - `recoverable` and `undiscounted_cash_flows_total` belong to the ASC 360
 *     test, a different function behind the same exhibit as goodwill.
 */
describe('IFRS 2, cash-settled', () => {
  const out = () => html('ifrs2', SAMPLE_IFRS2_CASH_RESULT);

  it('prints the liability, its grant-date measure and the change between them', () => {
    const c = cells(out());
    expect(c).toContain('$0.9125'); // fair value per award at the reporting date
    expect(c).toContain('$343,100'); // liability carried at fair value
    expect(c).toContain('$280,616'); // liability at grant-date fair value
    expect(out()).toContain('$62,484, recognised in profit or loss for the period');
  });

  it('states the standard the remeasurement follows from', () => {
    expect(out()).toContain('IFRS 2.30-33');
  });

  /** Non-market performance, so the expense is trued up to what actually vests. */
  it('states the true-up rule for the condition this award carries', () => {
    expect(out()).toContain('IFRS 2.19');
    expect(out()).toContain('trued up to the number of awards that actually vest');
  });

  it("names the settlement and the condition in the standard's words", () => {
    const c = cells(out());
    expect(c).toContain('Cash-settled');
    expect(c).toContain('Non-market performance condition');
    expect(c).not.toContain('Performance non market');
  });

  it('groups the award counts', () => {
    const c = cells(out());
    expect(c).toContain('400,000');
    expect(c).toContain('376,000');
    expect(c).not.toContain('400000');
  });
});

describe('the intangible cost approach', () => {
  const out = () => html('ip', SAMPLE_IP_COST_RESULT);

  it('takes each obsolescence layer off in turn', () => {
    const c = cells(out());
    expect(c).toContain('$5,382,000'); // replacement cost new with the incentives
    // The rate beside the amount: the layers compound, so a reader given only
    // the amounts cannot recover the percentage any of them was estimated at.
    expect(c).toContain('Less physical obsolescence (10.0%)');
    expect(c).toContain('$538,200');
    expect(c).toContain('Less functional obsolescence (18.0%)');
    expect(c).toContain('$871,884');
    expect(c).toContain('Less economic obsolescence (7.0%)');
    expect(c).toContain('$278,034');
    expect(c).toContain('$3,693,882');
  });

  /**
   * 10%, then 18% of what is left, then 7% of what is left after that. A reader
   * who adds the three percentages gets 35% and the wrong answer, which is what
   * the note exists to prevent.
   */
  it('says the layers compound rather than sum', () => {
    expect(out()).toContain('The obsolescence layers compound');
  });

  it('names the method rather than the dispatch key', () => {
    expect(out()).toContain('<strong>Cost approach</strong>');
    expect(out()).not.toContain('cost_approach');
  });

  it('prints the incentives that built the replacement cost new', () => {
    const c = cells(out());
    expect(c).toContain("Developer's profit");
    expect(c).toContain('12.0%');
    expect(c).toContain('Entrepreneurial incentive');
    expect(c).toContain('5.0%');
  });
});

/**
 * The rates the intangible engines run on.
 *
 * They are inputs, and `value_intangible` did not echo them, so nothing in the
 * result carried them and the exhibit had nothing to read. That left the
 * discount rate, the royalty rate and the tax rate off the page — the three
 * figures a reviewer checks a relief-from-royalty conclusion against, absent
 * from the schedule that was discounted at them. R135 named it and put the fix
 * on the engine side, which is where it went.
 */
describe('the intangible assumptions', () => {
  it('prints every rate a relief-from-royalty conclusion turns on', () => {
    const c = cells(html('ip', SAMPLE_IP_RESULT));
    expect(c).toContain('Royalty rate');
    expect(c).toContain('5.0%');
    expect(c).toContain('Tax rate');
    expect(c).toContain('21.0%');
    expect(c).toContain('Discount rate');
    expect(c).toContain('17.0%');
    expect(c).toContain('Terminal growth rate');
    expect(c).toContain('2.0%');
  });

  /** A result stored before the engines echoed them has no table, not an empty one. */
  it('drops the table for a result computed before the rates were echoed', () => {
    const { assumptions: _dropped, ...legacy } = SAMPLE_IP_RESULT as Record<string, unknown>;
    const out = html('ip', legacy);
    expect(out).not.toContain('Assumption');
    expect(out).toContain('Royalty savings'); // and the rest of the exhibit is unchanged
  });

  /**
   * On a PPA the discount rate is the figure a reviewer reconciles across the
   * assets — the WACC/IRR/WARA check — so it is a column of the allocation
   * table rather than a per-asset restatement of the method's workings.
   */
  it('carries each asset\u2019s discount rate onto the allocation table', () => {
    const c = cells(html('ppa', SAMPLE_PPA_RESULT));
    expect(c).toContain('Discount rate');
    expect(c).toContain('18.5%'); // developed technology
    expect(c).toContain('16.5%'); // customer relationships
    expect(c).toContain('17.0%'); // trade name
    // And not the rest of the method payload.
    expect(c).not.toContain('Royalty rate');
  });

  it('drops the discount-rate column for an allocation with no rates on it', () => {
    const bare = {
      ...(SAMPLE_PPA_RESULT as Record<string, unknown>),
      intangibles: [{ name: 'Trade name', method: 'cost_approach', fair_value: 900_000 }],
    };
    const out = html('ppa', bare);
    expect(out).not.toContain('Discount rate');
    expect(cells(out)).toContain('$900,000');
  });
});

/**
 * MEEM and with-and-without, through the IP exhibit.
 *
 * Neither had ever been rendered from real engine output. MEEM's only captured
 * payload was inside the PPA sample, spliced in beside a name — and the PPA
 * exhibit deliberately does not restate a per-asset method's workings, so the
 * three MEEM assumption captions and the nine-column earnings chain were
 * asserted against nothing. With-and-without had no captured payload at all,
 * and its columns were pinned only by fixtures built to match the exhibit,
 * which is precisely how the IP schedule came to read six field names
 * `value_intangible` has never returned.
 */
describe('the other two intangible income methods', () => {
  describe('multi-period excess earnings', () => {
    const out = () => html('ip', SAMPLE_IP_MEEM_RESULT);

    it('names the three rates only MEEM has', () => {
      const c = cells(out());
      expect(c).toContain('Customer attrition rate');
      expect(c).toContain('12.0%');
      expect(c).toContain('EBIT margin');
      expect(c).toContain('24.0%');
      expect(c).toContain('Contributory asset charges, as a share of attributable revenue');
      expect(c).toContain('7.0%');
      // `label()` would have rendered the engine's key as "Contributory
      // charges pct" — the caption is written, not derived.
      expect(out()).not.toContain('contributory_charges_pct');
    });

    it('builds the earnings and then charges the contributory assets against them', () => {
      const c = cells(out());
      // The chain is split across two tables at the figure they share; both
      // halves have to be on the page or the deduction is unexplained.
      expect(c).toContain('Attributable revenue');
      expect(c).toContain('Contributory charge');
      expect(c).toContain('Excess earnings');
      expect(c).toContain('$9,292,800'); // year 2 attributable revenue, after 12% attrition
      expect(c).toContain('88.0%'); // …and the survival that produced it
      expect(c).toContain('$650,496'); // its contributory charge
      expect(c).toContain('$1,111,419'); // and what is left as excess earnings
    });

    it('carries the TAB step-up to the concluded value', () => {
      const c = cells(out());
      expect(c).toContain('$3,356,716'); // before the tax amortization benefit
      expect(c).toContain('$3,620,581'); // after it
      expect(out()).toContain('<strong>Multi-period excess earnings</strong>');
    });
  });

  describe('with and without', () => {
    const out = () => html('ip', SAMPLE_IP_WWW_RESULT);

    it('sets the two scenarios side by side', () => {
      const c = cells(out());
      expect(c).toContain('With the asset');
      expect(c).toContain('Without the asset');
      expect(c).toContain('After-tax differential');
      expect(c).toContain('$4,620,000'); // year 2 with
      expect(c).toContain('$4,250,000'); // year 2 without
      expect(c).toContain('$292,300'); // the after-tax differential between them
    });

    it('prints the two rates the method turns on, and no others', () => {
      const c = cells(out());
      expect(c).toContain('Tax rate');
      expect(c).toContain('21.0%');
      expect(c).toContain('Discount rate');
      expect(c).toContain('19.0%');
      // The method has no royalty, no margin and no attrition; the assumption
      // table is built from what the result carries, not from the full list.
      expect(c).not.toContain('Royalty rate');
      expect(c).not.toContain('EBIT margin');
    });

    it('concludes on the differential, grossed up by the TAB', () => {
      const c = cells(out());
      expect(c).toContain('$751,923');
      expect(c).toContain('$807,011');
      expect(out()).toContain('<strong>With and without</strong>');
      expect(out()).not.toContain('with_and_without');
    });
  });
});

describe('ASC 360 long-lived impairment', () => {
  const out = () => html('goodwill', SAMPLE_IMPAIRMENT_LONG_LIVED_RESULT);

  /**
   * The two-step test: undiscounted flows against carrying, and only then a
   * measurement. Both figures are on the exhibit, so a reader can see which
   * step produced the loss.
   */
  it('prints the recoverability screen and the flows it was run on', () => {
    const c = cells(out());
    expect(c).toContain('Undiscounted cash flows (total)');
    expect(c).toContain('$16,300,000');
    expect(c).toContain('Not recoverable');
    expect(c).toContain('$14,400,000'); // fair value, and the carrying amount after
    expect(c).toContain('$3,800,000');
  });

  it('names the asset group and the standard it was tested under', () => {
    expect(out()).toContain('Fabrication line — Chandler');
    expect(
      buildSpecialtyExhibits(calc('goodwill', SAMPLE_IMPAIRMENT_LONG_LIVED_RESULT), ctx)[0]!.heading,
    ).toBe('Exhibit — Impairment Test (ASC 360-10)');
  });
});
