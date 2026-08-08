import type { ReportPdfSection } from '@n409/report/pdf';
import type { CalculationRow } from '../repos/calculations.js';
import { APPROACH_LABELS, ALLOCATION_LABELS, formatCurrency, formatPercent, num } from './reportSummary.js';
import { buildSpecialtyExhibits } from './specialtyExhibits.js';
import { esc, P, section, table } from './exhibitHtml.js';
import { MULTIPLE_LABELS, type MultipleKey } from './comparables.js';

/**
 * The supporting exhibits of the deliverable — the schedules a reviewer checks
 * the opinion against.
 *
 * The report body is authored: a template skeleton an analyst fills in with
 * prose. Nothing in it was ever *computed*, so a 409A left this service with a
 * conclusion section reading "the fair market value … is $ … per share" and a
 * methodology section describing an OPM in the abstract, while every figure the
 * engine had produced — the cap table it allocated, the four approach values it
 * weighted, the breakpoints it priced, the discounts it applied — existed only
 * in a jsonb column. The summary page (domain/reportSummary.ts) closed part of
 * that for a board member, who wants one number; it does nothing for the
 * auditor or the reviewing appraiser, who wants the workings.
 *
 * These sections are built at render time from the calculation that produced
 * the conclusion, and appended after the authored body. Two consequences are
 * deliberate:
 *
 *   * they cannot go stale against the engine, because they are not stored —
 *     a re-render after a recalculation shows the new figures; and
 *   * they cannot be edited away in the report editor, which is the right
 *     default for a schedule whose whole value is that it says what the model
 *     actually did.
 *
 * Everything degrades: an absent, partial or unfamiliar results shape drops the
 * exhibit rather than throwing inside a PDF render. A report drawn before the
 * engine has run gets no exhibits and is otherwise unchanged.
 */

export interface ExhibitContext {
  currency: string;
  /** Valuation date as the report states it (YYYY-MM-DD), when known. */
  valuationDate?: string | null;
  companyName: string;
  /**
   * The persisted peer set (migration 0119), when the engagement has one.
   * Absent for every engagement nobody has screened, and Exhibit D-1 is then
   * simply not rendered — the report reads exactly as it did before.
   */
  peers?: readonly ExhibitPeer[];
}

/** One row of the peer set, as Exhibit D-1 prints it. */
export interface ExhibitPeer {
  ticker: string | null;
  name: string;
  included: boolean;
  exclude_reason: string | null;
  source: string;
  score: number | null;
  multiples: Partial<Record<MultipleKey, number | null>>;
}

/**
 * Text → HTML text. Class names, scenario names and DLOM method labels all
 * originate with the client, travel through jsonb untouched, and land inside
 * table cells; `sanitizeHtml` is not in this path because these fragments are
 * built rather than saved. See domain/exhibitHtml.ts, which owns `esc`,
 * `table` and `P` for every exhibit module.
 */

const INT = new Intl.NumberFormat('en-US');

function shares(value: number): string {
  return INT.format(Math.round(value));
}

/** `1.2345x` — a multiple, a conversion ratio, a discount factor. */
function ratio(value: number, digits = 4): string {
  return `${value.toFixed(digits)}x`;
}

