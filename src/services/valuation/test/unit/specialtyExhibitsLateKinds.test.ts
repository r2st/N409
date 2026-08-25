import { describe, expect, it } from 'vitest';
import { buildSpecialtyExhibits } from '../../src/domain/specialtyExhibits.js';
import {
  SAMPLE_820_RESULT,
  SAMPLE_GIFTS_RESULT,
  SAMPLE_IFRS2_RESULT,
} from '../../src/domain/specialtySamples.js';
import type { CalculationRow } from '../../src/repos/calculations.js';

/**
 * `820`, `gifts` and `ifrs2` gained engine endpoints after `buildSpecialtyExhibits`
 * was written, and were never added to its switch. Each ran, recorded a result,
 * and rendered a deliverable with no schedules under it — beneath an "Index of
 * Exhibits" section whose text promises that "the exhibits that follow are
 * generated from the valuation model supporting this report".
 *
 * The payloads are the real engines' output (see domain/specialtySamples.ts),
 * not hand-written objects. That matters: writing these exhibits against the
 * shapes the Python was *assumed* to return got three fields wrong — the NAV
 * reconciling line reads `fair_value`/`note` rather than `amount`/`basis`,
 * `percent_interest` comes back as a percentage rather than a fraction, and in
 * the IFRS 2 expense schedule `period` is the amount while `year` is the label.
 * Each would have rendered plausibly and wrongly.
 */

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

const only = (kind: string, specialty: Record<string, unknown>) => {
  const sections = buildSpecialtyExhibits(calc(kind, specialty), ctx);
  expect(sections).toHaveLength(1);
  return sections[0]!;
};

describe('ASC 820 fair value measurement', () => {
  const exhibit = () => only('820', SAMPLE_820_RESULT);

  it('is rendered at all', () => {
    expect(exhibit().heading).toContain('820-10-50');
  });

  it('prints the hierarchy with each level as a share of the total', () => {
    const html = exhibit().html;
    expect(html).toContain('$4,200,000'); // level 1
    expect(html).toContain('$2,650,000'); // level 2
    expect(html).toContain('$7,550,000'); // level 3
    expect(html).toContain('$17,500,000'); // total
    expect(html).toContain('43.1%'); // level 3 as a share
  });

  it('reconciles the NAV practical expedient to the statement total', () => {
    const html = exhibit().html;
    expect(html).toContain('$3,100,000');
    expect(html).toContain('$14,400,000'); // categorised
    expect(html).toContain('820-10-35-59');
  });

  it('names the position the hierarchy re-levelled, and why', () => {
    const html = exhibit().html;
    expect(html).toContain('Series B preferred');
    expect(html).toContain('820-10-35-37');
    expect(html).toContain('does not govern');
  });

  it('discloses the significant unobservable inputs as a range and a weighted average', () => {
    const html = exhibit().html;
    expect(html).toContain('Discount for lack of marketability');
    expect(html).toContain('0.275');
    expect(html).toContain('0.32');
  });

  it('foots the Level 3 rollforward and says whether it ties', () => {
    const html = exhibit().html;
    expect(html).toContain('Beginning balance');
    expect(html).toContain('$6,900,000');
    expect(html).toContain('tie to the measured Level 3 balance');
  });

  it('says loudly when the rollforward does not tie', () => {
    const broken = {
      ...SAMPLE_820_RESULT,
      level_3_rollforward: {
        ...(SAMPLE_820_RESULT.level_3_rollforward as Record<string, unknown>),
        ties: false,
        computed_ending_balance: 7_100_000,
        measured_ending_balance: 7_550_000,
        difference: 450_000,
      },
    };
    const html = only('820', broken).html;
    expect(html).toContain('does not tie');
    expect(html).toContain('$450,000');
  });

  it('omits the NAV line entirely when no position uses the expedient', () => {
    const noNav = {
      ...SAMPLE_820_RESULT,
      nav_practical_expedient: { fair_value: 0, position_count: 0, note: 'n/a' },
    };
    // A zero line reads as a fourth level in the hierarchy.
    expect(only('820', noNav).html).not.toContain('practical expedient');
  });

  /**
   * ASC 820-10-50-2(g) asks for a narrative description of the sensitivity of
   * a recurring Level 3 measurement to changes in the significant unobservable
   * inputs. `fair_value_measurement` computes it — `app/engine/fair_value_820.py`
   * names it as one of the three things the engine exists to produce — and the
   * exhibit tabulated the inputs while dropping the effect of moving them.
   *
   * R134 declared the schedule an analyst run input, so it is suppliable from
   * the workspace tab; until now supplying it changed nothing a reader saw.
   */
  it('renders the Level 3 sensitivity the disclosure paragraph asks for', () => {
    const html = exhibit().html;
    expect(html).toContain('820-10-50-2(g)');
    expect(html).toContain('Discount for lack of marketability');
    // Signed: the direction of the move is the disclosure. An unsigned "5.0%"
    // beside a negative effect is a reader guessing which way the input went.
    expect(html).toContain('-5.0%');
    expect(html).toContain('+10.0%');
    expect(html).toContain('$755,000');
    expect(html).toContain('$8,305,000');
  });

  /** No schedule supplied prints no table — not an empty one under a heading. */
  it('omits the sensitivity table when no schedule was supplied', () => {
    const none = { ...SAMPLE_820_RESULT, sensitivity: [] };
    expect(only('820', none).html).not.toContain('820-10-50-2(g)');
  });
});

