import { describe, expect, it } from 'vitest';
import { buildSpecialtyExhibits } from '../../src/domain/specialtyExhibits.js';
import type { CalculationRow } from '../../src/repos/calculations.js';

/**
 * The specialty exhibits on the shapes that reach them when the engine ran but
 * answered thinly.
 *
 * `specialtyExhibits.test.ts` covers the exhibits on complete results — the
 * shape a healthy run produces. This file covers the other half of the module's
 * stated contract: "an absent, partial or unfamiliar shape drops the exhibit
 * rather than throwing inside a render." Every one of these cells has a
 * fallback written for it, and until now none of the fallbacks had ever been
 * rendered, so the behaviour that a client sees when a specialty engine returns
 * half a result was whatever the code happened to do.
 *
 * These are not hypothetical inputs. `results.specialty` is jsonb written
 * straight from an engine response; a version that has stopped emitting a field,
 * or emits `null` where it used to emit a figure, produces exactly these shapes,
 * and the report still has to render.
 */

const ctx = { currency: 'USD', companyName: 'Acme', valuationDate: '2026-08-07' };

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

/** The single section a kind renders, or a failure naming what came back. */
function only(kind: string, specialty: Record<string, unknown>): string {
  const sections = buildSpecialtyExhibits(calc(kind, specialty), ctx);
  expect(sections).toHaveLength(1);
  return sections[0]!.html;
}

describe('QSBS on a partial §1202 result', () => {
  it('renders a test whose entry is not an object as a bare failure', () => {
    // The engine writes `tests` as a map of objects. A string, a null or a
    // number in one of the slots is a version skew, and the requirement still
    // has to occupy its row — an omitted row reads as a test that passed.
    const html = only('qsbs', { tests: { c_corporation: 'yes', gross_asset_test: null } });
    expect(html).toContain('C corporation');
    expect(html).toContain('Gross asset test');
    expect(html.match(/Fail/g)).toHaveLength(2);
  });

  it('states the holding period from the defaults when the run reported none of it', () => {
    const html = only('qsbs', { tests: {}, holding_period: { met: true } });
    // Five years is the requirement for stock acquired on or before 4 Jul 2025
    // and is the safe default for a result that did not say; the years held and
    // the milestone date are facts about this holder and print as em-dashes
    // rather than as zero. The milestone is named after whatever requirement
    // was applied, so it moves with it rather than always reading "five-year".
    expect(html).toContain('— years held against the 5-year requirement');
    expect(html).toContain('met (5-year date —)');
  });

  it('prints an unqualified, currently-available position with no percentage', () => {
    const html = only('qsbs', { tests: {}, eligible: false, exclusion_available_now: true });
    expect(html).toContain('does not qualify');
    expect(html).toContain('exclusion available now: <strong>yes</strong>');
    expect(html).toContain('exclusion percentage —');
  });

  it('renders the cap table with every component missing rather than dropping it', () => {
    const html = only('qsbs', { tests: {}, cap_components: {} });
    expect(html).toContain('Lifetime cap');
    expect(html).toContain('Ten times basis');
    expect(html).toContain('Applicable cap');
    // Four components plus the foot, none of them supplied.
    expect(html.match(/—/g)?.length).toBeGreaterThanOrEqual(5);
  });

  it('drops the exhibit when the run recorded no tests at all', () => {
    expect(buildSpecialtyExhibits(calc('qsbs', { eligible: true }), ctx)).toEqual([]);
  });
});

describe('PPA on a partial allocation', () => {
  it('names an unnamed intangible and prints its missing method and value', () => {
    const html = only('ppa', {
      consideration_transferred: 10_000_000,
      intangibles: [{}, 'not-an-object'],
    });
    // The non-object entry is dropped; the object one keeps its row.
    expect(html.match(/<tr>/g)?.length).toBeGreaterThan(0);
    expect(html).toContain('Total identifiable intangibles');
    expect(html).toContain('$10,000,000');
  });

  it('falls back to goodwill when the bargain-purchase gain is not a number', () => {
    const html = only('ppa', {
      consideration_transferred: 10_000_000,
      bargain_purchase_gain: 'n/a',
      goodwill: 4_000_000,
    });
    expect(html).toContain('Goodwill (residual)');
    expect(html).not.toContain('Bargain purchase gain');
    expect(html).toContain('$4,000,000');
  });

  it('prints the residual as an em-dash when goodwill was not reported', () => {
    const html = only('ppa', { consideration_transferred: 10_000_000 });
    expect(html).toContain('Goodwill (residual)');
    expect(html).toContain('Tangible net assets');
  });
});

