import type { ReportPdfSection } from '@n409/report/pdf';
import type { CalculationRow } from '../repos/calculations.js';
import { formatCurrency, formatExactPercent, formatPercent, num } from './reportSummary.js';
import type { ExhibitContext } from './reportExhibits.js';
import type { HmrcForm } from './hmrcForms.js';
import { esc, P, section, table } from './exhibitHtml.js';
import { numberFormat } from './numberFormat.js';

/**
 * Render-time schedules for the specialty report types — the same contract
 * domain/reportExhibits.ts holds for the 409A deliverable, applied to the
 * result shapes the specialty engines produce (results.specialty, written by
 * routes/specialty.ts). The authored skeleton says what the engagement did;
 * these say what the engine computed, and cannot be edited apart from it.
 *
 * Same degradation rule as the 409A exhibits: an absent, partial or
 * unfamiliar shape drops the exhibit rather than throwing inside a render.
 */

const INT = new Intl.NumberFormat('en-US');

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

const passFail = (passed: unknown): string => (passed === true ? 'Pass' : 'Fail');

/** Humanize a snake_case key for a table cell. */
function label(key: string): string {
  const words = key.replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function money(value: unknown, ctx: ExhibitContext, digits = 0): string | null {
  const n = num(value);
  return n === null ? null : formatCurrency(n, ctx.currency, digits);
}

/**
 * `money` for a figure already narrowed to a number — the one an exhibit's
 * entry guard checked before deciding to render at all.
 *
 * Kept distinct from `money` because the difference is not cosmetic: writing
 * `money(x, ctx) ?? '—'` for a field the function returns early without is an
 * em-dash that can never print, and four of those had accumulated. Taking a
 * `number` makes the guarded case say so in its type.
 */
function shown(value: number, ctx: ExhibitContext, digits = 0): string {
  return formatCurrency(value, ctx.currency, digits);
}

/**
 * A share or award count, grouped.
 *
 * `String(num(x))` was the idiom on the IFRS 2 exhibit and it put "400000" and
 * "376000" in a client deliverable beside amounts that were grouped, on the
 * same table. A non-integer is kept rather than rounded away: the engines
 * return counts as floats and an expected-to-vest of 375,999.5 is a figure
 * somebody has to see, not one to silently round into place.
 */
function count(value: unknown): string | null {
  const n = num(value);
  if (n === null) return null;
  return Number.isInteger(n) ? INT.format(n) : numberFormat('en-US', { maximumFractionDigits: 2 }).format(n);
}

function pct(value: unknown, digits = 1): string | null {
  const n = num(value);
  return n === null ? null : formatPercent(n, digits);
}

/**
 * A rate the reader is invited to multiply by, at the precision it was applied.
 *
 * The 409A deliverable settled this at `formatExactPercent`: a rate that only
 * has to be read is fine at a tenth of a point, and a rate the schedule beside
 * it derives an amount from is not — "Less: DLOM 31.4%" against a figure struck
 * at 0.3142 leaves a reviewer with a calculator unable to tell whether the
 * exhibit is rounded or wrong. The specialty schedules were never moved onto
 * it, and they are the ones built entirely out of that step:
 *
 *   - the ESOP level-of-value ladder, where each row's amount is the row above
 *     it less the rate in its own label, and a DOL reviewer tests exactly that;
 *   - the gift/estate bridge, whose Rate column sits beside the Amount it
 *     produced, down to an effective discount that is the two compounded;
 *   - the EMI/CSOP table, where the minority and restriction discounts are the
 *     whole of the step from UMV to the AMV in the foot;
 *   - the SMB basis column, which prints the division outright — "SDE $1,032,000
 *     ÷ 16.9%" — and the sentence deriving that rate as a discount rate less
 *     long-term growth, an arithmetic claim in prose that a rounded operand
 *     makes false.
 *
 * Weights keep {@link pct}: a weight is read, not multiplied through, and the
 * 409A exhibits state those at whole points for the same reason.
 */
function exactPct(value: unknown): string | null {
  const n = num(value);
  return n === null ? null : formatExactPercent(n);
}

/**
 * A cell's text, escaped, or the em-dash when the value is not printable text.
 *
 * `esc(String(value ?? '—'))` was the idiom, and it has two holes that only
 * show up on a result the engine did not produce cleanly: `??` does not catch
 * `NaN`, so a numeric field that arrives as NaN prints the word "NaN"; and
 * `String({})` is "[object Object]", so a field that arrives as an object where
 * a name was expected prints that. Both put a token in a valuation exhibit that
 * a reader cannot interpret and cannot tell from a real value.
 */
function str(value: unknown, fallback = '—'): string {
  if (typeof value === 'string') return value === '' ? fallback : esc(value);
  if (typeof value === 'number') return Number.isFinite(value) ? esc(String(value)) : fallback;
  return fallback;
}

/**
 * The four `transfer_type` answers, in the words a return preparer uses.
 * `label()` would render `sale_to_grantor_trust` as "Sale to grantor trust",
 * which is close, and `gst` as "Gst", which is not a thing.
 */
const TRANSFER_LABELS: Record<string, string> = {
  gift: 'Gift (§2503)',
  estate: 'Estate inclusion (§2031)',
  gst: 'Generation-skipping transfer (§2601)',
  sale_to_grantor_trust: 'Sale to a grantor trust',
};

// ── QSBS ─────────────────────────────────────────────────────────────────────

function qsbsExhibit(specialty: Record<string, unknown>, ctx: ExhibitContext): ReportPdfSection | null {
  const tests = record(specialty.tests);
  if (!tests) return null;
  const rows = Object.entries(tests).map(([key, value]) => {
    const t = record(value) ?? {};
    return [label(key), passFail(t.passed), esc(String(t.detail ?? ''))];
  });
  const holding = record(specialty.holding_period);
  const capParts = record(specialty.cap_components);
  // Under §1202 as amended by P.L. 119-21 the requirement is three years, not
  // five, so the schedule's own `required_years` names the milestone and the
  // paragraph is worded from it. It used to say "five-year date" regardless,
  // which on a tiered result contradicted the requirement in the same sentence.
  // Falling back to five keeps a result stored before the amendment readable.
  const requiredYears = num(holding?.required_years) ?? 5;
  const thresholdDate = str(holding?.threshold_date ?? holding?.five_year_date);
  // A whole number of years reads as a milestone; `years_held` is a raw
  // fraction ("3.2519") and needs a scale a sentence can carry.
  const heldYears = num(holding?.years_held);
  const tiers = list(holding?.tiers)
    .map(record)
    .filter((t): t is Record<string, unknown> => t !== null);
  const nowPct = pct(specialty.exclusion_percentage, 0);
  const maxPct = pct(specialty.maximum_exclusion_percentage, 0);
  return section('Exhibit — Section 1202 Test Results', [
    table({ head: ['Requirement', 'Result', 'Basis'], rows }),
    holding
      ? P(
          `Holding period: ${heldYears === null ? '—' : esc(heldYears.toFixed(1))} years held ` +
            `against the ${esc(String(requiredYears))}-year requirement — ` +
            `${holding.met === true ? 'met' : 'not yet met'} ` +
            `(${esc(String(requiredYears))}-year date ${thresholdDate}).`,
        )
      : null,
    // Only the tiered regime has a schedule worth a table; the pre-amendment
    // result is one step and the paragraph above already states it.
    tiers.length > 1
      ? table({
          head: ['Holding period', 'Date reached', 'Exclusion', 'Status'],
          rows: tiers.map((t) => [
            `${str(t.years)} years`,
            str(t.date),
            pct(t.exclusion_percentage, 0) ?? '—',
            t.met === true ? 'Reached' : 'Not yet',
          ]),
        })
      : null,
    P(
      `Stock qualification: <strong>${specialty.eligible === true ? 'qualifies' : 'does not qualify'}</strong>; ` +
        `exclusion available now: <strong>${specialty.exclusion_available_now === true ? 'yes' : 'no'}</strong>; ` +
        `exclusion percentage ${nowPct ?? '—'}` +
        // Two figures rather than one: the percentage as of the valuation date
        // and the ceiling the stock reaches when fully held. Printing only the
        // ceiling put "100%" beside "available now: no".
        (maxPct !== null && maxPct !== nowPct ? `, rising to ${maxPct} once fully held` : '') +
        '.',
    ),
    specialty.regime === 'obbba'
      ? P(
          'Evaluated under §1202 as amended by P.L. 119-21 (enacted 4 July 2025), which applies ' +
            'to stock acquired after that date: a $75,000,000 aggregate gross assets limit, a ' +
            '$15,000,000 per-issuer lifetime cap, and a tiered exclusion over the holding period. ' +
            'Both dollar figures are indexed for inflation in tax years beginning after 2026; the ' +
            'statutory base amounts are used here.',
        )
      : specialty.regime === 'pre_obbba'
        ? P(
            'Evaluated under §1202 as it stood before P.L. 119-21, which governs stock acquired ' +
              'on or before 4 July 2025: a $50,000,000 aggregate gross assets limit, a ' +
              '$10,000,000 per-issuer lifetime cap, and a single five-year holding period.',
          )
        : null,
    capParts
      ? table({
          head: ['Gain exclusion cap component', 'Amount'],
          rows: [
            ['Lifetime cap', money(capParts.lifetime_cap, ctx) ?? '—'],
            ['Previously excluded', money(capParts.prior_exclusions, ctx) ?? '—'],
            ['Lifetime remaining', money(capParts.lifetime_remaining, ctx) ?? '—'],
            ['Ten times basis', money(capParts.ten_times_basis, ctx) ?? '—'],
          ],
          foot: ['Applicable cap', money(specialty.gain_exclusion_cap, ctx) ?? '—'],
        })
      : null,
  ]);
}

// ── PPA / goodwill residual ──────────────────────────────────────────────────

function ppaExhibit(specialty: Record<string, unknown>, ctx: ExhibitContext): ReportPdfSection | null {
  const consideration = num(specialty.consideration_transferred);
  if (consideration === null) return null;
  const bargainGain = num(specialty.bargain_purchase_gain);
  const intangibles = list(specialty.intangibles)
    .map(record)
    .filter((r): r is Record<string, unknown> => r !== null);
  /**
   * `purchase_price_allocation` does not take fair values — it runs the IP
   * engine per asset and splices the whole method result in beside the name.
   * So every row carries `value_before_tab`, `tab_multiplier` and a full
   * year-by-year schedule, and the exhibit read three of those fields:
   * `name`, `method` and `fair_value`.
   *
   * The tax amortization benefit is the one that had to come back. It is a
   * step the fair value has already been grossed up by — a $2.3m asset
   * appearing as $2.5m — and an allocation table that states only the grossed
   * figure gives a reviewer no way to see that the step was taken, let alone
   * at what rate. It is nested one level inside `intangibles`, which the
   * result-key census reads as a single covered key.
   *
   * The schedules stay off: three assets at five years each is the whole IP
   * exhibit three times over, and the PPA reader is looking at an allocation,
   * not at how one asset was priced.
   */
  const tabColumns = intangibles.some((i) => num(i.tab_multiplier) !== null);
  /**
   * The rate each asset was discounted at.
   *
   * The one assumption from the spliced-in method payload that belongs on an
   * allocation rather than in the IP exhibit: the WACC/IRR/WARA reconciliation
   * a reviewer runs on a PPA compares the acquirer's cost of capital against
   * the rate charged to each identified asset, and the rates were nowhere on
   * the page. Present only where the engine echoed assumptions, which is any
   * result computed since R136.
   */
  const rateColumn = intangibles.some((i) => num(record(i.assumptions)?.discount_rate) !== null);
  const head = [
    'Intangible asset',
    'Method',
    ...(rateColumn ? ['Discount rate'] : []),
    ...(tabColumns ? ['Before TAB', 'TAB'] : []),
    'Fair value',
  ];
  return section('Exhibit — Purchase Price Allocation', [
    intangibles.length > 0
      ? table({
          head,
          rows: intangibles.map((i) => {
            const method = typeof i.method === 'string' ? i.method : null;
            const tab = num(i.tab_multiplier);
            return [
              str(i.name),
              // `esc(String(i.method))` printed the engine's own dispatch key —
              // "relief_from_royalty" and "meem" reached the page as written.
              method === null ? '—' : esc(IP_METHOD_LABELS[method] ?? label(method)),
              ...(rateColumn ? [pct(record(i.assumptions)?.discount_rate) ?? '—'] : []),
              ...(tabColumns
                ? [money(i.value_before_tab, ctx) ?? '—', tab === null ? '—' : esc(tab.toFixed(4))]
                : []),
              money(i.fair_value, ctx) ?? '—',
            ];
          }),
          // One blank per column between the caption and the total, whichever
          // of the optional columns are present.
          foot: [
            'Total identifiable intangibles',
            ...head.slice(2).map(() => ''),
            money(specialty.total_intangible_value, ctx) ?? '—',
          ],
        })
      : null,
    tabColumns
      ? P(
          'Each intangible is valued before the tax amortization benefit and then multiplied ' +
            'by the TAB factor shown, which is the present value of the amortization ' +
            'deductions a hypothetical buyer would claim on it.',
        )
      : null,
    table({
      head: ['Allocation', 'Amount'],
      rows: [
        ['Consideration transferred', shown(consideration, ctx)],
        ['Tangible net assets', money(specialty.tangible_net_assets, ctx) ?? '—'],
        ['Identifiable intangibles', money(specialty.total_intangible_value, ctx) ?? '—'],
        ['Identifiable net assets', money(specialty.identifiable_net_assets, ctx) ?? '—'],
      ],
      foot:
        bargainGain !== null && bargainGain > 0
          ? ['Bargain purchase gain', shown(bargainGain, ctx)]
          : ['Goodwill (residual)', money(specialty.goodwill, ctx) ?? '—'],
    }),
  ]);
}

// ── Impairment ───────────────────────────────────────────────────────────────

function impairmentExhibit(specialty: Record<string, unknown>, ctx: ExhibitContext): ReportPdfSection | null {
  const carrying = num(specialty.carrying_amount);
  if (typeof specialty.standard !== 'string' || carrying === null) return null;
  const rows: string[][] = [['Carrying amount', shown(carrying, ctx)]];
  const put = (name: string, value: string | null) => {
    if (value !== null) rows.push([name, value]);
  };
  put('Fair value', money(specialty.fair_value, ctx));
  put('Headroom', money(specialty.headroom, ctx));
  put('Undiscounted cash flows (total)', money(specialty.undiscounted_cash_flows_total, ctx));
  if (typeof specialty.recoverable === 'boolean') {
    rows.push(['Recoverability screen', specialty.recoverable ? 'Recoverable' : 'Not recoverable']);
  }
  put('Goodwill after impairment', money(specialty.goodwill_after, ctx));
  put('Carrying amount after impairment', money(specialty.carrying_after, ctx));
  const unit = specialty.reporting_unit ?? specialty.asset_group ?? specialty.asset;
  // ASC 350-20-35-3 lets an entity stop at the qualitative ("step zero")
  // assessment when it concludes it is not more likely than not that fair value
  // is below carrying amount. `goodwill_impairment` still runs the arithmetic
  // when the flag is set — deliberately, "so the memo can show the margin that
  // justified it" — and the exhibit rendered that arithmetic with nothing to
  // say it had not been the test performed. A reader could not tell a
  // quantitative conclusion from a headroom figure supporting a qualitative
  // one, and the election is itself a disclosure.
  const qualitativeOnly = specialty.qualitative_only === true;
  // The election and the arithmetic can disagree: an entity may record that it
  // stopped at step zero over figures whose fair value is below carrying
  // amount. That is not a case to caption away — it is the one a reviewer most
  // needs to see, because the qualitative conclusion it rests on is the
  // opposite of what the measures show.
  const contradicted = qualitativeOnly && specialty.impaired === true;
  return section(`Exhibit — Impairment Test (${esc(String(specialty.standard))})`, [
    unit ? P(`Unit tested: <strong>${esc(String(unit))}</strong>.`) : null,
    qualitativeOnly
      ? P(
          'The entity elected the qualitative assessment permitted by ASC 350-20-35-3 and did ' +
            'not perform the quantitative test. The measures below are shown to record the ' +
            'margin supporting that conclusion; they are not the impairment test.',
        )
      : null,
    contradicted
      ? P(
          '<strong>The measures below do not support the qualitative conclusion.</strong> Fair ' +
            'value is under the carrying amount, which is the circumstance ASC 350-20-35-3 ' +
            'requires the quantitative test for.',
        )
      : null,
    table({
      head: ['Measure', 'Amount'],
      rows,
      foot: [
        contradicted
          ? 'Impairment loss indicated by the measures above'
          : qualitativeOnly
            ? 'Impairment loss indicated by the qualitative assessment (none)'
            : specialty.impaired === true
              ? 'Impairment loss'
              : 'Impairment loss (none indicated)',
        money(specialty.impairment_loss, ctx) ?? '—',
      ],
    }),
  ]);
}

// ── ESOP ─────────────────────────────────────────────────────────────────────

function esopExhibit(specialty: Record<string, unknown>, ctx: ExhibitContext): ReportPdfSection | null {
  const levels = record(specialty.levels);
  if (!levels) return null;
  const repurchase = record(specialty.repurchase_obligation);
  const schedule = repurchase
    ? list(repurchase.schedule)
        .map(record)
        .filter((r): r is Record<string, unknown> => r !== null)
    : [];
  // Which end of the chain the appraiser started from. `esop_share_value`
  // accepts the input equity value at either level, and under "minority" the
  // control figure it reports is a gross-up computed for disclosure — its own
  // comment says "the conclusion never passes through it". Printed as a plain
  // three-row ladder the two cases are indistinguishable, and the minority one
  // reads as a control value that was determined and then discounted by the
  // DLOC. In an ESOP appraisal that is the specific representation a DOL
  // reviewer tests, so the direction has to be on the exhibit.
  const minorityBasis = specialty.value_basis === 'minority';
  const controlRow: [string, string] = minorityBasis
    ? [
        `Control (implied at DLOC ${exactPct(specialty.dloc) ?? '—'} — not a step in the conclusion)`,
        money(levels.control, ctx) ?? '—',
      ]
    : ['Control', money(levels.control, ctx) ?? '—'];
  const minorityRow: [string, string] = [
    minorityBasis
      ? 'Marketable minority (the appraised equity value)'
      : `Marketable minority (DLOC ${exactPct(specialty.dloc) ?? '—'})`,
    money(levels.marketable_minority, ctx) ?? '—',
  ];
  const shares = num(specialty.shares_outstanding);
  /**
   * Whether the projection was discounted. `repurchase_obligation` returns a
   * `pv` on every row and a `pv_of_obligation` total only when a discount rate
   * was supplied; without one the rows carry no present value and a column of
   * em-dashes would read as a failed calculation rather than a question nobody
   * asked.
   *
   * The per-year present values used to be dropped whether or not they existed.
   * The foot stated one PV for the whole obligation, so a reader could see the
   * total and not which years carry it — which in a repurchase study is the
   * question, because the obligation is a funding schedule and not a number.
   */
  const discounted = num(repurchase?.pv_of_obligation) !== null && schedule.some((r) => num(r.pv) !== null);
  return section('Exhibit — ESOP Level of Value', [
    P(
      minorityBasis
        ? 'The equity value supplied for this engagement is stated on a marketable minority ' +
            'basis. The conclusion applies the discount for lack of marketability to it; no ' +
            'discount for lack of control is taken. The control figure below is the value ' +
            'implied by grossing the minority value up at that rate, shown for reference only.'
        : 'The equity value supplied for this engagement is stated on a control basis. The ' +
            'conclusion steps down to a marketable minority value at the discount for lack of ' +
            'control, then to a nonmarketable minority value at the discount for lack of ' +
            'marketability.',
    ),
    table({
      head: ['Level of value', 'Amount'],
      // Ordered from the appraised input downward, so the row the engagement
      // started at is the first one under the paragraph that names it.
      rows: (minorityBasis
        ? [
            minorityRow,
            [
              `Nonmarketable minority (DLOM ${exactPct(specialty.dlom) ?? '—'})`,
              money(levels.nonmarketable_minority, ctx) ?? '—',
            ] as [string, string],
            controlRow,
          ]
        : [
            controlRow,
            minorityRow,
            [
              `Nonmarketable minority (DLOM ${exactPct(specialty.dlom) ?? '—'})`,
              money(levels.nonmarketable_minority, ctx) ?? '—',
            ] as [string, string],
          ]
      ).map((row) => [row[0], row[1]]),
      // The per-share conclusion is the nonmarketable minority value over the
      // share count; printing the divisor makes the division checkable rather
      // than asserted.
      foot: [
        shares === null
          ? 'Fair market value per share'
          : `Fair market value per share (${INT.format(Math.round(shares))} shares outstanding)`,
        money(specialty.fmv_per_share, ctx, 4) ?? '—',
      ],
    }),
    num(specialty.esop_stake_value) !== null
      ? P(`Value of the shares held by the ESOP: <strong>${money(specialty.esop_stake_value, ctx)}</strong>.`)
      : null,
    schedule.length > 0
      ? table({
          head: [
            'Year',
            'Share price',
            'Shares redeemed',
            'Repurchase cost',
            'Remaining shares',
            ...(discounted ? ['Present value'] : []),
          ],
          rows: schedule.map((r) => [
            String(num(r.year) ?? '—'),
            money(r.share_price, ctx, 2) ?? '—',
            INT.format(Math.round(num(r.shares_redeemed) ?? 0)),
            money(r.repurchase_cost, ctx) ?? '—',
            INT.format(Math.round(num(r.remaining_shares) ?? 0)),
            ...(discounted ? [money(r.pv, ctx) ?? '—'] : []),
          ]),
          foot: discounted
            ? [
                'Total obligation',
                '',
                '',
                money(repurchase!.total_obligation, ctx) ?? '—',
                '',
                money(repurchase!.pv_of_obligation, ctx) ?? '—',
              ]
            : ['Total obligation', '', '', money(repurchase!.total_obligation, ctx) ?? '—', ''],
        })
      : null,
  ]);
}

// ── SMB ──────────────────────────────────────────────────────────────────────

/**
 * `label()` renders `sde_multiple` as "Sde multiple". The three method names
 * are fixed by `smb_valuation`'s own dispatch, so they are spelled here.
 */
const SMB_METHOD_LABELS: Record<string, string> = {
  capitalization_of_earnings: 'Capitalization of earnings',
  sde_multiple: 'SDE multiple',
  revenue_multiple: 'Revenue multiple',
};

/**
 * How each method got from its benefit stream to its indicated value, in the
 * method's own figures.
 *
 * Every SMB method is one arithmetic step — a division by a capitalization
 * rate or a multiplication by a multiple — and each result object carries both
 * operands. The exhibit printed neither: three method names, three amounts and
 * three weights, with no rate and no multiple anywhere on the page. A reader
 * could not check $1,032,000 against $6,106,509 without being told the 16.9%
 * in between, and the multiple an SMB conclusion turns on is the single figure
 * a buyer argues about.
 *
 * They are nested one level inside `methods`, which is why the result-key
 * census never saw them: `methods` itself is read, so the top-level sweep is
 * satisfied by the name of the block whose contents are dropped.
 */
function smbBasis(key: string, m: Record<string, unknown>, ctx: ExhibitContext): string {
  const value = (v: unknown, digits = 0) => money(v, ctx, digits);
  if (key === 'capitalization_of_earnings') {
    const stream = value(m.benefit_stream);
    const rate = exactPct(m.cap_rate);
    return stream !== null && rate !== null ? `SDE ${stream} ÷ ${rate}` : '—';
  }
  if (key === 'sde_multiple') {
    const stream = value(m.sde);
    const multiple = num(m.multiple);
    return stream !== null && multiple !== null ? `SDE ${stream} × ${multiple.toFixed(2)}` : '—';
  }
  if (key === 'revenue_multiple') {
    const revenue = value(m.revenue);
    const multiple = num(m.multiple);
    return revenue !== null && multiple !== null ? `Revenue ${revenue} × ${multiple.toFixed(2)}` : '—';
  }
  return '—';
}

function smbExhibit(specialty: Record<string, unknown>, ctx: ExhibitContext): ReportPdfSection | null {
  const methods = record(specialty.methods);
  if (!methods) return null;
  const weights = record(specialty.weights) ?? {};
  const normalization = record(specialty.sde_normalization);
  const addbacks = normalization ? (record(normalization.addbacks) ?? {}) : {};
  const deductions = normalization ? (record(normalization.deductions) ?? {}) : {};
  // The capitalization rate is a subtraction the Basis column states the result
  // of but not the derivation of, and the two figures it is built from are the
  // ones an appraiser is asked to support. Only printed when that method ran.
  const capitalization = record(methods.capitalization_of_earnings);
  const discountRate = capitalization ? exactPct(capitalization.discount_rate) : null;
  const growth = capitalization ? exactPct(capitalization.long_term_growth) : null;
  const capRate = capitalization ? exactPct(capitalization.cap_rate) : null;
  return section('Exhibit — SMB Valuation Methods', [
    normalization
      ? table({
          head: ['SDE normalization', 'Amount'],
          rows: [
            ['Pre-tax income', money(normalization.pretax_income, ctx) ?? '—'],
            ...Object.entries(addbacks)
              .filter(([, v]) => (num(v) ?? 0) !== 0)
              .map(([k, v]) => [`Add back: ${label(k)}`, money(v, ctx) ?? '—']),
            ...Object.entries(deductions)
              .filter(([, v]) => (num(v) ?? 0) !== 0)
              .map(([k, v]) => [`Less: ${label(k)}`, money(v, ctx) ?? '—']),
          ],
          foot: ["Seller's discretionary earnings", money(normalization.sde, ctx) ?? '—'],
        })
      : null,
    table({
      head: ['Method', 'Basis', 'Indicated equity value', 'Weight'],
      rows: Object.entries(methods).map(([key, value]) => {
        const m = record(value) ?? {};
        return [
          esc(SMB_METHOD_LABELS[key] ?? label(key)),
          smbBasis(key, m, ctx),
          money(m.equity_value, ctx) ?? '—',
          pct(weights[key], 0) ?? '—',
        ];
      }),
      foot: ['Concluded equity value', '', money(specialty.equity_value, ctx) ?? '—', ''],
    }),
    discountRate !== null && growth !== null && capRate !== null
      ? P(
          `The capitalization rate is the build-up discount rate of ${discountRate} less ` +
            `long-term growth of ${growth}, or ${capRate}.`,
        )
      : null,
  ]);
}

// ── EMI / CSOP ───────────────────────────────────────────────────────────────

/**
 * `label()` renders `exercise_price_not_below_umv` as "...not below umv". The
 * check keys come from `emi_qualification` and `csop_grant_check`; only the one
 * carrying an acronym needs spelling.
 */
const SCHEME_CHECK_LABELS: Record<string, string> = {
  exercise_price_not_below_umv: 'Exercise price not below UMV',
};

/**
 * The aggregate UMV of the grant being tested — `grant_umv` — with the figures
 * that make it, when the engine reports them.
 *
 * It was excused from the result-key census as "the concluded UMV per share,
 * printed as its own row above the checks", which is a different number: the
 * per-share UMV is £1.95 and `grant_umv` is £175,500. The two coincide nowhere
 * and the excuse was accepted because no captured payload existed to read it
 * against. Under EMI it matters most: `individual_total_umv` adds prior grants
 * to it, so the £235,500 the individual-limit check states is neither the grant
 * nor the priors, and the grant itself appeared on the exhibit nowhere.
 */
function grantRows(qualification: Record<string, unknown>, ctx: ExhibitContext): string[][] {
  const rows: string[][] = [];
  const grant = money(qualification.grant_umv, ctx);
  if (grant !== null) rows.push(['Unrestricted market value of this grant', grant]);
  const individual = money(qualification.individual_total_umv, ctx);
  const grantValue = num(qualification.grant_umv);
  const individualValue = num(qualification.individual_total_umv);
  // Only when it differs from the grant; where there are no prior grants the
  // two are the same figure and a second identical row reads as an error.
  if (
    individual !== null &&
    (grantValue === null || individualValue === null || Math.abs(individualValue - grantValue) > 0.005)
  ) {
    rows.push(['Counted against the individual limit, with prior grants', individual]);
  }
  const company = money(qualification.company_total_umv, ctx);
  if (company !== null) rows.push(['Counted against the company limit, unexercised', company]);
  return rows;
}

function emiCsopExhibit(specialty: Record<string, unknown>, ctx: ExhibitContext): ReportPdfSection | null {
  const umv = num(specialty.umv_per_share);
  if (umv === null) return null;
  const qualification = record(specialty.qualification);
  const checks = qualification ? (record(qualification.checks) ?? {}) : {};
  const scheme = qualification && typeof qualification.scheme === 'string' ? qualification.scheme : null;
  const grants = qualification ? grantRows(qualification, ctx) : [];
  return section('Exhibit — Share Valuation & Scheme Limits', [
    table({
      head: ['Measure', 'Value'],
      rows: [
        ['Pro-rata value per share', money(specialty.pro_rata_per_share, ctx, 4) ?? '—'],
        [`Minority discount`, exactPct(specialty.minority_discount) ?? '—'],
        [`Restriction discount`, exactPct(specialty.restriction_discount) ?? '—'],
        ['Unrestricted market value (UMV) per share', shown(umv, ctx, 4)],
        ...grants,
      ],
      foot: ['Actual market value (AMV) per share', money(specialty.amv_per_share, ctx, 4) ?? '—'],
    }),
    Object.keys(checks).length > 0
      ? table({
          head: [`${scheme === 'csop' ? 'Schedule 4' : 'Schedule 5'} check`, 'Result', 'Basis'],
          rows: Object.entries(checks).map(([key, value]) => {
            const c = record(value) ?? {};
            return [
              esc(SCHEME_CHECK_LABELS[key] ?? label(key)),
              passFail(c.passed),
              esc(String(c.detail ?? '')),
            ];
          }),
        })
      : null,
    // The engine writes its check details in sterling, because the EMI and CSOP
    // limits are statutory sterling amounts. The rows above are in the
    // engagement's currency — deliberately, so a scheme recorded in the wrong
    // one is visible rather than hidden behind a £ sign (the same rule
    // `hmrcForms.ts` states for the VAL231 pack). What was missing was anything
    // telling the reader that, so a USD engagement printed "$1.9500" in one
    // table and "£250,000 limit" in the next with nothing between them.
    Object.keys(checks).length > 0 && ctx.currency && ctx.currency !== 'GBP'
      ? P(
          `The scheme limits above are the statutory sterling amounts. The per-share values are ` +
            `stated in the engagement currency (${esc(ctx.currency)}), which is not sterling; the ` +
            'two are not converted, and the limits should be tested against sterling figures.',
        )
      : null,
    qualification
      ? P(
          `Scheme qualification: <strong>${
            qualification.qualifies === true ? 'qualifies' : 'does not qualify'
          }</strong>.`,
        )
      : null,
  ]);
}

/**
 * The VAL231 / VAL230 data pack, as an appendix to the EMI or CSOP report.
 *
 * Three things this does that a plain table would not:
 *
 * It prints unanswered required fields as an explicit "Not supplied" in the
 * value column instead of leaving the cell empty. A blank cell in a printed
 * table reads as "nothing to declare"; HMRC reads it as an incomplete form and
 * sends it back. The reader has to be able to tell the two apart at a glance.
 *
 * It leads with the outstanding list when anything is missing, because the
 * appendix is worked through top to bottom and the reader needs to know before
 * they start whether this pack is ready to go.
 *
 * It says on its face that this is not HMRC's form. The pack carries our
 * layout and every figure the real form asks for, which is precisely why it
 * has to disclaim being the thing it resembles — otherwise it is the artefact
 * a client submits by mistake.
 */
export function hmrcFormExhibit(form: HmrcForm): ReportPdfSection {
  const rows = (fields: HmrcForm['sections'][number]['fields']) =>
    fields.map((f) => [
      esc(f.label) + (f.required ? ' <strong>*</strong>' : ''),
      f.value === null
        ? `<em>Not supplied${f.required ? ' — required' : ''}</em>`
        : esc(f.value).replace(/\n+/g, '<br />'),
      f.note ? esc(f.note) : '',
    ]);

  const outstanding =
    form.missing_required.length > 0
      ? P(
          `<strong>This pack is not yet complete.</strong> HMRC will not process the form ` +
            `without: ${form.missing_required.map((m) => esc(m)).join('; ')}.`,
        )
      : P('Every field this form requires has been answered.');

  return {
    heading: `Appendix — ${form.code}: HMRC valuation agreement request`,
    html:
      P(esc(form.title)) +
      P(
        'The figures and particulars below are supplied to complete the HMRC Shares and Assets ' +
          'Valuation request for this grant. <strong>This appendix is a data pack, not the form ' +
          'itself</strong> — the form must be obtained from HMRC and submitted by the company or ' +
          'its agent. Fields marked * are required.',
      ) +
      outstanding +
      form.sections
        .map(
          (s) =>
            `<h3>${esc(s.title)}</h3>` + table({ head: ['Field', 'Value', 'Note'], rows: rows(s.fields) }),
        )
        .join(''),
  };
}

// ── IP (single intangible) ───────────────────────────────────────────────────

/**
 * The columns of each method's cash-flow schedule, in the order the method
 * builds them. Named per method rather than derived from the row's own keys:
 * the order is the argument the schedule makes, and iterating an object's keys
 * would print MEEM's contributory charge before the earnings it is charged
 * against on any engine that happened to build the dict differently.
 *
 * `money` for an amount, `pct` for a rate, plain for a count.
 */
const IP_SCHEDULE: Record<string, { key: string; head: string; as: 'money' | 'pct' | 'plain' }[]> = {
  relief_from_royalty: [
    { key: 'year', head: 'Year', as: 'plain' },
    { key: 'revenue', head: 'Revenue', as: 'money' },
    { key: 'royalty_savings', head: 'Royalty savings', as: 'money' },
    { key: 'after_tax', head: 'After tax', as: 'money' },
    { key: 'pv', head: 'Present value', as: 'money' },
  ],
  // MEEM in two tables rather than one. Its chain is nine columns wide, and the
  // renderer sizes columns in proportion and shrinks them all when they exceed
  // the page — so nine of them does not overflow, it squeezes, and at ordinary
  // magnitudes ($10m of revenue) the amounts wrap inside their cells: "$1,007,"
  // on one line and "543" on the next, down the present-value column of a
  // valuation exhibit. Measured on a rendered page, not guessed;
  // `specialtyExhibitsPdf.test.ts` is what holds it.
  //
  // The split is at the figure both halves share. The first table builds the
  // earnings attributable to the asset, the second charges the contributory
  // assets against them and discounts what is left, and `after_tax_earnings`
  // is repeated as the second table's opening column so the reader can see
  // where it picks up.
  meem: [
    { key: 'year', head: 'Year', as: 'plain' },
    { key: 'revenue', head: 'Revenue', as: 'money' },
    { key: 'survival', head: 'Survival', as: 'pct' },
    { key: 'attributable_revenue', head: 'Attributable revenue', as: 'money' },
    { key: 'ebit', head: 'EBIT', as: 'money' },
    { key: 'after_tax_earnings', head: 'After-tax earnings', as: 'money' },
  ],
  meem_excess: [
    { key: 'year', head: 'Year', as: 'plain' },
    { key: 'after_tax_earnings', head: 'After-tax earnings', as: 'money' },
    { key: 'contributory_charge', head: 'Contributory charge', as: 'money' },
    { key: 'excess_earnings', head: 'Excess earnings', as: 'money' },
    { key: 'pv', head: 'Present value', as: 'money' },
  ],
  with_and_without: [
    { key: 'year', head: 'Year', as: 'plain' },
    { key: 'with', head: 'With the asset', as: 'money' },
    { key: 'without', head: 'Without the asset', as: 'money' },
    { key: 'after_tax_differential', head: 'After-tax differential', as: 'money' },
    { key: 'pv', head: 'Present value', as: 'money' },
  ],
};

/**
 * The rates each intangible method ran on, in the order a reviewer reads them
 * and in the words a report uses. `label()` would render
 * `contributory_charges_pct` as "Contributory charges pct".
 *
 * Every one is a fraction, so the table is a column of percentages; a rate that
 * arrives as something else is dropped rather than printed as "NaN%".
 */
const IP_ASSUMPTION_LABELS: Array<[string, string]> = [
  ['royalty_rate', 'Royalty rate'],
  ['ebit_margin', 'EBIT margin'],
  ['attrition_rate', 'Customer attrition rate'],
  ['contributory_charges_pct', 'Contributory asset charges, as a share of attributable revenue'],
  ['tax_rate', 'Tax rate'],
  ['discount_rate', 'Discount rate'],
  ['terminal_growth', 'Terminal growth rate'],
  ['developer_profit_pct', "Developer's profit"],
  ['opportunity_cost_pct', 'Entrepreneurial incentive'],
];

const IP_METHOD_LABELS: Record<string, string> = {
  relief_from_royalty: 'Relief from royalty',
  meem: 'Multi-period excess earnings',
  with_and_without: 'With and without',
  cost_approach: 'Cost approach',
};

/**
 * The intangible-asset schedules, per the method the run dispatched to.
 *
 * This exhibit used to read `pv_before_tab`, `pv`, `tab`, `discount_rate`,
 * `royalty_rate` and `tax_rate`. `value_intangible` returns none of those — not
 * under those names and not under any others, because three of them are inputs
 * the result does not echo. Every row was therefore dropped, `rows.length > 0`
 * was false for every IP valuation ever run, and the deliverable for an
 * engagement priced by a discounted royalty stream was one sentence stating a
 * number: no schedule, no method named, no step between the cash flows and the
 * conclusion. The census in `specialtyResultCoverage.test.ts` is what surfaced
 * it; the exhibit was written against an assumed shape and no sample was ever
 * captured for this kind to contradict it.
 */
function intangibleExhibit(specialty: Record<string, unknown>, ctx: ExhibitContext): ReportPdfSection | null {
  const fairValue = num(specialty.fair_value);
  if (fairValue === null) return null;
  const method = typeof specialty.method === 'string' ? specialty.method : null;

  // The cost approach has no cash-flow schedule and no TAB; its argument is the
  // cost new and the layers taken off it, which compound rather than sum.
  const obsolescence = record(specialty.obsolescence);
  const costNew = num(specialty.replacement_cost_new);
  // The rates the engine ran on, echoed by every method since R136. Absent from
  // any result stored before that, which is why nothing here is required.
  const assumptions = record(specialty.assumptions);
  // The obsolescence layers reach the exhibit as amounts, and the amounts
  // compound — so a reader given only the amounts cannot recover the rate any
  // of them was estimated at, which is the figure the appraisal is arguing.
  const obsolescencePct = record(assumptions?.obsolescence_pct);
  const costTable =
    costNew !== null
      ? table({
          head: ['Cost approach', 'Amount'],
          rows: [
            ['Replacement cost new, including entrepreneurial incentive', shown(costNew, ctx)],
            ...Object.entries(obsolescence ?? {})
              .filter(([, v]) => num(v) !== null)
              .map(([k, v]) => {
                const rate = pct(obsolescencePct?.[k]);
                return [`Less ${k} obsolescence${rate === null ? '' : ` (${rate})`}`, money(v, ctx) ?? '—'];
              }),
          ],
          foot: ['Concluded fair value', shown(fairValue, ctx)],
        })
      : null;
  // Stated whenever more than one layer was taken, because a reader who reads
  // them as three percentages of the top line gets a different answer.
  const compoundingNote =
    costTable !== null && obsolescence !== null && Object.keys(obsolescence).length > 1
      ? P(
          'The obsolescence layers compound: each is taken against the value remaining after ' +
            'the one above it, not against cost new, so the amounts do not sum to a single ' +
            'percentage of the top line.',
        )
      : null;

  const rows = list(specialty.schedule)
    .map(record)
    .filter((r): r is Record<string, unknown> => r !== null);
  const scheduleFor = (spec: string): string | null => {
    const columns = IP_SCHEDULE[spec];
    if (!columns || rows.length === 0) return null;
    return table({
      head: columns.map((c) => c.head),
      rows: rows.map((row) =>
        columns.map((c) => {
          if (c.as === 'money') return money(row[c.key], ctx) ?? '—';
          if (c.as === 'pct') return pct(row[c.key]) ?? '—';
          return str(row[c.key]);
        }),
      ),
    });
  };
  const scheduleTable = method === null ? null : scheduleFor(method);
  // Only MEEM has a second half; the key is absent for every other method.
  const scheduleTable2 = method === null ? null : scheduleFor(`${method}_excess`);

  // The bridge from the discounted cash flows to the conclusion. `pv_explicit`
  // and `pv_terminal` are the relief-from-royalty split; the other two income
  // methods report the total only.
  const bridgeRows: string[][] = [];
  const put = (name: string, value: string | null) => {
    if (value !== null) bridgeRows.push([name, value]);
  };
  put('Present value of the explicit forecast', money(specialty.pv_explicit, ctx));
  put('Present value of the terminal period', money(specialty.pv_terminal, ctx));
  put('Value before the tax amortization benefit', money(specialty.value_before_tab, ctx));
  // A multiplier, not an amount: 1.0847 is an 8.5% uplift, and printing it as
  // currency would put "$1" beside a seven-figure conclusion. Stated as both
  // the factor and the amount it adds, because the amount is what a reviewer
  // ties to the conclusion.
  const tabMultiplier = num(specialty.tab_multiplier);
  const valueBeforeTab = num(specialty.value_before_tab);
  if (tabMultiplier !== null) {
    bridgeRows.push([
      `Tax amortization benefit (×${tabMultiplier.toFixed(4)})`,
      valueBeforeTab === null ? '—' : shown(fairValue - valueBeforeTab, ctx),
    ]);
  }
  const bridge =
    bridgeRows.length > 0
      ? table({
          head: ['Measure', 'Amount'],
          rows: bridgeRows,
          foot: ['Concluded fair value', shown(fairValue, ctx)],
        })
      : null;

  /**
   * The rates behind the schedule.
   *
   * `value_intangible` used not to echo them at all — they are inputs, so
   * nothing in the result carried them and the exhibit had nothing to read.
   * That left the discount rate, the royalty rate and the tax rate off the
   * page: the three figures a reviewer checks a relief-from-royalty conclusion
   * against, absent from the schedule that was discounted at them.
   */
  const assumptionRows = IP_ASSUMPTION_LABELS.flatMap(([key, caption]) => {
    const rate = pct(assumptions?.[key]);
    return rate === null ? [] : [[caption, rate]];
  });
  const assumptionTable =
    assumptionRows.length > 0 ? table({ head: ['Assumption', 'Rate'], rows: assumptionRows }) : null;

  return section('Exhibit — Intangible Asset Valuation', [
    method === null ? null : P(`Method: <strong>${esc(IP_METHOD_LABELS[method] ?? label(method))}</strong>.`),
    assumptionTable,
    scheduleTable,
    scheduleTable2,
    bridge,
    costTable,
    compoundingNote,
    // Only when nothing above it printed — otherwise the conclusion is already
    // the foot of a table and this repeats it.
    scheduleTable === null && scheduleTable2 === null && bridge === null && costTable === null
      ? P(`Concluded fair value: <strong>${shown(fairValue, ctx)}</strong>.`)
      : null,
  ]);
}

// ── ASC 820 fair-value measurement ───────────────────────────────────────────

/**
 * The 820-10-50 disclosure tables: the hierarchy, the positions the rules
 * re-levelled, the significant unobservable inputs, and the Level 3
 * rollforward.
 *
 * The reclassification table is second rather than last on purpose. A position
 * the engine moved out of the level the analyst stated is the finding a
 * reviewer opens this exhibit for, and a schedule that reports only the
 * aggregate would let a Level 3 measurement be disclosed as Level 2 with the
 * evidence three tables further down.
 */
function fairValue820Exhibit(
  specialty: Record<string, unknown>,
  ctx: ExhibitContext,
): ReportPdfSection | null {
  const total = num(specialty.total_fair_value);
  const byLevel = record(specialty.by_level);
  if (total === null || !byLevel) return null;

  const nav = record(specialty.nav_practical_expedient);
  const navAmount = num(nav?.fair_value);
  const categorised = num(specialty.categorized_fair_value);

  const hierarchy = table({
    head: ['Fair value hierarchy', 'Amount', '% of total'],
    rows: [
      ['Level 1 — quoted prices in active markets', 'level_1'],
      ['Level 2 — other observable inputs', 'level_2'],
      ['Level 3 — unobservable inputs', 'level_3'],
    ].map(([caption, key]) => {
      const amount = num(byLevel[key!]) ?? 0;
      return [caption!, shown(amount, ctx), total > 0 ? formatPercent(amount / total) : '—'];
    }),
    foot: ['Total fair value', shown(total, ctx), '100.0%'],
  });

  // Only when there is one. The NAV expedient line reconciles the hierarchy to
  // the statement total (820-10-35-59) and reads as a fourth level if it is
  // printed at zero for a portfolio that holds no such investment.
  const navLine =
    navAmount !== null && navAmount !== 0
      ? table({
          head: ['Reconciling item', 'Amount'],
          rows: [
            ['Categorised in the hierarchy', categorised === null ? '—' : shown(categorised, ctx)],
            ['Measured at net asset value as a practical expedient', shown(navAmount, ctx)],
          ],
          foot: ['Total per the statement of financial position', shown(total, ctx)],
        }) + P(str(nav?.note, ''))
      : null;

  const reclassified = list(specialty.reclassified_positions)
    .map(record)
    .filter((r): r is Record<string, unknown> => r !== null);
  const reclassifiedTable =
    reclassified.length > 0
      ? P(
          'The categorisation below differs from the level stated for the position. ' +
            'ASC 820-10-35-37 categorises a measurement by the lowest level of input ' +
            'that is significant to it.',
        ) +
        table({
          head: ['Position', 'Categorised as', 'Basis'],
          rows: reclassified.map((r) => [str(r.name), label(str(r.level)), str(r.basis)]),
        })
      : null;

  const unobservable = list(specialty.unobservable_inputs)
    .map(record)
    .filter((r): r is Record<string, unknown> => r !== null);
  const unobservableTable =
    unobservable.length > 0
      ? table({
          head: ['Significant unobservable input', 'Low', 'High', 'Weighted average', 'Positions'],
          rows: unobservable.map((u) => {
            const average = num(u.weighted_average);
            return [
              str(u.input),
              String(num(u.low) ?? '—'),
              String(num(u.high) ?? '—'),
              // Labelled when it is not what 820-10-50-2(bbb) asks for: every
              // position carrying the input was marked at zero, so there was no
              // weight to average by and this is the arithmetic mean.
              average === null
                ? '—'
                : `${average}${u.weighted === false ? ' (unweighted — no fair value to weight by)' : ''}`,
              String(num(u.position_count) ?? '—'),
            ];
          }),
        })
      : null;

  const roll = record(specialty.level_3_rollforward);
  const rollTable = roll
    ? table({
        head: ['Level 3 rollforward', 'Amount'],
        rows: [
          'beginning_balance',
          'purchases',
          'issuances',
          'sales',
          'settlements',
          'transfers_into_level_3',
          'transfers_out_of_level_3',
          'realized_gains_losses',
          'unrealized_gains_losses',
        ]
          .map((key) => [label(key), money(roll[key], ctx)])
          .filter((row): row is string[] => row[1] !== null),
        foot: ['Ending balance', money(byLevel.level_3, ctx) ?? '—'],
      }) +
      // The engine foots the rollforward against the Level 3 total it measured
      // and reports whether the two agree. A rollforward that does not tie is
      // the single most important thing on this exhibit, and printing the table
      // without the verdict leaves the reader to add up nine rows to find out.
      (roll.ties === false
        ? P(
            `<strong>The rollforward does not tie.</strong> The movements sum to ` +
              `${money(roll.computed_ending_balance, ctx) ?? '—'} against a measured Level 3 balance of ` +
              `${money(roll.measured_ending_balance, ctx) ?? '—'} — a difference of ` +
              `${money(roll.difference, ctx) ?? '—'}.`,
          )
        : P('The movements above tie to the measured Level 3 balance.'))
    : null;

  // ASC 820-10-50-2(g) asks, for recurring Level 3 measurements, for a
  // narrative description of the sensitivity of the measurement to changes in
  // the significant unobservable inputs. `_sensitivity` computes exactly that
  // and the module docstring names it as one of the three things this engine
  // exists to produce; the exhibit printed the table of inputs and dropped the
  // effect of moving them. R134 made the schedule an analyst run input, so it
  // is suppliable from the workspace and was still going nowhere.
  const sensitivity = list(specialty.sensitivity)
    .map(record)
    .filter((r): r is Record<string, unknown> => r !== null);
  const sensitivityTable =
    sensitivity.length > 0
      ? P(
          'The effect on the Level 3 total of a change in each significant unobservable input, ' +
            'holding the others at the values used in the measurement (ASC 820-10-50-2(g)).',
        ) +
        table({
          head: ['Unobservable input', 'Change', 'Effect on fair value', 'Level 3 total after'],
          rows: sensitivity.map((r) => {
            const shift = num(r.shift);
            return [
              str(r.input),
              // Signed, because the direction is the disclosure: "a 5% decrease
              // in the DLOM would increase fair value by ..." is unreadable
              // from an unsigned magnitude.
              shift === null ? '—' : `${shift > 0 ? '+' : ''}${formatPercent(shift)}`,
              money(r.fair_value_effect, ctx) ?? '—',
              money(r.fair_value_after, ctx) ?? '—',
            ];
          }),
        })
      : null;

  return section('Exhibit — Fair Value Measurements (ASC 820-10-50)', [
    hierarchy,
    navLine,
    reclassifiedTable,
    unobservableTable,
    rollTable,
    sensitivityTable,
  ]);
}

// ── Gift & estate ────────────────────────────────────────────────────────────

/**
 * The value bridge, the discount arithmetic and the Revenue Ruling 59-60
 * checklist.
 *
 * `effective_discount` is printed beside the two rates because it is the line
 * a reviewer checks: the discounts compound, 1 − (1 − a)(1 − b), and a reader
 * who adds them gets a different number.
 */
function giftEstateExhibit(specialty: Record<string, unknown>, ctx: ExhibitContext): ReportPdfSection | null {
  const concluded = num(specialty.concluded_value);
  const proRata = num(specialty.pro_rata_value);
  if (concluded === null || proRata === null) return null;

  const percent = num(specialty.percent_interest);
  const entity = num(specialty.entity_value);
  const bridge = table({
    head: ['Step', 'Rate', 'Amount'],
    rows: [
      ['Entity value', '', entity === null ? '—' : shown(entity, ctx)],
      [
        // `percent_interest` comes back as a percentage, not a fraction — the
        // engine takes it that way because that is how the questionnaire asks
        // ("what percentage interest was transferred"), and reports it
        // unchanged. Running it through `pct` would print a 15% interest as
        // 1,500%.
        `Pro rata ${percent === null ? '' : `${percent}%`} interest`.trim(),
        '',
        shown(proRata, ctx),
      ],
      [
        'Less discount for lack of control',
        exactPct(specialty.dloc) ?? '—',
        money(specialty.value_after_dloc, ctx) ?? '—',
      ],
      ['Less discount for lack of marketability', exactPct(specialty.dlom) ?? '—', shown(concluded, ctx)],
    ],
    foot: [
      'Concluded value of the transferred interest',
      exactPct(specialty.effective_discount) ?? '—',
      shown(concluded, ctx),
    ],
  });

  // What the transfer was and when. `transfer_type` is a required question
  // with four answers and it is what decides whether the §2503(b) exclusion is
  // available at all; `transfer_date` is required too and is, for an estate,
  // the date of death the whole appraisal is struck at. The exhibit printed
  // neither, so a gift return and an estate inclusion rendered identically and
  // the exclusion row below could say "not available for this transfer"
  // without the reader knowing which transfer that was.
  const transferType = typeof specialty.transfer_type === 'string' ? specialty.transfer_type : null;
  const transferDate = typeof specialty.transfer_date === 'string' ? specialty.transfer_date : null;
  const transferNote =
    transferType === null
      ? null
      : P(
          `Transfer: <strong>${esc(TRANSFER_LABELS[transferType] ?? label(transferType))}</strong>` +
            (transferDate === null
              ? '.'
              : ` on <strong>${esc(transferDate)}</strong>, the date the interest is valued at.`),
        );

  const exclusion = record(specialty.annual_exclusion);
  const taxable = num(specialty.taxable_gift);
  // Three states, not two. The exclusion may not apply to this transfer (an
  // estate inclusion, a GST), it may apply and have been determined, or it may
  // apply and nobody have said what the year's §2503(b) figure is. The third
  // used to print as the second with a nil amount — "less annual exclusion —
  // $0" beside a cumulative total struck at the whole appraised value, which
  // is a determination the file had not made.
  //
  // Results stored before the engine reported `determined` carry no such key,
  // and every one of them was run through a questionnaire with no exclusion
  // field — so an absent flag over a nil per-donee figure is the unanswered
  // case, and an absent flag over a real one came from a run override.
  const applies = exclusion?.applies === true;
  const determined =
    exclusion?.determined === true ||
    (exclusion?.determined === undefined && (num(exclusion?.per_donee) ?? 0) > 0);
  const exclusionRow: [string, string] = applies
    ? determined
      ? [
          `Less annual exclusion (${String(num(exclusion?.donees) ?? 1)} donee(s)` +
            `${exclusion?.split_gift === true ? ', split gift' : ''})`,
          `−${money(exclusion?.applied, ctx) ?? '—'}`,
        ]
      : ['Less annual exclusion — not determined', 'Not determined']
    : [
        // The reason, not just the refusal. §2503(b) shelters a present
        // interest transferred by gift; an estate inclusion under §2031 and a
        // generation-skipping transfer are not gifts, and saying only "not
        // available" leaves a preparer to wonder whether it was overlooked.
        `Annual exclusion — not available for ${
          transferType === 'estate'
            ? 'an estate inclusion (§2031)'
            : transferType === 'gst'
              ? 'a generation-skipping transfer'
              : 'this transfer'
        }`,
        '—',
      ];
  const gift =
    taxable === null
      ? null
      : table({
          head: ['Reportable gift', 'Amount'],
          rows: [
            ['Value of the transferred interest', shown(concluded, ctx)],
            exclusionRow,
            ['Prior taxable gifts', money(specialty.prior_taxable_gifts, ctx) ?? '—'],
          ],
          foot: [
            applies && !determined
              ? 'Cumulative taxable gifts, before any annual exclusion'
              : 'Cumulative taxable gifts',
            money(specialty.cumulative_taxable_gifts, ctx) ?? '—',
          ],
        });

  const factors = record(specialty.rev_rul_59_60);
  const factorRows = list(factors?.factors)
    .map(record)
    .filter((r): r is Record<string, unknown> => r !== null);
  // An unstated checklist is not a checklist of eight refusals. Nothing sent
  // `factors_addressed` until the questionnaire grew the section, so every gift
  // appraisal printed a No against each §4.01 factor and footed "0 of 8" — a
  // Rev. Rul. 59-60 report stating it addressed none of the eight factors it is
  // graded on. Results stored before the engine reported `stated` are read by
  // their count, the same way the annual exclusion above is.
  const stated =
    factors?.stated === true || (factors?.stated === undefined && (num(factors?.addressed_count) ?? 0) > 0);
  const checklist =
    factorRows.length > 0
      ? table({
          head: ['Revenue Ruling 59-60 factor', 'Addressed'],
          rows: factorRows.map((f) => [
            str(f.label ?? f.key),
            stated ? (f.addressed === true ? 'Yes' : 'No') : 'Not recorded',
          ]),
          foot: stated
            ? [
                'Factors addressed',
                `${String(num(factors?.addressed_count) ?? 0)} of ${String(num(factors?.total_count) ?? factorRows.length)}`,
              ]
            : ['Factors addressed', 'Not recorded'],
        })
      : null;

  return section('Exhibit — Transferred Interest and Discounts', [transferNote, bridge, gift, checklist]);
}

// ── IFRS 2 share-based payment ───────────────────────────────────────────────

/**
 * The grant-date measurement and the expense attribution.
 *
 * `warnings` and the true-up basis are rendered rather than dropped: both are
 * statements about which paragraph governs the number above them, and an
 * expense schedule with no note of whether it will be trued up is a figure a
 * reviewer cannot check.
 */
/**
 * IFRS 2's own vocabulary, where `label()` does not reach it. "Performance non
 * market" is not what the standard calls a non-market performance condition,
 * and "Black scholes" is not the name of the model — both were printed on the
 * grant-date measurement table of a report a reviewer reads.
 */
const IFRS2_TERMS: Record<string, string> = {
  equity_settled: 'Equity-settled',
  cash_settled: 'Cash-settled',
  service: 'Service condition',
  performance_non_market: 'Non-market performance condition',
  market: 'Market condition',
  black_scholes: 'Black-Scholes',
  supplied: 'Supplied (lattice or Monte Carlo, run elsewhere)',
  graded: 'Graded',
  straight_line: 'Straight-line',
};

/** One of IFRS 2's terms, or the humanized key for anything unfamiliar. */
function term(value: unknown): string {
  const key = typeof value === 'string' ? value : null;
  return key === null ? '—' : esc(IFRS2_TERMS[key] ?? label(key));
}

function ifrs2Exhibit(specialty: Record<string, unknown>, ctx: ExhibitContext): ReportPdfSection | null {
  const totalExpense = num(specialty.total_expense);
  const perAward = num(specialty.fair_value_per_award);
  if (totalExpense === null || perAward === null) return null;

  // A forfeiture estimate of nil and no forfeiture estimate produce the same
  // arithmetic and are not the same statement: IFRS 2.19-20 measures the
  // expense on the awards *expected to vest*, so 0% asserts that every award
  // will, and the exhibit printed that assertion for every engagement while
  // the questionnaire asked nobody. A market condition is the one case where
  // the absence is correct — IFRS 2.21 puts it in the fair value instead.
  //
  // Results stored before the engine reported `forfeiture_determined` carry no
  // such key; a rate above nil in one of them was necessarily supplied through
  // a run override, and a nil one was the default nobody chose.
  const marketCondition = str(specialty.vesting_condition) === 'market';
  const forfeitureRate = num(specialty.expected_forfeiture_rate) ?? 0;
  const forfeitureDetermined =
    specialty.forfeiture_determined === true ||
    (specialty.forfeiture_determined === undefined && forfeitureRate > 0);
  const forfeitureRow: [string, string] = marketCondition
    ? ['Expected forfeiture rate — in the grant-date fair value (IFRS 2.21)', '—']
    : forfeitureDetermined
      ? ['Expected forfeiture rate', pct(specialty.expected_forfeiture_rate) ?? '—']
      : ['Expected forfeiture rate — not estimated', 'Not estimated'];

  const measurement = table({
    head: ['Grant-date measurement', 'Value'],
    rows: [
      ['Settlement', term(specialty.settlement)],
      ['Vesting condition', term(specialty.vesting_condition)],
      ['Model', term(specialty.model)],
      ['Fair value per award', shown(perAward, ctx, 4)],
      ['Awards granted', count(specialty.options_granted) ?? '—'],
      ['Grant-date fair value', money(specialty.grant_date_fair_value_total, ctx) ?? '—'],
      forfeitureRow,
      [
        forfeitureDetermined || marketCondition
          ? 'Expected to vest'
          : 'Expected to vest — every award granted, no estimate made',
        count(specialty.expected_to_vest) ?? '—',
      ],
    ],
    foot: ['Total expense', shown(totalExpense, ctx)],
  });

  const schedule = list(specialty.expense_schedule)
    .map(record)
    .filter((r): r is Record<string, unknown> => r !== null);
  const scheduleTable =
    schedule.length > 0
      ? table({
          // `period` is the expense *of* the period, not its name — the name is
          // `year`. Reading them the other way round prints the schedule with
          // every row labelled by its own amount.
          head: ['Year', 'Expense', 'Cumulative', 'Cumulative %'],
          rows: schedule.map((p) => [
            `Year ${String(num(p.year) ?? '—')}`,
            money(p.period, ctx) ?? '—',
            money(p.cumulative, ctx) ?? '—',
            pct(p.cumulative_pct) ?? '—',
          ]),
          foot: [`Attribution — ${term(specialty.attribution)}`, shown(totalExpense, ctx), '', '100.0%'],
        })
      : null;

  const trueUp = record(specialty.true_up);
  const trueUpNote = trueUp ? P(str(trueUp.basis, '')) : null;

  // The remeasurement the engine computes and this exhibit used to drop. For a
  // cash-settled award that is a disclosure in its own right — the award is a
  // liability carried at fair value, and the change in it goes through profit
  // or loss each period (IFRS 2.30-33) — so an exhibit that printed only the
  // grant-date expense left a reader with no sight of the liability at all.
  // The equity-settled case renders too: "measured once and not remeasured" is
  // the statement a reviewer checks the absence of the table against.
  const remeasurement = record(specialty.remeasurement);
  const remeasured = remeasurement?.required === true;
  const currentTotal = num(remeasurement?.current_total);
  const remeasurementTable =
    remeasured && currentTotal !== null
      ? table({
          head: ['Remeasurement at the reporting date', 'Value'],
          rows: [
            ['Fair value per award', money(remeasurement?.current_fair_value_per_award, ctx, 4) ?? '—'],
            ['Awards expected to vest', count(specialty.expected_to_vest) ?? '—'],
            ['Liability at grant-date fair value', shown(totalExpense, ctx)],
          ],
          foot: ['Liability carried at fair value', shown(currentTotal, ctx)],
        })
      : null;
  const changeNote =
    remeasured && currentTotal !== null
      ? P(
          `<strong>Change in the liability.</strong> ${esc(
            money(remeasurement?.change_in_liability, ctx) ?? '—',
          )}, recognised in profit or loss for the period.`,
        )
      : null;
  const remeasurementNote = remeasurement ? P(str(remeasurement.basis, '')) : null;

  const warnings = list(specialty.warnings).filter((w): w is string => typeof w === 'string');
  const warningNote =
    warnings.length > 0 ? warnings.map((w) => P(`<strong>Note.</strong> ${esc(w)}`)).join('') : null;

  return section('Exhibit — Share-Based Payment (IFRS 2)', [
    measurement,
    scheduleTable,
    trueUpNote,
    remeasurementTable,
    changeNote,
    remeasurementNote,
    warningNote,
  ]);
}

/**
 * The exhibits for a specialty calculation, dispatched on the kind the run
 * recorded (results.kind, written by routes/specialty.ts). Unknown kinds and
 * unfamiliar shapes produce no sections.
 */
export function buildSpecialtyExhibits(
  calculation: CalculationRow | null,
  ctx: ExhibitContext,
): ReportPdfSection[] {
  if (!calculation || calculation.status !== 'succeeded' || !calculation.results) return [];
  const specialty = record(calculation.results.specialty);
  if (!specialty) return [];
  const kind = typeof calculation.results.kind === 'string' ? calculation.results.kind : '';
  const built = (() => {
    switch (kind) {
      case 'qsbs':
        return [qsbsExhibit(specialty, ctx)];
      case 'ppa':
        return [ppaExhibit(specialty, ctx)];
      case 'goodwill':
        return [impairmentExhibit(specialty, ctx)];
      case 'esop':
        return [esopExhibit(specialty, ctx)];
      case 'fmv':
        return [smbExhibit(specialty, ctx)];
      case 'emi':
      case 'csop':
        return [emiCsopExhibit(specialty, ctx)];
      case 'ip':
        return [intangibleExhibit(specialty, ctx)];
      // The three kinds that gained an engine endpoint after this switch was
      // written. Each ran, recorded a result, and then rendered a deliverable
      // with no schedules at all under an "Index of Exhibits" section
      // promising them.
      case '820':
        return [fairValue820Exhibit(specialty, ctx)];
      case 'gifts':
        return [giftEstateExhibit(specialty, ctx)];
      case 'ifrs2':
        return [ifrs2Exhibit(specialty, ctx)];
      default:
        return [];
    }
  })();
  return built.filter((s): s is ReportPdfSection => s !== null);
}
