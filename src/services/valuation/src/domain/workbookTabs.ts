import type { CapTableEntry } from './capTable.js';
import type { ComputedSheet } from './workbook.js';
import { OVERWRITE_FIELDS_BY_KEY } from './overwrites.js';

/**
 * The valuation workbook, as the analyst reads it: four tabs — Company
 * Overview, Cap table, Financials, Valuation parameters.
 *
 * This is a *view*, and deliberately owns no storage. The four tabs draw from
 * five different tables (`company_profiles`, `cap_tables`, `valuations`,
 * `valuation_params`, `workbook_cells`) plus the override layer on top, and
 * before this the client had to call five endpoints, know which one owned which
 * field, and reimplement the override precedence to decide what to display. Two
 * clients doing that is two subtly different answers to "what is this
 * valuation's DLOM".
 *
 * So the assembly is here, once, and every field carries three things a form
 * needs and cannot otherwise know: where the value came from, whether an
 * analyst override is currently superseding it, and which endpoint edits it.
 *
 * Nothing here is writable. A tab field naming its own edit endpoint is the
 * whole point — writes keep going to the route that owns the table, with its
 * validation and its audit event, and this view never becomes a second way to
 * mutate a valuation.
 */

export const WORKBOOK_TAB_KEYS = [
  'company_overview',
  'captable',
  'financials',
  'valuation_params',
] as const;
export type WorkbookTabKey = (typeof WORKBOOK_TAB_KEYS)[number];

/** Which table a value is authoritative in — and therefore what edits it. */
export const TAB_SOURCES = [
  'valuation',
  'company_profile',
  'cap_table',
  'valuation_params',
  'workbook',
  /** No stored value: computed from the others on every read. */
  'derived',
] as const;
export type TabSource = (typeof TAB_SOURCES)[number];

/**
 * The endpoint that owns writes for each source, `:id` unsubstituted. `derived`
 * has none — a computed cell is changed by changing its inputs, and offering an
 * edit target for it would invite a client to try.
 */
export const TAB_SOURCE_ENDPOINTS: Record<TabSource, string | null> = {
  valuation: 'PATCH /api/v1/valuations/:id',
  company_profile: 'PUT /api/v1/valuations/:id/company-profile',
  cap_table: 'POST /api/v1/valuations/:id/cap-table',
  valuation_params: 'PATCH /api/v1/valuations/:id/params',
  workbook: 'PATCH /api/v1/valuations/:id/workbook',
  derived: null,
};

export type TabFieldFormat = 'text' | 'number' | 'currency' | 'percent' | 'date' | 'boolean';

export interface TabFieldDef {
  key: string;
  label: string;
  format: TabFieldFormat;
  source: TabSource;
  /**
   * The overrides-registry key that supersedes this field, when one exists.
   * Not every tab field is overridable and not every override appears on a tab;
   * this is the join between the two vocabularies.
   */
  overwriteKey?: string;
  read: (ctx: TabContext) => unknown;
}

export interface TabSectionDef {
  key: string;
  label: string;
  fields: readonly TabFieldDef[];
}

export interface WorkbookTabDef {
  key: WorkbookTabKey;
  label: string;
  description: string;
  sections: readonly TabSectionDef[];
}

// ── Input shapes ──────────────────────────────────────────────────────────────
// Structural, not the repo row types: this module must not drag five repos into
// every consumer, and the fields it reads are a small stable subset of each.

export interface TabValuation {
  id: string;
  number: string | number | null;
  kind: string;
  state: string;
  company_name: string;
  currency: string;
  service_countries: string[] | null;
  paid_status: string;
  due_date: Date | string | null;
  published_at: Date | string | null;
}

export interface TabCompanyProfile {
  legal_name: string | null;
  website: string | null;
  industry: string | null;
  founded_on: string | null;
  employee_count: number | null;
  revenue_range: string | null;
  city: string | null;
  region: string | null;
  country: string | null;
}

export interface TabParams {
  inception_date: string | null;
  fiscal_year_end: string | null;
  exit_timeline: string | null;
  business_overview: string | null;
  revenue_status: string | null;
  last_round_date: string | null;
  runway_months: number | null;
  weight_asset: string | number | null;
  weight_opm: string | number | null;
  weight_income: string | number | null;
  weight_market: string | number | null;
  dloc: string | number | null;
  dlom: string | number | null;
  dlom_method: string | null;
  market_method: string | null;
  market_horizon: string | null;
  asset_method: string | null;
  allocation_method: string | null;
}

