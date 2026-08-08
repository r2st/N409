import { describe, expect, it } from 'vitest';
import {
  buildWorkbookTabs,
  capTableTotals,
  TAB_SOURCE_ENDPOINTS,
  WORKBOOK_TABS,
  WORKBOOK_TAB_KEYS,
  type TabContext,
} from '../../src/domain/workbookTabs.js';
import { computeWorkbook } from '../../src/domain/workbook.js';
import { OVERWRITE_FIELDS_BY_KEY } from '../../src/domain/overwrites.js';
import type { CapTableEntry } from '../../src/domain/capTable.js';

const entry = (over: Partial<CapTableEntry>): CapTableEntry => ({
  security_class: 'Common',
  class_type: 'common',
  shares: 0,
  price_per_share: null,
  invested_amount: null,
  liquidation_multiple: null,
  seniority: null,
  conversion_ratio: null,
  ...over,
});

const baseCtx = (over: Partial<TabContext> = {}): TabContext => ({
  valuation: {
    id: '01J',
    number: 42,
    kind: '409a',
    state: 'review',
    company_name: 'Acme Robotics',
    currency: 'USD',
    service_countries: ['US', 'GB'],
    paid_status: 'paid',
    due_date: null,
    published_at: null,
  },
  profile: null,
  params: null,
  capTable: [],
  sheets: computeWorkbook([]),
  overwrites: new Map(),
  ...over,
});

const fieldOf = (tabs: ReturnType<typeof buildWorkbookTabs>, tab: string, key: string) =>
  tabs
    .find((t) => t.key === tab)!
    .sections.flatMap((s) => s.fields)
    .find((f) => f.key === key)!;

describe('workbook tab model', () => {
  it('defines the four tabs in order', () => {
    expect(WORKBOOK_TABS.map((t) => t.key)).toEqual([...WORKBOOK_TAB_KEYS]);
    expect(WORKBOOK_TAB_KEYS).toEqual(['company_overview', 'captable', 'financials', 'valuation_params']);
  });

  it('gives every field a unique key within its tab', () => {
    for (const tab of WORKBOOK_TABS) {
      const keys = tab.sections.flatMap((s) => s.fields.map((f) => f.key));
      expect(new Set(keys).size, `duplicate field key in ${tab.key}`).toBe(keys.length);
    }
  });

  it('points every editable field at an endpoint, and every derived one at none', () => {
    // A derived cell with an edit target invites a client to try writing it.
    for (const tab of WORKBOOK_TABS) {
      for (const field of tab.sections.flatMap((s) => s.fields)) {
        const endpoint = TAB_SOURCE_ENDPOINTS[field.source];
        if (field.source === 'derived') expect(endpoint, field.key).toBeNull();
        else expect(endpoint, field.key).toBeTruthy();
      }
    }
  });

  it('only claims overwrite keys the registry actually has', () => {
    // The join between the tab vocabulary and the 68-field override registry —
    // a stale key here would silently make a field un-overridable.
    for (const tab of WORKBOOK_TABS) {
      for (const field of tab.sections.flatMap((s) => s.fields)) {
        if (!field.overwriteKey) continue;
        expect(OVERWRITE_FIELDS_BY_KEY.has(field.overwriteKey), field.overwriteKey).toBe(true);
      }
    }
  });

  it('falls back to the valuation company name when no profile exists', () => {
    const tabs = buildWorkbookTabs(baseCtx());
    expect(fieldOf(tabs, 'company_overview', 'legal_name').value).toBe('Acme Robotics');
  });

  it('prefers the profile legal name over the engagement name', () => {
    const tabs = buildWorkbookTabs(
      baseCtx({
        profile: {
          legal_name: 'Acme Robotics, Inc.',
          website: null,
          industry: null,
          founded_on: null,
          employee_count: null,
          revenue_range: null,
          city: 'Austin',
          region: 'TX',
          country: 'US',
        },
      }),
    );
    expect(fieldOf(tabs, 'company_overview', 'legal_name').value).toBe('Acme Robotics, Inc.');
    expect(fieldOf(tabs, 'company_overview', 'headquarters').value).toBe('Austin, TX, US');
  });

  it('leaves headquarters null rather than rendering stray commas', () => {
    const tabs = buildWorkbookTabs(baseCtx());
    expect(fieldOf(tabs, 'company_overview', 'headquarters').value).toBeNull();
  });

  it('reports an override as the value and keeps the stored figure alongside', () => {
    const tabs = buildWorkbookTabs(
      baseCtx({
        params: { ...({} as never), dlom: '0.28' } as never,
        overwrites: new Map([['dlom', 0.35]]),
      }),
    );
    const dlom = fieldOf(tabs, 'valuation_params', 'dlom');
    expect(dlom.value).toBe(0.35);
    expect(dlom.computed_value).toBe(0.28);
    expect(dlom.overridden).toBe(true);
    expect(tabs.find((t) => t.key === 'valuation_params')!.overridden).toBe(1);
  });

  it('leaves computed_value null when nothing is overridden', () => {
    const tabs = buildWorkbookTabs(baseCtx({ params: { ...({} as never), dlom: '0.28' } as never }));
    const dlom = fieldOf(tabs, 'valuation_params', 'dlom');
    expect(dlom.value).toBe(0.28);
    expect(dlom.computed_value).toBeNull();
    expect(dlom.overridden).toBe(false);
  });

  it('normalizes pg numerics so two fields never disagree on their type', () => {
    // `numeric` columns arrive as strings and `integer` ones as numbers, in
    // the same row object.
    const tabs = buildWorkbookTabs(
      baseCtx({ params: { ...({} as never), weight_opm: '0.7', weight_market: 0.3 } as never }),
    );
    expect(fieldOf(tabs, 'valuation_params', 'weight_opm').value).toBe(0.7);
    expect(fieldOf(tabs, 'valuation_params', 'weight_market').value).toBe(0.3);
    expect(fieldOf(tabs, 'valuation_params', 'weight_total').value).toBeCloseTo(1);
  });

  it('reports no weight total at all when none are set', () => {
    // All-null is "not weighted yet", which is not a weighting that sums to 0.
    expect(fieldOf(buildWorkbookTabs(baseCtx()), 'valuation_params', 'weight_total').value).toBeNull();
  });

  it('counts filled fields per tab', () => {
    const empty = buildWorkbookTabs(baseCtx()).find((t) => t.key === 'valuation_params')!;
    expect(empty.total).toBeGreaterThan(0);
    expect(empty.filled).toBe(0);

    const filled = buildWorkbookTabs(
      baseCtx({ params: { ...({} as never), dlom: '0.28', dlom_method: 'finnerty' } as never }),
    ).find((t) => t.key === 'valuation_params')!;
    expect(filled.filled).toBe(2);
  });

  it('reads the latest actuals column out of the computed workbook', () => {
    const tabs = buildWorkbookTabs(
      baseCtx({
        sheets: computeWorkbook([
          { sheet: 'income_statement', row_key: 'revenue', column_key: 'fy_current', value: 5_000_000 },
          { sheet: 'income_statement', row_key: 'cogs', column_key: 'fy_current', value: 2_000_000 },
          { sheet: 'income_statement', row_key: 'revenue', column_key: 'fy_minus_1', value: 4_000_000 },
        ]),
      }),
    );
    expect(fieldOf(tabs, 'financials', 'revenue').value).toBe(5_000_000);
    // Derived rows come through the same grid the workbook itself renders, so
    // the tab cannot disagree with the sheet it summarizes.
    expect(fieldOf(tabs, 'financials', 'gross_profit').value).toBe(3_000_000);
    expect(fieldOf(tabs, 'financials', 'gross_margin').value).toBeCloseTo(0.6);
    expect(fieldOf(tabs, 'financials', 'revenue_growth').value).toBeCloseTo(0.25);
  });

  it('leaves a financial field null rather than reporting a confident zero', () => {
    const tabs = buildWorkbookTabs(baseCtx());
    expect(fieldOf(tabs, 'financials', 'ebitda').value).toBeNull();
    expect(fieldOf(tabs, 'financials', 'gross_margin').value).toBeNull();
  });
});