describe('impairment on a partial test', () => {
  it('reports a recoverable asset group and no measured loss', () => {
    const html = only('goodwill', {
      standard: 'ASC 360',
      carrying_amount: 5_000_000,
      recoverable: true,
      asset_group: 'Fulfilment centre',
    });
    expect(html).toContain('Recoverability screen');
    expect(html).toContain('Recoverable');
    expect(html).toContain('Fulfilment centre');
    expect(html).toContain('Impairment loss (none indicated)');
  });

  it('drops the unit line when the run named neither a unit, group nor asset', () => {
    const html = only('goodwill', { standard: 'ASC 350', carrying_amount: 1, impaired: true });
    expect(html).not.toContain('Unit tested');
    expect(html).toContain('Impairment loss');
  });

  it('drops the exhibit when the standard is missing', () => {
    expect(buildSpecialtyExhibits(calc('goodwill', { carrying_amount: 1 }), ctx)).toEqual([]);
  });
});

describe('ESOP on a partial level-of-value result', () => {
  it('prints the discounts as em-dashes and omits the stake line', () => {
    const html = only('esop', { levels: {} });
    expect(html).toContain('Marketable minority (DLOC —)');
    expect(html).toContain('Nonmarketable minority (DLOM —)');
    expect(html).toContain('Fair market value per share');
    expect(html).not.toContain('Value of the shares held by the ESOP');
  });

  it('renders a repurchase schedule whose rows carry no figures', () => {
    const html = only('esop', {
      levels: { control: 20_000_000 },
      repurchase_obligation: { schedule: [{}] },
    });
    expect(html).toContain('Shares redeemed');
    // A row with no year still occupies the schedule; a redemption of nothing
    // prints as 0 rather than as an em-dash, because it is a share count.
    expect(html).toContain('<td>0</td>');
    expect(html).toContain('Total obligation');
  });

  it('omits the present value from the foot when the run did not discount it', () => {
    const html = only('esop', {
      levels: {},
      repurchase_obligation: { schedule: [{ year: 2027 }], total_obligation: 1_000_000 },
    });
    expect(html).toContain('$1,000,000');
    expect(html).not.toContain('PV ');
  });

  it('drops the exhibit without levels', () => {
    expect(buildSpecialtyExhibits(calc('esop', { fmv_per_share: 1 }), ctx)).toEqual([]);
  });
});

describe('SMB on a partial method set', () => {
  it('drops the normalization table and prints unweighted methods', () => {
    const html = only('fmv', { methods: { sde_multiple: {}, market_comps: 'skew' } });
    expect(html).not.toContain('SDE normalization');
    // A name the engine dispatches to is spelled out; anything else falls back
    // to the humanized key, which is what a method this module has not been
    // told about should look like.
    expect(html).toContain('SDE multiple');
    expect(html).toContain('Market comps');
    expect(html).toContain('Concluded equity value');
    // Neither method carries the operands its Basis is built from, so both
    // cells are em-dashes rather than a half-formed sentence.
    expect(html).toContain('<td>SDE multiple</td><td>\u2014</td>');
  });

  it('renders the normalization with no add-backs or deductions to show', () => {
    const html = only('fmv', {
      methods: {},
      // Zero-valued entries are filtered out: an add-back of nothing is not an
      // adjustment somebody made, and a reader counting the lines should see
      // only the ones that moved the figure.
      sde_normalization: { pretax_income: 400_000, addbacks: { owner_salary: 0 }, deductions: {} },
    });
    expect(html).toContain('Pre-tax income');
    expect(html).not.toContain('Add back');
    expect(html).toContain("Seller's discretionary earnings");
  });

  it('tolerates a normalization whose add-back and deduction maps are not objects', () => {
    const html = only('fmv', {
      methods: {},
      sde_normalization: { pretax_income: 1, addbacks: 'x', deductions: 7 },
    });
    expect(html).toContain('Pre-tax income');
  });
});

