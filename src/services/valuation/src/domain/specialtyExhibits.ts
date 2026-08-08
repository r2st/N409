import type { ReportPdfSection } from '@n409/report/pdf';
import type { CalculationRow } from '../repos/calculations.js';
import { formatCurrency, formatPercent, num } from './reportSummary.js';
import type { ExhibitContext } from './reportExhibits.js';
import type { HmrcForm } from './hmrcForms.js';

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

function esc(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const INT = new Intl.NumberFormat('en-US');

interface Table {
  head: string[];
  rows: string[][];
  foot?: string[];
}

function table({ head, rows, foot }: Table): string {
  const cells = (row: string[], tag: 'th' | 'td', bold = false) =>
    row.map((c) => `<${tag}>${bold ? `<strong>${c}</strong>` : c}</${tag}>`).join('');
  const body = rows.map((r) => `<tr>${cells(r, 'td')}</tr>`).join('');
  const footer = foot ? `<tr>${cells(foot, 'td', true)}</tr>` : '';
  return `<table><thead><tr>${cells(head, 'th')}</tr></thead><tbody>${body}${footer}</tbody></table>`;
}

const P = (text: string) => `<p>${text}</p>`;

function section(heading: string, parts: Array<string | null>): ReportPdfSection | null {
  const html = parts.filter((p): p is string => p !== null && p !== '').join('');
  return html ? { heading, html } : null;
}

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

function pct(value: unknown, digits = 1): string | null {
  const n = num(value);
  return n === null ? null : formatPercent(n, digits);
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
  return section('Exhibit — Section 1202 Test Results', [
    table({ head: ['Requirement', 'Result', 'Basis'], rows }),
    holding
      ? P(
          `Holding period: ${String(num(holding.years_held) ?? '—')} years held against the ` +
            `${String(num(holding.required_years) ?? 5)}-year requirement — ` +
            `${holding.met === true ? 'met' : 'not yet met'} (five-year date ${esc(
              String(holding.five_year_date ?? '—'),
            )}).`,
        )
      : null,
    P(
      `Stock qualification: <strong>${specialty.eligible === true ? 'qualifies' : 'does not qualify'}</strong>; ` +
        `exclusion available now: <strong>${specialty.exclusion_available_now === true ? 'yes' : 'no'}</strong>; ` +
        `exclusion percentage ${pct(specialty.exclusion_percentage, 0) ?? '—'}.`,
    ),
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
  if (num(specialty.consideration_transferred) === null) return null;
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
        ['Consideration transferred', money(specialty.consideration_transferred, ctx) ?? '—'],
        ['Tangible net assets', money(specialty.tangible_net_assets, ctx) ?? '—'],
        ['Identifiable intangibles', money(specialty.total_intangible_value, ctx) ?? '—'],
        ['Identifiable net assets', money(specialty.identifiable_net_assets, ctx) ?? '—'],
      ],
      foot:
        (num(specialty.bargain_purchase_gain) ?? 0) > 0
          ? ['Bargain purchase gain', money(specialty.bargain_purchase_gain, ctx) ?? '—']
          : ['Goodwill (residual)', money(specialty.goodwill, ctx) ?? '—'],
    }),
  ]);
}

// ── Impairment ───────────────────────────────────────────────────────────────

function impairmentExhibit(specialty: Record<string, unknown>, ctx: ExhibitContext): ReportPdfSection | null {
  if (typeof specialty.standard !== 'string' || num(specialty.carrying_amount) === null) return null;
  const rows: string[][] = [['Carrying amount', money(specialty.carrying_amount, ctx) ?? '—']];
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
  if (num(specialty.umv_per_share) === null) return null;
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
        ['Unrestricted market value (UMV) per share', money(specialty.umv_per_share, ctx, 4) ?? '—'],
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
  if (num(specialty.fair_value) === null) return null;
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
    P(`Concluded fair value: <strong>${money(specialty.fair_value, ctx) ?? '—'}</strong>.`),
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
      default:
        return [];
    }
  })();
  return built.filter((s): s is ReportPdfSection => s !== null);
}