describe('gift & estate', () => {
  const exhibit = () => only('gifts', SAMPLE_GIFTS_RESULT);

  /**
   * `transfer_type` and `transfer_date` are both required questions and the
   * engine returns both. The exhibit read neither, so a Form 709 gift and an
   * estate inclusion under §2031 rendered as the same document — headed
   * "Transferred Interest and Discounts", with no statement of what was
   * transferred or when.
   *
   * The date matters most on the estate side, where it is the date of death
   * the whole appraisal is struck at, and the type is what decides the
   * annual-exclusion row below it.
   */
  it('names the transfer and the date the interest is valued at', () => {
    const html = exhibit().html;
    expect(html).toContain('Gift (§2503)');
    expect(html).toContain('2026-03-31');
    expect(html).toContain('the date the interest is valued at');
  });

  it('names an estate inclusion as one, and says why no exclusion is available', () => {
    const estate = {
      ...SAMPLE_GIFTS_RESULT,
      transfer_type: 'estate',
      annual_exclusion: {
        ...(SAMPLE_GIFTS_RESULT.annual_exclusion as Record<string, unknown>),
        applies: false,
      },
    };
    const html = only('gifts', estate).html;
    expect(html).toContain('Estate inclusion (§2031)');
    // The reason, not just the refusal — otherwise a preparer cannot tell an
    // unavailable exclusion from an overlooked one.
    expect(html).toContain('not available for an estate inclusion (§2031)');
  });

  it('names a generation-skipping transfer rather than rendering it as "Gst"', () => {
    const gst = {
      ...SAMPLE_GIFTS_RESULT,
      transfer_type: 'gst',
      annual_exclusion: {
        ...(SAMPLE_GIFTS_RESULT.annual_exclusion as Record<string, unknown>),
        applies: false,
      },
    };
    const html = only('gifts', gst).html;
    expect(html).toContain('Generation-skipping transfer (§2601)');
    expect(html).toContain('not available for a generation-skipping transfer');
    expect(html).not.toContain('Gst');
  });

  /** A result stored before the engine reported the type still renders. */
  it('drops the transfer line rather than guessing when no type came back', () => {
    const untyped = { ...SAMPLE_GIFTS_RESULT };
    delete untyped.transfer_type;
    const html = only('gifts', untyped).html;
    expect(html).not.toContain('Transfer:');
    expect(html).toContain('$2,280,960');
  });

  it('prints the bridge from entity value to the transferred interest', () => {
    const html = exhibit().html;
    expect(html).toContain('$24,000,000'); // entity
    expect(html).toContain('$3,600,000'); // pro rata 15%
    expect(html).toContain('$3,168,000'); // after DLOC
    expect(html).toContain('$2,280,960'); // concluded
  });

  it('states the interest as the percentage the engine returns, not as a fraction of one', () => {
    // `percent_interest` is 15, not 0.15 — running it through a percent
    // formatter would print a 15% interest as 1,500%.
    const html = exhibit().html;
    expect(html).toContain('15%');
    expect(html).not.toContain('1,500');
  });

  it('foots with the effective discount, which is not the sum of the two rates', () => {
    // 1 − (1 − 0.12)(1 − 0.28) = 36.64%, where adding gives 40%.
    const html = exhibit().html;
    expect(html).toContain('36.6%');
    expect(html).not.toContain('40.0%');
  });

  it('carries the reportable gift through the annual exclusion and prior gifts', () => {
    const html = exhibit().html;
    expect(html).toContain('$38,000'); // exclusion applied, 2 donees
    expect(html).toContain('$1,250,000'); // prior taxable gifts
    expect(html).toContain('$3,492,960'); // cumulative
  });

  it('says an undetermined annual exclusion is undetermined, not nil', () => {
    // Nothing sent `annual_exclusion` until the questionnaire grew a field for
    // it, so every gift exhibit printed "less annual exclusion — $0.00" over a
    // cumulative total struck at the whole appraised value. That is a
    // determination on a Form 709 the file had never made.
    const undetermined = {
      ...SAMPLE_GIFTS_RESULT,
      annual_exclusion: {
        determined: false,
        per_donee: 0,
        donees: 1,
        split_gift: false,
        available: 0,
        applied: 0,
        applies: true,
      },
      taxable_gift: 2280960.0,
      cumulative_taxable_gifts: 3530960.0,
    };
    const html = only('gifts', undetermined).html;
    expect(html).toContain('not determined');
    expect(html).toContain('Not determined');
    expect(html).toContain('before any annual exclusion');
    expect(html).not.toContain('−$0.00');
  });

  it('reads a result stored before the flag existed by its per-donee figure', () => {
    // Every result stored before this ran through a questionnaire with no
    // exclusion field, so an absent flag over a nil per-donee figure is the
    // unanswered case; an absent flag over a real one came from an override.
    const legacyNil = {
      ...SAMPLE_GIFTS_RESULT,
      annual_exclusion: {
        per_donee: 0,
        donees: 1,
        split_gift: false,
        available: 0,
        applied: 0,
        applies: true,
      },
    };
    expect(only('gifts', legacyNil).html).toContain('not determined');
    // The sample carries a real $19,000 figure and no flag — still a
    // determination.
    const { determined: _flag, ...legacyReal } = SAMPLE_GIFTS_RESULT.annual_exclusion as Record<
      string,
      unknown
    >;
    const html = only('gifts', { ...SAMPLE_GIFTS_RESULT, annual_exclusion: legacyReal }).html;
    expect(html).toContain('$38,000');
    expect(html).not.toContain('not determined');
  });

  it('keeps saying the exclusion is unavailable on an estate inclusion', () => {
    // Not the same statement as "undetermined": §2031 has no annual exclusion
    // to determine.
    const estate = {
      ...SAMPLE_GIFTS_RESULT,
      transfer_type: 'estate',
      annual_exclusion: {
        determined: false,
        per_donee: 0,
        donees: 1,
        split_gift: false,
        available: 0,
        applied: 0,
        applies: false,
      },
    };
    const html = only('gifts', estate).html;
    // The row names the transfer it is unavailable for; "this transfer" was
    // the wording before the exhibit read `transfer_type` at all.
    expect(html).toContain('not available for an estate inclusion (§2031)');
    expect(html).not.toContain('not determined');
  });

  it('prints the Revenue Ruling 59-60 checklist with what is still unaddressed', () => {
    const html = exhibit().html;
    expect(html).toContain('The earning capacity of the company');
    expect(html).toContain('7 of 8');
    expect(html).toContain('No'); // the unaddressed factor
  });

  it('does not print an unstated §4.01 checklist as eight refusals', () => {
    // Nothing sent `factors_addressed` until the questionnaire grew the
    // section, so every gift appraisal footed "0 of 8" with a No against each
    // factor — a Rev. Rul. 59-60 report saying it addressed none of the eight
    // factors it is graded on.
    const unstated = {
      ...SAMPLE_GIFTS_RESULT,
      rev_rul_59_60: {
        stated: false,
        factors: (SAMPLE_GIFTS_RESULT.rev_rul_59_60 as { factors: unknown[] }).factors.map((f) => ({
          ...(f as Record<string, unknown>),
          addressed: false,
        })),
        addressed_count: 0,
        total_count: 8,
        unaddressed: [],
      },
    };
    const html = only('gifts', unstated).html;
    expect(html).toContain('Not recorded');
    expect(html).not.toContain('0 of 8');
    // The factor labels still print — the checklist is the exhibit, and what
    // changed is what it claims about the file.
    expect(html).toContain('The earning capacity of the company');
  });

  it('reads a stored checklist from before the flag by its addressed count', () => {
    const { stated: _flag, ...legacy } = SAMPLE_GIFTS_RESULT.rev_rul_59_60 as Record<string, unknown>;
    const html = only('gifts', { ...SAMPLE_GIFTS_RESULT, rev_rul_59_60: legacy }).html;
    expect(html).toContain('7 of 8');
    expect(html).not.toContain('Not recorded');
  });
});

