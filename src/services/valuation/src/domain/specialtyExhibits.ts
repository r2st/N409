import type { ReportPdfSection } from '@n409/report/pdf';
import type { CalculationRow } from '../repos/calculations.js';
import { formatCurrency, formatPercent, num } from './reportSummary.js';
import type { ExhibitContext } from './reportExhibits.js';
import type { HmrcForm } from './hmrcForms.js';
import { esc, P, section, table } from './exhibitHtml.js';

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

function pct(value: unknown, digits = 1): string | null {
  const n = num(value);
  return n === null ? null : formatPercent(n, digits);
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
  return section('Exhibit — Purchase Price Allocation', [
    intangibles.length > 0
      ? table({
          head: ['Intangible asset', 'Method', 'Fair value'],
          rows: intangibles.map((i) => [
            esc(String(i.name ?? '—')),
            esc(String(i.method ?? '—')),
            money(i.fair_value, ctx) ?? '—',
          ]),
          foot: ['Total identifiable intangibles', '', money(specialty.total_intangible_value, ctx) ?? '—'],
        })
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
  return section(`Exhibit — Impairment Test (${esc(String(specialty.standard))})`, [
    unit ? P(`Unit tested: <strong>${esc(String(unit))}</strong>.`) : null,
    table({
      head: ['Measure', 'Amount'],
      rows,
      foot: [
        specialty.impaired === true ? 'Impairment loss' : 'Impairment loss (none indicated)',
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
  return section('Exhibit — ESOP Level of Value', [
    table({
      head: ['Level of value', 'Amount'],
      rows: [
        ['Control', money(levels.control, ctx) ?? '—'],
        [
          `Marketable minority (DLOC ${pct(specialty.dloc) ?? '—'})`,
          money(levels.marketable_minority, ctx) ?? '—',
        ],
        [
          `Nonmarketable minority (DLOM ${pct(specialty.dlom) ?? '—'})`,
          money(levels.nonmarketable_minority, ctx) ?? '—',
        ],
      ],
      foot: ['Fair market value per share', money(specialty.fmv_per_share, ctx, 4) ?? '—'],
    }),
    num(specialty.esop_stake_value) !== null
      ? P(`Value of the shares held by the ESOP: <strong>${money(specialty.esop_stake_value, ctx)}</strong>.`)
      : null,
    schedule.length > 0
      ? table({
          head: ['Year', 'Share price', 'Shares redeemed', 'Repurchase cost', 'Remaining shares'],
          rows: schedule.map((r) => [
            String(num(r.year) ?? '—'),
            money(r.share_price, ctx, 2) ?? '—',
            INT.format(Math.round(num(r.shares_redeemed) ?? 0)),
            money(r.repurchase_cost, ctx) ?? '—',
            INT.format(Math.round(num(r.remaining_shares) ?? 0)),
          ]),
          foot: [
            'Total obligation',
            '',
            '',
            money(repurchase!.total_obligation, ctx) ?? '—',
            num(repurchase!.pv_of_obligation) !== null
              ? `PV ${money(repurchase!.pv_of_obligation, ctx)}`
              : '',
          ],
        })
      : null,
  ]);
}

// ── SMB ──────────────────────────────────────────────────────────────────────

function smbExhibit(specialty: Record<string, unknown>, ctx: ExhibitContext): ReportPdfSection | null {
  const methods = record(specialty.methods);
  if (!methods) return null;
  const weights = record(specialty.weights) ?? {};
  const normalization = record(specialty.sde_normalization);
  const addbacks = normalization ? (record(normalization.addbacks) ?? {}) : {};
  const deductions = normalization ? (record(normalization.deductions) ?? {}) : {};
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
      head: ['Method', 'Indicated equity value', 'Weight'],
      rows: Object.entries(methods).map(([key, value]) => {
        const m = record(value) ?? {};
        return [label(key), money(m.equity_value, ctx) ?? '—', pct(weights[key], 0) ?? '—'];
      }),
      foot: ['Concluded equity value', money(specialty.equity_value, ctx) ?? '—', ''],
    }),
  ]);
}

// ── EMI / CSOP ───────────────────────────────────────────────────────────────

function emiCsopExhibit(specialty: Record<string, unknown>, ctx: ExhibitContext): ReportPdfSection | null {
  const umv = num(specialty.umv_per_share);
  if (umv === null) return null;
  const qualification = record(specialty.qualification);
  const checks = qualification ? (record(qualification.checks) ?? {}) : {};
  const scheme = qualification && typeof qualification.scheme === 'string' ? qualification.scheme : null;
  return section('Exhibit — Share Valuation & Scheme Limits', [
    table({
      head: ['Measure', 'Value'],
      rows: [
        ['Pro-rata value per share', money(specialty.pro_rata_per_share, ctx, 4) ?? '—'],
        [`Minority discount`, pct(specialty.minority_discount) ?? '—'],
        [`Restriction discount`, pct(specialty.restriction_discount) ?? '—'],
        ['Unrestricted market value (UMV) per share', shown(umv, ctx, 4)],
      ],
      foot: ['Actual market value (AMV) per share', money(specialty.amv_per_share, ctx, 4) ?? '—'],
    }),
    Object.keys(checks).length > 0
      ? table({
          head: [`${scheme === 'csop' ? 'Schedule 4' : 'Schedule 5'} check`, 'Result', 'Basis'],
          rows: Object.entries(checks).map(([key, value]) => {
            const c = record(value) ?? {};
            return [label(key), passFail(c.passed), esc(String(c.detail ?? ''))];
          }),
        })
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

function intangibleExhibit(specialty: Record<string, unknown>, ctx: ExhibitContext): ReportPdfSection | null {
  const fairValue = num(specialty.fair_value);
  if (fairValue === null) return null;
  const rows: string[][] = [];
  const put = (name: string, value: string | null) => {
    if (value !== null) rows.push([name, value]);
  };
  put('Present value before TAB', money(specialty.pv_before_tab ?? specialty.pv, ctx));
  put('Tax amortization benefit', money(specialty.tab, ctx));
  put('Discount rate', pct(specialty.discount_rate));
  put('Royalty rate', pct(specialty.royalty_rate));
  put('Tax rate', pct(specialty.tax_rate, 0));
  return section('Exhibit — Intangible Asset Valuation', [
    rows.length > 0 ? table({ head: ['Measure', 'Value'], rows }) : null,
    P(`Concluded fair value: <strong>${shown(fairValue, ctx)}</strong>.`),
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

  return section('Exhibit — Fair Value Measurements (ASC 820-10-50)', [
    hierarchy,
    navLine,
    reclassifiedTable,
    unobservableTable,
    rollTable,
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
        pct(specialty.dloc) ?? '—',
        money(specialty.value_after_dloc, ctx) ?? '—',
      ],
      ['Less discount for lack of marketability', pct(specialty.dlom) ?? '—', shown(concluded, ctx)],
    ],
    foot: [
      'Concluded value of the transferred interest',
      pct(specialty.effective_discount) ?? '—',
      shown(concluded, ctx),
    ],
  });

  const exclusion = record(specialty.annual_exclusion);
  const taxable = num(specialty.taxable_gift);
  const gift =
    taxable === null
      ? null
      : table({
          head: ['Reportable gift', 'Amount'],
          rows: [
            ['Value of the transferred interest', shown(concluded, ctx)],
            [
              exclusion?.applies === true
                ? `Less annual exclusion (${String(num(exclusion.donees) ?? 1)} donee(s)` +
                  `${exclusion.split_gift === true ? ', split gift' : ''})`
                : 'Annual exclusion — not available for this transfer',
              exclusion?.applies === true ? `−${money(exclusion.applied, ctx) ?? '—'}` : '—',
            ],
            ['Prior taxable gifts', money(specialty.prior_taxable_gifts, ctx) ?? '—'],
          ],
          foot: ['Cumulative taxable gifts', money(specialty.cumulative_taxable_gifts, ctx) ?? '—'],
        });

  const factors = record(specialty.rev_rul_59_60);
  const factorRows = list(factors?.factors)
    .map(record)
    .filter((r): r is Record<string, unknown> => r !== null);
  const checklist =
    factorRows.length > 0
      ? table({
          head: ['Revenue Ruling 59-60 factor', 'Addressed'],
          rows: factorRows.map((f) => [str(f.label ?? f.key), f.addressed === true ? 'Yes' : 'No']),
          foot: [
            'Factors addressed',
            `${String(num(factors?.addressed_count) ?? 0)} of ${String(num(factors?.total_count) ?? factorRows.length)}`,
          ],
        })
      : null;

  return section('Exhibit — Transferred Interest and Discounts', [bridge, gift, checklist]);
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
function ifrs2Exhibit(specialty: Record<string, unknown>, ctx: ExhibitContext): ReportPdfSection | null {
  const totalExpense = num(specialty.total_expense);
  const perAward = num(specialty.fair_value_per_award);
  if (totalExpense === null || perAward === null) return null;

  const measurement = table({
    head: ['Grant-date measurement', 'Value'],
    rows: [
      ['Settlement', label(str(specialty.settlement))],
      ['Vesting condition', label(str(specialty.vesting_condition))],
      ['Model', label(str(specialty.model))],
      ['Fair value per award', shown(perAward, ctx, 4)],
      ['Awards granted', String(num(specialty.options_granted) ?? '—')],
      ['Grant-date fair value', money(specialty.grant_date_fair_value_total, ctx) ?? '—'],
      ['Expected forfeiture rate', pct(specialty.expected_forfeiture_rate) ?? '—'],
      ['Expected to vest', String(num(specialty.expected_to_vest) ?? '—')],
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
          foot: [
            `Attribution — ${label(str(specialty.attribution))}`,
            shown(totalExpense, ctx),
            '',
            '100.0%',
          ],
        })
      : null;

  const trueUp = record(specialty.true_up);
  const trueUpNote = trueUp ? P(str(trueUp.basis, '')) : null;
  const warnings = list(specialty.warnings).filter((w): w is string => typeof w === 'string');
  const warningNote =
    warnings.length > 0 ? warnings.map((w) => P(`<strong>Note.</strong> ${esc(w)}`)).join('') : null;

  return section('Exhibit — Share-Based Payment (IFRS 2)', [
    measurement,
    scheduleTable,
    trueUpNote,
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