/** The `{ params, inputs }` document the engine was called with. */
interface Payload {
  params?: Record<string, unknown> | null;
  inputs?: Record<string, unknown> | null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

// ── Exhibit A — capitalization ───────────────────────────────────────────────

/**
 * The cap table the allocation actually ran on.
 *
 * Two shapes reach the engine and both belong here, because which one was used
 * decides how the equity was split. `share_classes` is the full table and drives
 * the breakpoint waterfall; the scalar fields (`shares_outstanding_common` and
 * friends) are the aggregate model, where one preference sits behind one blended
 * class. A reader has to be able to tell which they are looking at.
 */
export function capitalizationExhibit(
  inputs: Record<string, unknown>,
  ctx: ExhibitContext,
): ReportPdfSection | null {
  const classes = list(inputs.share_classes)
    .map(record)
    .filter((c): c is Record<string, unknown> => c !== null);
  const { currency } = ctx;

  if (classes.length > 0) {
    const rows = classes.map((c) => {
      const kind = text(c.kind) ?? '—';
      const count = num(c.shares);
      const preference = num(c.preference);
      const cap = num(c.participation_cap);
      const participation =
        kind !== 'preferred'
          ? '—'
          : c.participating
            ? cap !== null
              ? `Yes, capped at ${formatCurrency(cap, currency, 0)}`
              : 'Yes, uncapped'
            : 'No';
      return [
        esc(text(c.name) ?? '—'),
        kind === 'option' ? 'Options' : kind === 'preferred' ? 'Preferred' : 'Common',
        count === null ? '—' : shares(count),
        kind === 'option'
          ? `Strike ${formatCurrency(num(c.strike) ?? 0, currency, 4)}`
          : preference === null
            ? '—'
            : formatCurrency(preference, currency, 0),
        kind === 'preferred' ? String(c.seniority ?? 1) : '—',
        participation,
      ];
    });
    const totalShares = classes.reduce((sum, c) => sum + (num(c.shares) ?? 0), 0);
    const totalPreference = classes.reduce((sum, c) => sum + (num(c.preference) ?? 0), 0);
    return section('Exhibit A — Capitalization Table', [
      P(
        `The capitalization of ${esc(ctx.companyName)}${ctx.valuationDate ? ` as of ${ctx.valuationDate}` : ''}, ` +
          'as allocated by the option-pricing waterfall. Liquidation preference is the aggregate ' +
          'preference of the class; seniority 1 is the most senior rank, and classes sharing a rank ' +
          'rank pari passu.',
      ),
      table({
        head: ['Class', 'Type', 'Shares', 'Liquidation preference', 'Seniority', 'Participating'],
        rows,
        foot: [
          'Total',
          '',
          shares(totalShares),
          formatCurrency(totalPreference, currency, 0),
          '',
          `${classes.length} classes`,
        ],
      }),
    ]);
  }

  // Aggregate model.
  const common = num(inputs.shares_outstanding_common);
  const preferred = num(inputs.shares_outstanding_preferred);
  const options = num(inputs.options_outstanding);
  const preference = num(inputs.liquidation_preference);
  if (common === null && preferred === null && options === null) return null;

  const rows: string[][] = [];
  if (common !== null) rows.push(['Common stock', shares(common), '—']);
  if (preferred !== null && preferred > 0) {
    rows.push([
      'Preferred stock',
      shares(preferred),
      preference === null ? '—' : formatCurrency(preference, currency, 0),
    ]);
  }
  if (options !== null && options > 0) rows.push(['Options outstanding', shares(options), '—']);
  const total = (common ?? 0) + (preferred ?? 0) + (options ?? 0);
  return section('Exhibit A — Capitalization Table', [
    P(
      'The capitalization is stated on the aggregate basis: a single blended preferred class behind a ' +
        'single liquidation preference, with common and the option pool sharing the residual. No ' +
        'class-by-class cap table was supplied for this valuation.',
    ),
    table({
      head: ['Security', 'Shares', 'Liquidation preference'],
      rows,
      foot: [
        'Fully diluted',
        shares(total),
        preference === null ? '—' : formatCurrency(preference, currency, 0),
      ],
    }),
  ]);
}

// ── Exhibit B — approaches ───────────────────────────────────────────────────

/**
 * Indicated equity value by approach, the weight applied to each, and the
 * weighted conclusion — the reconciliation a reviewer challenges first.
 *
 * PWERM has no approach block: its scenarios *are* the equity value, so the
 * exhibit is absent rather than empty on that path.
 */
export function approachExhibit(
  results: Record<string, unknown>,
  ctx: ExhibitContext,
): ReportPdfSection | null {
  const approaches = record(results.approaches);
  if (!approaches) return null;
  const { currency } = ctx;

  const entries = Object.entries(approaches)
    .map(([key, raw]) => {
      const value = record(raw);
      return {
        key,
        weight: num(value?.weight) ?? 0,
        equity: num(value?.equity_value),
        enterprise: num(value?.enterprise_value),
        method: text(value?.method),
      };
    })
    .filter((e) => e.weight > 0 && e.equity !== null)
    .sort((a, b) => b.weight - a.weight);
  if (entries.length === 0) return null;

  const rows = entries.map((e) => [
    APPROACH_LABELS[e.key] ?? e.key,
    e.method ? esc(e.method.replace(/_/g, ' ')) : '—',
    e.enterprise === null ? '—' : formatCurrency(e.enterprise, currency, 0),
    formatCurrency(e.equity as number, currency, 0),
    formatPercent(e.weight, 0),
    formatCurrency((e.equity as number) * e.weight, currency, 0),
  ]);
  const concluded = num(results.equity_value);
  const weightTotal = entries.reduce((sum, e) => sum + e.weight, 0);

  return section('Exhibit B — Reconciliation of Valuation Approaches', [
    P(
      'Each approach indicates a value for total equity on a marketable, controlling basis. The ' +
        'concluded equity value is the weighted average of the indications, with weights reflecting ' +
        'the relevance and reliability of each approach to this company at this stage.',
    ),
    table({
      head: ['Approach', 'Method', 'Enterprise value', 'Equity value', 'Weight', 'Weighted'],
      rows,
      foot: [
        'Concluded equity value',
        '',
        '',
        '',
        formatPercent(weightTotal, 0),
        concluded === null ? '—' : formatCurrency(concluded, currency, 0),
      ],
    }),
  ]);
}

// ── Exhibit C — income approach ──────────────────────────────────────────────

export function incomeExhibit(
  inputs: Record<string, unknown>,
  results: Record<string, unknown>,
  ctx: ExhibitContext,
): ReportPdfSection | null {
  const approach = record(record(results.approaches)?.income);
  if (!approach) return null;
  const income = record(inputs.income) ?? {};
  const { currency } = ctx;

  const flows = list(income.free_cash_flows)
    .map(num)
    .filter((v): v is number => v !== null);
  const revenues = list(income.revenues)
    .map(num)
    .filter((v): v is number => v !== null);
  const rate = num(income.discount_rate);
  const growth = num(income.terminal_growth) ?? 0;

  const schedule =
    flows.length > 0
      ? table({
          head: [
            'Forecast year',
            ...(revenues.length === flows.length ? ['Revenue'] : []),
            'Free cash flow',
            'Discount factor',
            'Present value',
          ],
          rows: flows.map((fcf, i) => {
            const factor = rate === null ? null : Math.pow(1 + rate, i + 1);
            return [
              `Year ${i + 1}`,
              ...(revenues.length === flows.length
                ? [formatCurrency(revenues[i] as number, currency, 0)]
                : []),
              formatCurrency(fcf, currency, 0),
              factor === null ? '—' : ratio(1 / factor),
              factor === null ? '—' : formatCurrency(fcf / factor, currency, 0),
            ];
          }),
          foot: [
            'Present value of the explicit forecast',
            ...(revenues.length === flows.length ? [''] : []),
            '',
            '',
            formatCurrency(num(approach.pv_explicit) ?? 0, currency, 0),
          ],
        })
      : null;

  const bridge: string[][] = [];
  const push = (label: string, value: number | null, note = '') => {
    if (value !== null) bridge.push([label, formatCurrency(value, currency, 0), note]);
  };
  if (rate !== null)
    bridge.push(['Discount rate', formatPercent(rate, 2), 'Weighted average cost of capital']);
  bridge.push(['Terminal growth rate', formatPercent(growth, 2), 'Perpetual growth beyond the forecast']);
  push('Present value of the explicit forecast', num(approach.pv_explicit));
  push(
    'Present value of the terminal value',
    num(approach.pv_terminal),
    'Gordon growth on the final-year flow',
  );
  push('Indicated enterprise value', num(approach.enterprise_value));
  push('Add: cash and equivalents', num(inputs.cash));
  push('Less: interest-bearing debt', num(inputs.debt) === null ? null : -(num(inputs.debt) as number));

  return section('Exhibit C — Income Approach (Discounted Cash Flow)', [
    P(
      'The income approach discounts the projected free cash flows of the business to present value at ' +
        'a rate reflecting the risk of achieving them, and adds the present value of a terminal value ' +
        'representing the cash flows beyond the forecast period. The result is an enterprise value, ' +
        'bridged to equity by adding cash and deducting debt.',
    ),
    schedule,
    table({
      head: ['Component', 'Amount', 'Basis'],
      rows: bridge,
      foot: [
        'Indicated equity value — income approach',
        formatCurrency(num(approach.equity_value) ?? 0, currency, 0),
        '',
      ],
    }),
  ]);
}

// ── Exhibit D — market approach ──────────────────────────────────────────────

export function marketExhibit(
  inputs: Record<string, unknown>,
  results: Record<string, unknown>,
  ctx: ExhibitContext,
): ReportPdfSection | null {
  const approach = record(record(results.approaches)?.market);
  if (!approach) return null;
  const { currency } = ctx;

  const multiples = list(approach.multiples)
    .map(num)
    .filter((v): v is number => v !== null);
  const selected = num(approach.selected_multiple);
  const metric = num(approach.metric);

  const observed =
    multiples.length > 0
      ? table({
          head: ['Guideline observation', 'Multiple'],
          rows: multiples
            .slice()
            .sort((a, b) => a - b)
            .map((m, i) => [`Comparable ${i + 1}`, ratio(m, 2)]),
          foot: ['Selected multiple (median)', selected === null ? '—' : ratio(selected, 2)],
        })
      : null;

  const bridge: string[][] = [];
  if (metric !== null)
    bridge.push(['Company metric', formatCurrency(metric, currency, 0), 'As selected for the analysis']);
  if (selected !== null)
    bridge.push(['Selected multiple', ratio(selected, 2), 'Median of the guideline set']);
  const ev = num(approach.enterprise_value);
  if (ev !== null)
    bridge.push(['Indicated enterprise value', formatCurrency(ev, currency, 0), 'Metric × multiple']);
  const cash = num(inputs.cash);
  const debt = num(inputs.debt);
  if (cash !== null) bridge.push(['Add: cash and equivalents', formatCurrency(cash, currency, 0), '']);
  if (debt !== null) bridge.push(['Less: interest-bearing debt', formatCurrency(-debt, currency, 0), '']);

  return section('Exhibit D — Market Approach (Guideline Multiples)', [
    P(
      'The market approach applies valuation multiples observed for comparable companies and ' +
        'transactions to the corresponding metric of the subject company. The median of the guideline ' +
        'set is selected, which limits the influence of any single outlying observation.',
    ),
    observed,
    table({
      head: ['Component', 'Amount', 'Basis'],
      rows: bridge,
      foot: [
        'Indicated equity value — market approach',
        formatCurrency(num(approach.equity_value) ?? 0, currency, 0),
        '',
      ],
    }),
  ]);
}

// ── Exhibit D-1 — the guideline company set ──────────────────────────────────

/**
 * The peer set behind Exhibit D, named.
 *
 * Exhibit D prints the multiples as "Comparable 1 … Comparable n", which is
 * every figure a reviewer needs to re-derive the value and none of what they
 * need to challenge it. The question a market approach is challenged on is not
 * "what was the median" — it is "which companies, and why not the ones you left
 * out". Both halves are on this schedule, and the excluded half carries its
 * reason, which is the whole point of storing the rows.
 *
 * Numbered D-1 rather than taking a letter of its own: the eight lettered
 * exhibits are cited by letter in reports already issued, and renumbering them
 * to insert a schedule would make every one of those citations point one
 * exhibit to the left.
 */
export function peerSetExhibit(
  peers: readonly ExhibitPeer[] | undefined,
  results: Record<string, unknown>,
): ReportPdfSection | null {
  if (!peers || peers.length === 0) return null;
  // No market approach in the run means no schedule: a peer set an analyst
  // screened but did not weight into the conclusion is working material, and
  // printing it as a supporting exhibit overstates its role in the opinion.
  if (!record(record(results.approaches)?.market)) return null;

  const included = peers.filter((p) => p.included);
  const excluded = peers.filter((p) => !p.included);
  // Which of the four quotients to print: whichever the included set actually
  // has. A column of dashes tells a reader nothing about the comps.
  const columns = (Object.keys(MULTIPLE_LABELS) as MultipleKey[]).filter((key) =>
    included.some((p) => typeof p.multiples[key] === 'number'),
  );

  const label = (p: ExhibitPeer) => (p.ticker ? `${esc(p.name)} (${esc(p.ticker)})` : esc(p.name));
  const cell = (value: number | null | undefined) => (typeof value === 'number' ? ratio(value, 2) : '—');

  const selected =
    included.length > 0
      ? table({
          head: ['Guideline company', ...columns.map((k) => MULTIPLE_LABELS[k]), 'Screen score'],
          rows: included.map((p) => [
            label(p),
            ...columns.map((k) => cell(p.multiples[k])),
            p.score === null ? '—' : p.score.toFixed(2),
          ]),
        })
      : null;

  const rejected =
    excluded.length > 0
      ? table({
          head: ['Company considered', 'Basis for exclusion'],
          rows: excluded.map((p) => [label(p), esc(p.exclude_reason ?? 'Not stated')]),
        })
      : null;

  return section('Exhibit D-1 — Guideline Company Set', [
    P(
      'The guideline companies below were screened on industry classification, scale, growth and ' +
        'margin profile. The multiples in Exhibit D are struck from the companies retained; the ' +
        'companies considered and set aside are listed with the basis on which each was excluded.',
    ),
    selected,
    excluded.length > 0
      ? P('The following companies were considered and are not reflected in the concluded multiples.')
      : null,
    rejected,
  ]);
}

// ── Exhibit E — asset approach ───────────────────────────────────────────────

export function assetExhibit(results: Record<string, unknown>, ctx: ExhibitContext): ReportPdfSection | null {
  const approach = record(record(results.approaches)?.asset);
  if (!approach) return null;
  const { currency } = ctx;
  const method = text(approach.method);

  const rows: string[][] = [];
  const assets = num(approach.total_assets);
  const liabilities = num(approach.total_liabilities);
  if (assets !== null) rows.push(['Total assets', formatCurrency(assets, currency, 0)]);
  if (liabilities !== null) rows.push(['Less: total liabilities', formatCurrency(-liabilities, currency, 0)]);
  if (rows.length === 0) {
    rows.push([
      'Cost to replicate the business',
      formatCurrency(num(approach.equity_value) ?? 0, currency, 0),
    ]);
  }

  return section('Exhibit E — Asset Approach', [
    P(
      method === 'cost_to_replicate'
        ? 'The asset approach is applied on a cost-to-replicate basis: the cost a market participant ' +
            'would incur to reproduce the assembled assets of the business.'
        : 'The asset approach is applied on a net-asset-value basis: the book value of total assets ' +
            'less total liabilities as of the valuation date.',
    ),
    table({
      head: ['Component', 'Amount'],
      rows,
      foot: [
        'Indicated equity value — asset approach',
        formatCurrency(num(approach.equity_value) ?? 0, currency, 0),
      ],
    }),
  ]);
}

// ── Exhibit F — allocation ───────────────────────────────────────────────────

function participantSummary(participants: Record<string, unknown>): string {
  return (
    Object.entries(participants)
      .map(([name, share]) => ({ name, share: num(share) ?? 0 }))
      .filter((p) => p.share > 0)
      .sort((a, b) => b.share - a.share)
      .map((p) => `${esc(p.name)} ${formatPercent(p.share, 1)}`)
      .join(' · ') || '—'
  );
}

/**
 * How the concluded equity value was split across the cap table.
 *
 * The breakpoint schedule is the exhibit an auditor asks for by name and the
 * one the engine has always computed and never shown: `allocation.breakpoints`
 * is a list of exit-value ranges, who shares each one and what the tranche is
 * worth under the option-pricing model. Everything else here is the same
 * allocation described at whatever resolution the method used supports — the
 * aggregate branches have a single breakpoint and no schedule to print.
 */
export function allocationExhibit(
  results: Record<string, unknown>,
  ctx: ExhibitContext,
): ReportPdfSection | null {
  const allocation = record(results.allocation);
  if (!allocation) return null;
  const { currency } = ctx;
  const methodKey = String(results.allocation_method ?? allocation.method ?? '').toLowerCase();
  const label =
    ALLOCATION_LABELS[methodKey] ?? ALLOCATION_LABELS[String(allocation.method ?? '')] ?? methodKey;

  const assumptions = record(results.assumptions);
  const inputRows: string[][] = [];
  const volatility = num(assumptions?.volatility);
  const rf = num(assumptions?.risk_free_rate);
  const t = num(assumptions?.time_to_exit_years) ?? num(assumptions?.expected_time_to_exit_years);
  if (volatility !== null) inputRows.push(['Expected volatility (σ)', formatPercent(volatility, 1)]);
  if (t !== null) inputRows.push(['Expected time to liquidity (T)', `${t.toFixed(2)} years`]);
  if (rf !== null) inputRows.push(['Risk-free rate (r)', formatPercent(rf, 2)]);
  const equity = num(results.equity_value);
  if (equity !== null) inputRows.push(['Equity value allocated', formatCurrency(equity, currency, 0)]);

  const breakpoints = list(allocation.breakpoints)
    .map(record)
    .filter((b): b is Record<string, unknown> => b !== null);
  const schedule =
    breakpoints.length > 0
      ? table({
          head: ['Tranche', 'From', 'To', 'Value', 'Participants'],
          rows: breakpoints.map((b, i) => {
            const from = num(b.from);
            const to = num(b.to);
            return [
              String(i + 1),
              from === null ? '—' : formatCurrency(from, currency, 0),
              to === null ? 'and above' : formatCurrency(to, currency, 0),
              formatCurrency(num(b.value) ?? 0, currency, 0),
              participantSummary(record(b.participants) ?? {}),
            ];
          }),
        })
      : null;

  const classes = record(allocation.classes);
  const byClass = classes
    ? table({
        head: ['Class', 'Type', 'Shares', 'Allocated value', 'Value per share'],
        rows: Object.entries(classes).map(([name, raw]) => {
          const c = record(raw) ?? {};
          const count = num(c.shares);
          const value = num(c.value) ?? num(c.present_value);
          return [
            esc(name),
            text(c.kind) === 'option' ? 'Options' : text(c.kind) === 'preferred' ? 'Preferred' : 'Common',
            count === null ? '—' : shares(count),
            value === null ? '—' : formatCurrency(value, currency, 0),
            formatCurrency(num(c.per_share) ?? num(c.fmv_per_share) ?? 0, currency, 4),
          ];
        }),
      })
    : null;

  // The aggregate branches have no schedule; state the single breakpoint they
  // do have rather than leaving the exhibit with only a prose paragraph.
  const aggregate: string[][] = [];
  const breakpoint = num(allocation.breakpoint);
  if (breakpoint !== null)
    aggregate.push([
      'Breakpoint (aggregate liquidation preference)',
      formatCurrency(breakpoint, currency, 0),
    ]);
  const upside = num(allocation.upside_after_preference);
  if (upside !== null)
    aggregate.push(['Call value above the breakpoint', formatCurrency(upside, currency, 0)]);
  const fraction = num(allocation.common_fraction);
  if (fraction !== null) aggregate.push(["Common's share of the residual", formatPercent(fraction, 2)]);

  return section('Exhibit F — Allocation of Equity Value', [
    P(
      `Equity value is allocated across the capital structure using the <strong>${esc(label)}</strong>. ` +
        (breakpoints.length > 0
          ? 'Under the breakpoint method the payoff of each class is piecewise linear in exit value, so ' +
            'its expected value is the sum of Black-Scholes call spreads between consecutive ' +
            'breakpoints. The schedule below lists each tranche, its value, and the classes sharing it.'
          : 'The inputs to the allocation and the resulting value of each class are set out below.'),
    ),
    inputRows.length > 0 ? table({ head: ['Allocation input', 'Value'], rows: inputRows }) : null,
    aggregate.length > 0 ? table({ head: ['Component', 'Value'], rows: aggregate }) : null,
    schedule,
    byClass,
  ]);
}

// ── Exhibit G — PWERM scenarios ──────────────────────────────────────────────

export function pwermExhibit(results: Record<string, unknown>, ctx: ExhibitContext): ReportPdfSection | null {
  const allocation = record(results.allocation);
  const scenarios = list(allocation?.scenarios)
    .map(record)
    .filter((s): s is Record<string, unknown> => s !== null);
  if (scenarios.length === 0) return null;
  const { currency } = ctx;

  return section('Exhibit G — Probability-Weighted Expected Return Scenarios', [
    P(
      'Under PWERM the value of common stock is the probability-weighted present value of its proceeds ' +
        'in each modelled future outcome. Each scenario is allocated through the liquidation waterfall ' +
        'at its own exit value, discounted at its own rate over its own horizon, and weighted by its ' +
        'probability of occurring.',
    ),
    table({
      head: ['Scenario', 'Type', 'Probability', 'Exit equity value', 'Years', 'PV to common'],
      rows: scenarios.map((s) => [
        esc(text(s.name) ?? '—'),
        esc((text(s.type) ?? '—').replace(/_/g, ' ')),
        formatPercent(num(s.probability) ?? 0, 1),
        formatCurrency(num(s.exit_equity_value) ?? 0, currency, 0),
        (num(s.time_to_exit_years) ?? 0).toFixed(2),
        formatCurrency(num(s.common_present_value) ?? 0, currency, 0),
      ]),
      foot: [
        'Probability-weighted',
        '',
        formatPercent(
          scenarios.reduce((sum, s) => sum + (num(s.probability) ?? 0), 0),
          0,
        ),
        formatCurrency(num(results.equity_value) ?? 0, currency, 0),
        `${num(record(results.assumptions)?.expected_time_to_exit_years)?.toFixed(2) ?? '—'}`,
        formatCurrency(num(results.common_equity_value) ?? 0, currency, 0),
      ],
    }),
  ]);
}

// ── Exhibit H — discounts and conclusion ─────────────────────────────────────

const DLOM_BASIS: Record<string, string> = {
  chaffee: 'Chaffee protective-put model',
  finnerty: 'Finnerty average-strike put model',
  qualitative: 'Qualitative — analyst judgement',
};

/**
 * The last three lines of the opinion, as arithmetic: the allocated common
 * value per share, the two discounts, and the concluded fair market value.
 *
 * `compute` guarantees `fmv = base × (1 − DLOC) × (1 − DLOM)`, so the exhibit
 * closes exactly. The base is taken from the allocation when it reports one and
 * inverted from the identity otherwise, which is what `marketableValuePerShare`
 * does for the summary chart — the two must not be able to disagree, so the
 * table is built the same way.
 */
export function discountExhibit(
  results: Record<string, unknown>,
  ctx: ExhibitContext,
): ReportPdfSection | null {
  const fmv = num(results.fmv_per_share);
  if (fmv === null) return null;
  const { currency } = ctx;
  const discounts = record(results.discounts) ?? {};
  const dloc = num(discounts.dloc) ?? 0;
  const dlom = num(discounts.dlom) ?? 0;

  const direct = num(record(results.allocation)?.common_per_share);
  const factor = (1 - dloc) * (1 - dlom);
  const base = direct !== null && direct > 0 ? direct : factor > 0 ? fmv / factor : null;
  if (base === null) return null;

  const afterDloc = base * (1 - dloc);
  const method = text(discounts.dlom_method);
  const rows: string[][] = [
    [
      'Marketable, controlling value per common share',
      formatCurrency(base, currency, 4),
      'Per the allocation above',
    ],
    [
      `Less: discount for lack of control — ${formatPercent(dloc)}`,
      `(${formatCurrency(base - afterDloc, currency, 4)})`,
      'A minority holder cannot compel a liquidity event or direct the business',
    ],
    ['Marketable, minority value per common share', formatCurrency(afterDloc, currency, 4), ''],
    [
      `Less: discount for lack of marketability — ${formatPercent(dlom)}`,
      `(${formatCurrency(afterDloc - fmv, currency, 4)})`,
      method ? (DLOM_BASIS[method] ?? esc(method)) : 'No active market exists for the shares',
    ],
  ];

  return section('Exhibit H — Discounts and Concluded Value', [
    P(
      'The allocation produces the value of a common share on a marketable, controlling basis. Section ' +
        '409A requires the fair market value of a minority interest in shares for which no market ' +
        'exists, so a discount for lack of control and a discount for lack of marketability are ' +
        'applied in turn. The discounts are multiplicative, in the order shown.',
    ),
    table({
      head: ['Step', 'Per share', 'Basis'],
      rows,
      foot: [
        `Concluded fair market value per common share${ctx.valuationDate ? ` as of ${ctx.valuationDate}` : ''}`,
        formatCurrency(fmv, currency, 4),
        'Non-marketable, minority basis',
      ],
    }),
  ]);
}

// ── assembly ─────────────────────────────────────────────────────────────────

/**
 * Every exhibit the calculation supports, in the order a reader works through
 * them: what was owned, what the business was worth, how each approach reached
 * that, how the value was split, and how the split became the conclusion.
 *
 * Returns an empty list — not a placeholder section — when there is no
 * successful calculation. A report drafted before the engine has run renders
 * exactly as it did before this module existed.
 */
export function buildExhibits(calculation: CalculationRow | null, ctx: ExhibitContext): ReportPdfSection[] {
  if (!calculation || calculation.status !== 'succeeded' || !calculation.results) return [];
  // A specialty run (routes/specialty.ts) records its engine's result under
  // results.specialty — none of the 409A schedules below can read it, and its
  // own schedules live in domain/specialtyExhibits.ts.
  if (calculation.results.specialty && typeof calculation.results.specialty === 'object') {
    return buildSpecialtyExhibits(calculation, ctx);
  }
  const results = calculation.results;
  const payload = (calculation.inputs ?? {}) as Payload;
  const inputs = record(payload.inputs) ?? {};

  return [
    capitalizationExhibit(inputs, ctx),
    approachExhibit(results, ctx),
    incomeExhibit(inputs, results, ctx),
    marketExhibit(inputs, results, ctx),
    // Immediately after D, because it is D's supporting detail.
    peerSetExhibit(ctx.peers, results),
    assetExhibit(results, ctx),
    allocationExhibit(results, ctx),
    pwermExhibit(results, ctx),
    discountExhibit(results, ctx),
  ].filter((s): s is ReportPdfSection => s !== null);
}