describe('IFRS 2 share-based payment', () => {
  const exhibit = () => only('ifrs2', SAMPLE_IFRS2_RESULT);

  it('prints the grant-date measurement and what it expects to vest', () => {
    const html = exhibit().html;
    expect(html).toContain('Black scholes');
    expect(html).toContain('$0.7437'); // fair value per award
    expect(html).toContain('750000'); // awards granted
    expect(html).toContain('690000'); // expected to vest after 8% forfeiture
  });

  it('labels each schedule row by its year and not by its own amount', () => {
    const html = exhibit().html;
    expect(html).toContain('Year 1');
    expect(html).toContain('Year 4');
    expect(html).toContain('$267,249'); // year 1 expense
  });

  it('shows the attribution the awards actually used', () => {
    // Graded, because IFRS 2.IG11 has no straight-line election for
    // instalment vesting.
    expect(exhibit().html).toContain('Graded');
  });

  it('states whether the expense will be trued up, and under which paragraph', () => {
    const html = exhibit().html;
    expect(html).toContain('IFRS 2.19');
    expect(html).toContain('trued up');
  });

  it('renders the graded-attribution warning when the engine raises one', () => {
    const warned = { ...SAMPLE_IFRS2_RESULT, warnings: ['IFRS 2.IG11 requires graded attribution'] };
    expect(only('ifrs2', warned).html).toContain('IG11');
  });

  // IFRS 2.19-20 measures the expense on the awards expected to vest, so a
  // forfeiture rate of nil is the assertion that none will be forfeited. The
  // engine defaulted the parameter to nil, the questionnaire asked for it
  // nowhere and the assembler sent it never — so every exhibit printed that
  // assertion, at "0.0%", above an expense struck on the whole grant.
  const undetermined = () => {
    const { expected_forfeiture_rate: _r, ...rest } = SAMPLE_IFRS2_RESULT as Record<string, unknown>;
    return {
      ...rest,
      expected_forfeiture_rate: 0,
      forfeiture_determined: false,
      expected_to_vest: 750000,
      total_expense: 557737.9105320297,
      warnings: ['no expected forfeiture rate was estimated'],
    };
  };

  it('does not print an unmade forfeiture estimate as nil', () => {
    const html = only('ifrs2', undetermined()).html;
    expect(html).toContain('<td>Not estimated</td>');
    expect(html).toContain('Expected forfeiture rate — not estimated');
    expect(html).not.toContain('<td>0.0%</td>');
  });

  it('says the expense was struck on every award when no estimate was made', () => {
    expect(only('ifrs2', undetermined()).html).toContain('every award granted, no estimate made');
  });

  it('prints an estimate of nil as the determination it is', () => {
    const html = only('ifrs2', {
      ...SAMPLE_IFRS2_RESULT,
      expected_forfeiture_rate: 0,
      forfeiture_determined: true,
      expected_to_vest: 750000,
    }).html;
    expect(html).toContain('<td>0.0%</td>');
    expect(html).not.toContain('not estimated');
  });

  it('reads a stored result from before the flag by its rate', () => {
    const { forfeiture_determined: _f, ...legacy } = SAMPLE_IFRS2_RESULT as Record<string, unknown>;
    const html = only('ifrs2', legacy).html;
    expect(html).toContain('<td>8.0%</td>');
    expect(html).not.toContain('not estimated');
  });

  // A cash-settled award is a liability carried at fair value, remeasured each
  // reporting date with the change through profit or loss (IFRS 2.30-33). The
  // engine computed all of it and the exhibit rendered none of it, so the
  // deliverable for a cash-settled plan showed a grant-date expense and no
  // sight of the liability it actually creates.
  const cashSettled = () => ({
    ...SAMPLE_IFRS2_RESULT,
    settlement: 'cash_settled',
    remeasurement: {
      required: true,
      current_fair_value_per_award: 0.9,
      current_total: 621000,
      change_in_liability: 107881.12,
      basis:
        'cash-settled awards are liabilities remeasured to fair value at each reporting date (IFRS 2.30-33)',
    },
  });

  it('renders the liability a cash-settled award is carried at', () => {
    const html = only('ifrs2', cashSettled()).html;
    expect(html).toContain('Remeasurement at the reporting date');
    expect(html).toContain('$0.9000');
    expect(html).toContain('$621,000');
  });

  it('states the change in the liability and where it is recognised', () => {
    const html = only('ifrs2', cashSettled()).html;
    expect(html).toContain('Change in the liability');
    expect(html).toContain('$107,881');
    expect(html).toContain('profit or loss');
  });

  it('says an equity-settled award is not remeasured, rather than saying nothing', () => {
    const html = exhibit().html;
    expect(html).toContain('not subsequently remeasured');
    expect(html).not.toContain('Remeasurement at the reporting date');
  });

  it('drops the remeasurement table when the engine reported no liability figure', () => {
    const { current_total: _t, ...partial } = cashSettled().remeasurement as Record<string, unknown>;
    const html = only('ifrs2', { ...cashSettled(), remeasurement: partial }).html;
    expect(html).not.toContain('Remeasurement at the reporting date');
    expect(html).toContain('IFRS 2.30-33'); // the basis still states the rule
  });

  it('asks for no forfeiture estimate where the condition is in the fair value', () => {
    // IFRS 2.21: a market condition is priced into the grant-date fair value,
    // and the engine refuses to also count it as a forfeiture.
    const html = only('ifrs2', {
      ...undetermined(),
      vesting_condition: 'market',
      warnings: [],
    }).html;
    expect(html).toContain('IFRS 2.21');
    expect(html).not.toContain('not estimated');
    expect(html).not.toContain('no estimate made');
  });
});