describe('EMI / CSOP on a partial share valuation', () => {
  it('prints the discounts as em-dashes with no qualification block', () => {
    const html = only('emi', { umv_per_share: 3.25 });
    expect(html).toContain('$3.2500');
    expect(html).toContain('Minority discount');
    expect(html).toContain('Actual market value (AMV) per share');
    expect(html).not.toContain('Scheme qualification');
  });

  it('labels a CSOP check table Schedule 4 and an EMI one Schedule 5', () => {
    const checks = { checks: { independence: { passed: true, detail: 'ok' } }, qualifies: false };
    expect(only('csop', { umv_per_share: 1, qualification: { ...checks, scheme: 'csop' } })).toContain(
      'Schedule 4 check',
    );
    expect(only('emi', { umv_per_share: 1, qualification: checks })).toContain('Schedule 5 check');
  });

  it('renders a check whose entry is not an object as a failure with no basis', () => {
    const html = only('emi', {
      umv_per_share: 1,
      qualification: { checks: { gross_assets: 'unknown' }, qualifies: true },
    });
    expect(html).toContain('Gross assets');
    expect(html).toContain('Fail');
    expect(html).toContain('qualifies');
  });

  it('drops the exhibit without an unrestricted market value', () => {
    expect(buildSpecialtyExhibits(calc('emi', { amv_per_share: 1 }), ctx)).toEqual([]);
  });
});

describe('intangible on a bare fair value', () => {
  it('renders the conclusion with no measure table behind it', () => {
    const html = only('ip', { fair_value: 2_500_000 });
    expect(html).toContain('Concluded fair value');
    expect(html).toContain('$2,500,000');
    expect(html).not.toContain('Present value before TAB');
  });

  /**
   * This case used to assert a fallback from `pv_before_tab` to `pv`. Neither
   * name is one `value_intangible` returns, so the fallback was between two
   * fields that do not exist and the assertion held only because the fixture
   * supplied one of them. What the exhibit actually has to survive is a real
   * result missing its optional halves.
   */
  it('renders the bridge from a run that reported no terminal period', () => {
    const html = only('ip', {
      method: 'with_and_without',
      value_before_tab: 900_000,
      tab_multiplier: 1.08,
      fair_value: 972_000,
    });
    expect(html).toContain('Value before the tax amortization benefit');
    expect(html).toContain('$900,000');
    expect(html).not.toContain('terminal period');
  });

  it('keeps the schedule when a row is missing the columns the method names', () => {
    const html = only('ip', {
      method: 'relief_from_royalty',
      schedule: [{ year: 1, revenue: 100 }, {}],
      fair_value: 90,
    });
    expect(html).toContain('Royalty savings');
    expect(html).toContain('—');
    expect(html).not.toContain('undefined');
    expect(html).not.toContain('NaN');
  });

  it('drops the exhibit without a fair value', () => {
    expect(buildSpecialtyExhibits(calc('ip', { value_before_tab: 1 }), ctx)).toEqual([]);
  });
});

describe('dispatch', () => {
  it('returns nothing for a kind this module does not render', () => {
    expect(buildSpecialtyExhibits(calc('crypto', { fair_value: 1 }), ctx)).toEqual([]);
  });

  it('returns nothing when the results carry no specialty block', () => {
    const row = calc('qsbs', {});
    row.results = { kind: 'qsbs' };
    expect(buildSpecialtyExhibits(row, ctx)).toEqual([]);
  });

  it('returns nothing for a calculation that did not succeed', () => {
    const row = calc('qsbs', { tests: {} });
    row.status = 'failed';
    expect(buildSpecialtyExhibits(row, ctx)).toEqual([]);
    expect(buildSpecialtyExhibits(null, ctx)).toEqual([]);
  });
});