describe('cap table roll-up', () => {
  it('counts an empty table as empty, not as a division by zero', () => {
    expect(capTableTotals([])).toMatchObject({
      classes: 0,
      fully_diluted_shares: 0,
      liquidation_preference: 0,
    });
  });

  it('sums shares by class and dilutes on an as-converted basis', () => {
    const totals = capTableTotals([
      entry({ security_class: 'Common', class_type: 'common', shares: 8_000_000 }),
      entry({
        security_class: 'Series A',
        class_type: 'preferred',
        shares: 2_000_000,
        invested_amount: 4_000_000,
        liquidation_multiple: 1,
        conversion_ratio: 2,
      }),
      entry({ security_class: 'Options', class_type: 'option', shares: 1_000_000 }),
      entry({ security_class: 'Warrants', class_type: 'warrant', shares: 500_000 }),
    ]);
    expect(totals.common_shares).toBe(8_000_000);
    expect(totals.preferred_shares).toBe(2_000_000);
    // Preferred converts 2:1 → 4,000,000 as-converted.
    expect(totals.fully_diluted_shares).toBe(8_000_000 + 4_000_000 + 1_000_000 + 500_000);
    expect(totals.classes).toBe(4);
  });

  it('treats an unstated conversion ratio as 1:1', () => {
    const totals = capTableTotals([
      entry({ class_type: 'preferred', shares: 1_000_000, conversion_ratio: null }),
    ]);
    expect(totals.fully_diluted_shares).toBe(1_000_000);
  });

  it('treats a zero conversion ratio as a broken row, not as "converts to nothing"', () => {
    // Dropping the class from the denominator would inflate every per-share
    // price computed against it.
    const totals = capTableTotals([entry({ class_type: 'preferred', shares: 1_000_000, conversion_ratio: 0 })]);
    expect(totals.fully_diluted_shares).toBe(1_000_000);
  });

  it('applies the liquidation multiple to invested capital, per class', () => {
    const totals = capTableTotals([
      entry({ class_type: 'preferred', shares: 1, invested_amount: 4_000_000, liquidation_multiple: 1 }),
      entry({ class_type: 'preferred', shares: 1, invested_amount: 6_000_000, liquidation_multiple: 2 }),
    ]);
    expect(totals.invested_capital).toBe(10_000_000);
    expect(totals.liquidation_preference).toBe(4_000_000 + 12_000_000);
  });

  it('defaults a missing multiple to 1x rather than dropping the preference', () => {
    const totals = capTableTotals([
      entry({ class_type: 'preferred', shares: 1, invested_amount: 4_000_000, liquidation_multiple: null }),
    ]);
    expect(totals.liquidation_preference).toBe(4_000_000);
  });

  it('surfaces the roll-up on the cap-table tab', () => {
    const tabs = buildWorkbookTabs(
      baseCtx({
        capTable: [
          entry({ class_type: 'common', shares: 8_000_000 }),
          entry({
            class_type: 'preferred',
            shares: 2_000_000,
            invested_amount: 4_000_000,
            liquidation_multiple: 1,
          }),
        ],
      }),
    );
    expect(fieldOf(tabs, 'captable', 'fully_diluted_shares').value).toBe(10_000_000);
    expect(fieldOf(tabs, 'captable', 'liquidation_preference').value).toBe(4_000_000);
  });
});