export interface TabContext {
  valuation: TabValuation;
  profile: TabCompanyProfile | null;
  params: TabParams | null;
  capTable: readonly CapTableEntry[];
  sheets: readonly ComputedSheet[];
  /** field_key → override value, for the fields an analyst has taken over. */
  overwrites: ReadonlyMap<string, unknown>;
}

// ── Readers ───────────────────────────────────────────────────────────────────

/**
 * Numerics arrive from `pg` as strings for `numeric` columns and as numbers for
 * `integer` ones, in the same object. Anything that reaches a `percent` or
 * `currency` field goes through here so a tab never reports `"0.28"` where the
 * one beside it reports `0.28`.
 */
function num(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function isoDate(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  return value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
}

/** Reads one cell out of the computed workbook grid. */
function cell(sheets: readonly ComputedSheet[], sheet: string, rowKey: string, columnKey: string): number | null {
  const row = sheets.find((s) => s.key === sheet)?.rows.find((r) => r.key === rowKey);
  return row?.cells.find((c) => c.column_key === columnKey)?.value ?? null;
}

/** The most recent completed fiscal year — what "latest actuals" means here. */
const ACTUALS_COLUMN = 'fy_current';

// ── Cap-table roll-up ─────────────────────────────────────────────────────────

export interface CapTableTotals {
  classes: number;
  common_shares: number;
  preferred_shares: number;
  option_shares: number;
  warrant_shares: number;
  /**
   * Every security counted once, on an as-converted basis. Preferred converts
   * at its conversion ratio (1:1 when unstated — the overwhelmingly common
   * case and the only safe default), options and warrants at 1:1. This is the
   * denominator a per-share price is quoted against, so getting the ratio
   * wrong misprices every grant.
   */
  fully_diluted_shares: number;
  /** Aggregate liquidation preference: invested × multiple, per preferred class. */
  liquidation_preference: number;
  invested_capital: number;
}

export function capTableTotals(entries: readonly CapTableEntry[]): CapTableTotals {
  const totals: CapTableTotals = {
    classes: entries.length,
    common_shares: 0,
    preferred_shares: 0,
    option_shares: 0,
    warrant_shares: 0,
    fully_diluted_shares: 0,
    liquidation_preference: 0,
    invested_capital: 0,
  };

  for (const e of entries) {
    const shares = num(e.shares) ?? 0;
    switch (e.class_type) {
      case 'common':
        totals.common_shares += shares;
        totals.fully_diluted_shares += shares;
        break;
      case 'preferred': {
        totals.preferred_shares += shares;
        const ratio = num(e.conversion_ratio);
        // A stored ratio of 0 is a broken row, not "converts to nothing";
        // treating it as 1:1 is wrong in a way that shows up, whereas
        // dropping the class from the denominator inflates every price.
        totals.fully_diluted_shares += shares * (ratio && ratio > 0 ? ratio : 1);
        const invested = num(e.invested_amount) ?? 0;
        totals.invested_capital += invested;
        totals.liquidation_preference += invested * (num(e.liquidation_multiple) ?? 1);
        break;
      }
      case 'option':
        totals.option_shares += shares;
        totals.fully_diluted_shares += shares;
        break;
      case 'warrant':
        totals.warrant_shares += shares;
        totals.fully_diluted_shares += shares;
        break;
    }
  }
  return totals;
}

// ── Tab definitions ───────────────────────────────────────────────────────────

const f = (
  key: string,
  label: string,
  format: TabFieldFormat,
  source: TabSource,
  read: (ctx: TabContext) => unknown,
  overwriteKey?: string,
): TabFieldDef => ({ key, label, format, source, read, ...(overwriteKey ? { overwriteKey } : {}) });

export const WORKBOOK_TABS: readonly WorkbookTabDef[] = [
  {
    key: 'company_overview',
    label: 'Company overview',
    description: 'Who the subject company is and what engagement this is.',
    sections: [
      {
        key: 'identity',
        label: 'Identity',
        fields: [
          f(
            'legal_name',
            'Legal name',
            'text',
            'company_profile',
            (c) => c.profile?.legal_name ?? c.valuation.company_name,
            'company_legal_name',
          ),
          f('website', 'Website', 'text', 'company_profile', (c) => c.profile?.website ?? null),
          f('industry', 'Industry', 'text', 'company_profile', (c) => c.profile?.industry ?? null),
          f('founded_on', 'Founded', 'date', 'company_profile', (c) => c.profile?.founded_on ?? null),
          f(
            'employee_count',
            'Employees',
            'number',
            'company_profile',
            (c) => c.profile?.employee_count ?? null,
          ),
          f('headquarters', 'Headquarters', 'text', 'derived', (c) => {
            const parts = [c.profile?.city, c.profile?.region, c.profile?.country].filter(
              (p): p is string => Boolean(p && p.trim()),
            );
            return parts.length > 0 ? parts.join(', ') : null;
          }),
          f(
            'service_countries',
            'Countries of operation',
            'text',
            'valuation',
            (c) => c.valuation.service_countries?.join(', ') || null,
            'service_countries',
          ),
        ],
      },
      {
        key: 'engagement',
        label: 'Engagement',
        fields: [
          f('valuation_number', 'Valuation number', 'text', 'valuation', (c) =>
            c.valuation.number === null ? null : String(c.valuation.number),
          ),
          f('kind', 'Report type', 'text', 'valuation', (c) => c.valuation.kind),
          f('state', 'Workflow state', 'text', 'valuation', (c) => c.valuation.state),
          f('currency', 'Reporting currency', 'text', 'valuation', (c) => c.valuation.currency, 'currency'),
          f('paid_status', 'Payment', 'text', 'valuation', (c) => c.valuation.paid_status),
          f('due_date', 'Due', 'date', 'valuation', (c) => isoDate(c.valuation.due_date)),
          f('published_at', 'Published', 'date', 'valuation', (c) => isoDate(c.valuation.published_at)),
        ],
      },
      {
        key: 'measurement',
        label: 'Measurement basis',
        fields: [
          f(
            'inception_date',
            'Valuation date',
            'date',
            'valuation_params',
            (c) => c.params?.inception_date ?? null,
            'valuation_date',
          ),
          f(
            'fiscal_year_end',
            'Fiscal year end',
            'date',
            'valuation_params',
            (c) => c.params?.fiscal_year_end ?? null,
            'yearend',
          ),
          f(
            'revenue_status',
            'Revenue status',
            'text',
            'valuation_params',
            (c) => c.params?.revenue_status ?? null,
            'revenue_status',
          ),
          f(
            'last_round_date',
            'Last financing round',
            'date',
            'valuation_params',
            (c) => c.params?.last_round_date ?? null,
          ),
          f(
            'business_overview',
            'Business overview',
            'text',
            'valuation_params',
            (c) => c.params?.business_overview ?? null,
          ),
        ],
      },
    ],
  },
  {
    key: 'captable',
    label: 'Cap table',
    description: 'Outstanding securities and what they are owed before common.',
    sections: [
      {
        key: 'shares',
        label: 'Shares outstanding',
        fields: [
          f('classes', 'Security classes', 'number', 'derived', (c) => capTableTotals(c.capTable).classes),
          f('common_shares', 'Common', 'number', 'derived', (c) => capTableTotals(c.capTable).common_shares),
          f(
            'preferred_shares',
            'Preferred',
            'number',
            'derived',
            (c) => capTableTotals(c.capTable).preferred_shares,
          ),
          f(
            'option_shares',
            'Options',
            'number',
            'derived',
            (c) => capTableTotals(c.capTable).option_shares,
          ),
          f(
            'warrant_shares',
            'Warrants',
            'number',
            'derived',
            (c) => capTableTotals(c.capTable).warrant_shares,
          ),
          f(
            'fully_diluted_shares',
            'Fully diluted',
            'number',
            'derived',
            (c) => capTableTotals(c.capTable).fully_diluted_shares,
          ),
        ],
      },
      {
        key: 'preferences',
        label: 'Preferences',
        fields: [
          f(
            'invested_capital',
            'Invested capital',
            'currency',
            'derived',
            (c) => capTableTotals(c.capTable).invested_capital,
          ),
          f(
            'liquidation_preference',
            'Aggregate liquidation preference',
            'currency',
            'derived',
            (c) => capTableTotals(c.capTable).liquidation_preference,
            'preferred_liquidation',
          ),
        ],
      },
    ],
  },
  {
    key: 'financials',
    label: 'Financials',
    description: 'Latest actuals from the workbook, with the derived margins.',
    sections: [
      {
        key: 'income_statement',
        label: 'Income statement',
        fields: [
          f(
            'revenue',
            'Revenue',
            'currency',
            'workbook',
            (c) => cell(c.sheets, 'income_statement', 'revenue', ACTUALS_COLUMN),
            'last_year_revenue',
          ),
          f('gross_profit', 'Gross profit', 'currency', 'derived', (c) =>
            cell(c.sheets, 'income_statement', 'gross_profit', ACTUALS_COLUMN),
          ),
          f('gross_margin', 'Gross margin', 'percent', 'derived', (c) =>
            cell(c.sheets, 'income_statement', 'gross_margin', ACTUALS_COLUMN),
          ),
          f(
            'operating_expenses',
            'Operating expenses',
            'currency',
            'workbook',
            (c) => cell(c.sheets, 'income_statement', 'operating_expenses', ACTUALS_COLUMN),
            'operating_expenses',
          ),
          f(
            'ebitda',
            'EBITDA',
            'currency',
            'derived',
            (c) => cell(c.sheets, 'income_statement', 'ebitda', ACTUALS_COLUMN),
            'ltm_ebitda',
          ),
          f('ebitda_margin', 'EBITDA margin', 'percent', 'derived', (c) =>
            cell(c.sheets, 'income_statement', 'ebitda_margin', ACTUALS_COLUMN),
          ),
          f(
            'net_income',
            'Net income',
            'currency',
            'derived',
            (c) => cell(c.sheets, 'income_statement', 'net_income', ACTUALS_COLUMN),
            'net_income',
          ),
          f('revenue_growth', 'Revenue growth (YoY)', 'percent', 'derived', (c) =>
            cell(c.sheets, 'income_statement', 'revenue_growth', ACTUALS_COLUMN),
          ),
        ],
      },
      {
        key: 'balance_sheet',
        label: 'Balance sheet',
        fields: [
          f(
            'cash',
            'Cash & equivalents',
            'currency',
            'workbook',
            (c) => cell(c.sheets, 'balance_sheet', 'cash', ACTUALS_COLUMN),
            'cash_balance',
          ),
          f('total_assets', 'Total assets', 'currency', 'derived', (c) =>
            cell(c.sheets, 'balance_sheet', 'total_assets', ACTUALS_COLUMN),
          ),
          f('total_liabilities', 'Total liabilities', 'currency', 'derived', (c) =>
            cell(c.sheets, 'balance_sheet', 'total_liabilities', ACTUALS_COLUMN),
          ),
          f('shareholders_equity', 'Shareholders’ equity', 'currency', 'derived', (c) =>
            cell(c.sheets, 'balance_sheet', 'shareholders_equity', ACTUALS_COLUMN),
          ),
          f(
            'working_capital',
            'Working capital',
            'currency',
            'derived',
            (c) => cell(c.sheets, 'balance_sheet', 'working_capital', ACTUALS_COLUMN),
            'working_capital',
          ),
        ],
      },
      {
        key: 'liquidity',
        label: 'Liquidity',
        fields: [
          f(
            'runway_months',
            'Runway (months)',
            'number',
            'valuation_params',
            (c) => c.params?.runway_months ?? null,
            'runway_months',
          ),
        ],
      },
    ],
  },
  {
    key: 'valuation_params',
    label: 'Valuation parameters',
    description: 'The methodology choices and discounts the engine runs on.',
    sections: [
      {
        key: 'approach_weights',
        label: 'Approach weights',
        fields: [
          f(
            'weight_opm',
            'OPM backsolve',
            'percent',
            'valuation_params',
            (c) => num(c.params?.weight_opm),
            'weight_opm',
          ),
          f(
            'weight_income',
            'Income',
            'percent',
            'valuation_params',
            (c) => num(c.params?.weight_income),
            'weight_income',
          ),
          f(
            'weight_market',
            'Market',
            'percent',
            'valuation_params',
            (c) => num(c.params?.weight_market),
            'weight_market',
          ),
          f(
            'weight_asset',
            'Asset',
            'percent',
            'valuation_params',
            (c) => num(c.params?.weight_asset),
            'weight_asset',
          ),
          f('weight_total', 'Total', 'percent', 'derived', (c) => {
            const parts = [
              num(c.params?.weight_opm),
              num(c.params?.weight_income),
              num(c.params?.weight_market),
              num(c.params?.weight_asset),
            ];
            // All-null means "not set yet", which is not the same as zero and
            // must not render as a weighting that sums to nothing.
            return parts.every((p) => p === null) ? null : parts.reduce<number>((a, b) => a + (b ?? 0), 0);
          }),
        ],
      },
      {
        key: 'methodology',
        label: 'Methodology',
        fields: [
          f(
            'allocation_method',
            'Allocation method',
            'text',
            'valuation_params',
            (c) => c.params?.allocation_method ?? null,
          ),
          f(
            'market_method',
            'Market metric',
            'text',
            'valuation_params',
            (c) => c.params?.market_method ?? null,
          ),
          f(
            'market_horizon',
            'Market horizon',
            'text',
            'valuation_params',
            (c) => c.params?.market_horizon ?? null,
          ),
          f('asset_method', 'Asset method', 'text', 'valuation_params', (c) => c.params?.asset_method ?? null),
          f(
            'exit_timeline',
            'Exit timeline',
            'date',
            'valuation_params',
            (c) => c.params?.exit_timeline ?? null,
            'exit_timeline',
          ),
        ],
      },
      {
        key: 'discounts',
        label: 'Discounts',
        fields: [
          f('dlom', 'DLOM', 'percent', 'valuation_params', (c) => num(c.params?.dlom), 'dlom'),
          f(
            'dlom_method',
            'DLOM method',
            'text',
            'valuation_params',
            (c) => c.params?.dlom_method ?? null,
            'dlom_method',
          ),
          f('dloc', 'DLOC', 'percent', 'valuation_params', (c) => num(c.params?.dloc), 'dloc'),
        ],
      },
    ],
  },
];

export const WORKBOOK_TABS_BY_KEY: ReadonlyMap<WorkbookTabKey, WorkbookTabDef> = new Map(
  WORKBOOK_TABS.map((t) => [t.key, t]),
);

// ── Assembly ──────────────────────────────────────────────────────────────────

export interface TabField {
  key: string;
  label: string;
  format: TabFieldFormat;
  source: TabSource;
  /** Null endpoint = derived; change the inputs, not this. */
  edit_endpoint: string | null;
  /** The value to display: the override when there is one, otherwise stored. */
  value: unknown;
  /** What the field would read without the override — null when there is none. */
  computed_value: unknown;
  overridden: boolean;
  /** The overrides-registry key, when this field can be taken over. */
  overwrite_key: string | null;
}

export interface TabSection {
  key: string;
  label: string;
  fields: TabField[];
}

export interface WorkbookTab {
  key: WorkbookTabKey;
  label: string;
  description: string;
  sections: TabSection[];
  /** Fields with a value, and the total — the tab's own completeness meter. */
  filled: number;
  total: number;
  /** Overrides currently in force on this tab. */
  overridden: number;
}

function isEmpty(value: unknown): boolean {
  return value === null || value === undefined || value === '';
}

/**
 * Builds all four tabs from one snapshot.
 *
 * Override precedence is applied here and nowhere else. A field with an active
 * override reports the override as `value` and the stored figure as
 * `computed_value`, so a form can show both without the client having to fetch
 * the overrides list and re-derive which one wins.
 */
export function buildWorkbookTabs(ctx: TabContext): WorkbookTab[] {
  return WORKBOOK_TABS.map((tabDef) => {
    let filled = 0;
    let total = 0;
    let overridden = 0;

    const sections = tabDef.sections.map((sectionDef) => ({
      key: sectionDef.key,
      label: sectionDef.label,
      fields: sectionDef.fields.map((fieldDef): TabField => {
        const computed = fieldDef.read(ctx);
        // A registry key that no longer exists means the overrides catalogue
        // moved and this tab did not; treat it as un-overridable rather than
        // honouring a value nothing can validate any more.
        const overrideKey =
          fieldDef.overwriteKey && OVERWRITE_FIELDS_BY_KEY.has(fieldDef.overwriteKey)
            ? fieldDef.overwriteKey
            : null;
        const hasOverride = overrideKey !== null && ctx.overwrites.has(overrideKey);
        const value = hasOverride ? ctx.overwrites.get(overrideKey) : computed;

        total += 1;
        if (!isEmpty(value)) filled += 1;
        if (hasOverride) overridden += 1;

        return {
          key: fieldDef.key,
          label: fieldDef.label,
          format: fieldDef.format,
          source: fieldDef.source,
          edit_endpoint: TAB_SOURCE_ENDPOINTS[fieldDef.source],
          value,
          computed_value: hasOverride ? computed : null,
          overridden: hasOverride,
          overwrite_key: overrideKey,
        };
      }),
    }));

    return {
      key: tabDef.key,
      label: tabDef.label,
      description: tabDef.description,
      sections,
      filled,
      total,
      overridden,
    };
  });
}