describe('degradation', () => {
  it.each([
    ['820', {}],
    ['gifts', {}],
    ['ifrs2', {}],
    ['820', { total_fair_value: 1 }], // no by_level
    ['gifts', { concluded_value: 1 }], // no pro_rata_value
    ['ifrs2', { total_expense: 1 }], // no fair_value_per_award
  ])('drops the %s exhibit rather than throwing on a shape it does not recognise', (kind, payload) => {
    expect(buildSpecialtyExhibits(calc(kind, payload), ctx)).toEqual([]);
  });

  /**
   * `results.specialty` is jsonb written straight from an engine response. An
   * engine version that stops emitting a field, or emits null where it emitted
   * a figure, produces exactly these shapes — and the report still has to
   * render. Every leaf, one at a time, rather than the handful somebody thought
   * of: the module's contract is that no shape throws inside a render, and a
   * contract stated over "every field" has to be tested over every field.
   */
  function leafPaths(value: unknown, prefix: string[] = []): string[][] {
    if (value === null || typeof value !== 'object') return [prefix];
    if (Array.isArray(value)) return value.flatMap((v, i) => leafPaths(v, [...prefix, String(i)]));
    return Object.entries(value).flatMap(([k, v]) => leafPaths(v, [...prefix, k]));
  }

  function replaceAt(value: unknown, path: string[], replacement: unknown): unknown {
    if (path.length === 0) return replacement;
    const [head, ...rest] = path;
    if (Array.isArray(value)) {
      return value.map((v, i) => (String(i) === head ? replaceAt(v, rest, replacement) : v));
    }
    const obj = value as Record<string, unknown>;
    return { ...obj, [head!]: replaceAt(obj[head!], rest, replacement) };
  }

  describe.each([
    ['820', SAMPLE_820_RESULT],
    ['gifts', SAMPLE_GIFTS_RESULT],
    ['ifrs2', SAMPLE_IFRS2_RESULT],
  ])('%s', (kind, sample) => {
    const paths = leafPaths(sample);

    it('has leaves to corrupt', () => {
      expect(paths.length).toBeGreaterThan(20);
    });

    it.each([null, undefined, 'unexpected string', NaN, {}, []])(
      'renders or drops — never throws — with any single leaf replaced by %s',
      (replacement) => {
        for (const path of paths) {
          const corrupted = replaceAt(sample, path, replacement) as Record<string, unknown>;
          expect(
            () => buildSpecialtyExhibits(calc(kind, corrupted), ctx),
            `${kind}.${path.join('.')} = ${String(replacement)}`,
          ).not.toThrow();
        }
      },
    );

    it('never prints a literal NaN, undefined or [object Object]', () => {
      for (const path of paths) {
        for (const replacement of [NaN, undefined, {}]) {
          const corrupted = replaceAt(sample, path, replacement) as Record<string, unknown>;
          const html = buildSpecialtyExhibits(calc(kind, corrupted), ctx)
            .map((s) => s.html)
            .join('');
          const where = `${kind}.${path.join('.')} = ${String(replacement)}`;
          expect(html, where).not.toContain('NaN');
          expect(html, where).not.toContain('undefined');
          expect(html, where).not.toContain('[object Object]');
        }
      }
    });
  });
});
