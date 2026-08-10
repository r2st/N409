import { describe, expect, it } from 'vitest';
import { projectionExhibit, type ExhibitContext } from '../../src/domain/reportExhibits.js';
import { ALLOWED_TAGS, sanitizeHtml } from '../../src/domain/report.js';
import type { ProjectionRow, ProjectionYear } from '../../src/repos/projections.js';

/**
 * Exhibit C-1 — the build behind the cash flows Exhibit C discounts.
 *
 * The exhibit exists to answer one question a reviewing appraiser asks first:
 * what revenue, at what margin, produced the stream. So the tests are about the
 * claims it makes rather than its layout — that it prints only where a forecast
 * was actually run, that the arithmetic to free cash flow is visible, and above
 * all that it never lets a forecast nobody adopted sit under a heading in a
 * signed report as though the conclusion rested on it.
 */

const CTX: ExhibitContext = { currency: 'USD', companyName: 'Northwind Robotics, Inc.' };

const year = (n: number, revenue: number, fcff: number): ProjectionYear => ({
  year: n,
  revenue,
  cogs: revenue * 0.4,
  opex: revenue * 0.3,
  ebitda: revenue * 0.3,
  da: revenue * 0.05,
  ebit: revenue * 0.25,
  nopat: revenue * 0.1975,
  capex: revenue * 0.06,
  delta_nwc: 250_000,
  fcff,
});

const YEARS = [year(1, 10_000_000, 1_500_000), year(2, 13_000_000, 2_100_000)];

const run = (patch: Partial<ProjectionRow> = {}): ProjectionRow => ({
  id: '01J0PROJECTION000000000001',
  valuation_id: '01J0VALUATION00000000001',
  method: 'growth',
  years: 2,
  tax_rate: 0.21,
  inputs: {
    method: 'growth',
    years: 2,
    base_revenue: 8_000_000,
    revenue_growth: 0.25,
    cogs_pct: 0.4,
    opex_pct: 0.3,
    tax_rate: 0.21,
  },
  projections: YEARS,
  free_cash_flows: [1_500_000, 2_100_000],
  terminal_method: null,
  terminal_value: null,
  applied_at: new Date('2026-07-01T00:00:00Z'),
  applied_by: null,
  created_by: null,
  created_at: new Date('2026-06-30T00:00:00Z'),
  ...patch,
});

/** The engine inputs as the calculation stored them — the stream C discounts. */
const discounting = (flows: number[]) => ({ income: { free_cash_flows: flows } });

const ADOPTED = discounting([1_500_000, 2_100_000]);

describe('projectionExhibit', () => {
  it('is not rendered for an engagement whose cash flows were typed', () => {
    expect(projectionExhibit(ADOPTED, CTX)).toBeNull();
    expect(projectionExhibit(ADOPTED, { ...CTX, projection: null })).toBeNull();
    // A run with no per-year build is a stream with no build behind it, which
    // is the state the exhibit exists to replace — not one to print.
    expect(projectionExhibit(ADOPTED, { ...CTX, projection: run({ projections: [] }) })).toBeNull();
  });

  it('prints the assumptions and the fall from revenue to free cash flow', () => {
    const s = projectionExhibit(ADOPTED, { ...CTX, projection: run() });
    expect(s?.heading).toBe('Exhibit C-1 — Basis of the Cash-Flow Forecast');
    // The assumptions are the disclosure: the stream cannot be checked without
    // them, and each is stated as it was struck.
    expect(s?.html).toContain('$8,000,000');
    expect(s?.html).toContain('25.0%');
    expect(s?.html).toContain('Cost of goods sold, as a share of revenue');
    expect(s?.html).toContain('Tax rate applied to EBIT');
    // And the arithmetic is left visible rather than summarised.
    expect(s?.html).toContain('EBITDA');
    expect(s?.html).toContain('NOPAT');
    expect(s?.html).toContain('Less: increase in net working capital');
    expect(s?.html).toContain('Free cash flow to the firm');
    expect(s?.html).toContain('$1,500,000');
    expect(s?.html).toContain('$2,100,000');
  });

  it('states a per-year growth vector as its range rather than repeating the columns', () => {
    const s = projectionExhibit(ADOPTED, {
      ...CTX,
      projection: run({ inputs: { base_revenue: 8_000_000, revenue_growth: [0.4, 0.25] } }),
    });
    expect(s?.html).toContain('25.0% to 40.0%, by year');
  });

  it('prints no assumption table entries a bottom-up forecast never made', () => {
    const s = projectionExhibit(ADOPTED, {
      ...CTX,
      projection: run({ method: 'driver', inputs: { method: 'driver', revenue: [10_000_000, 13_000_000] } }),
    });
    expect(s?.html).toContain('Bottom-up');
    // A ratio is a top-down assumption. Printing one against a forecast entered
    // line by line states an assumption nobody made.
    expect(s?.html).not.toContain('as a share of revenue');
  });

  it('says in terms when the forecast was never adopted', () => {
    const s = projectionExhibit(discounting([900_000, 950_000]), {
      ...CTX,
      projection: run({ applied_at: null }),
    });
    expect(s?.html).toContain('not been adopted');
  });

  it('says so when the model was amended after the forecast was adopted', () => {
    // Adopted, and the stream the calculation ran on is no longer this one —
    // `applied_at` alone would have called this the source of the figures.
    const s = projectionExhibit(discounting([900_000, 950_000]), { ...CTX, projection: run() });
    expect(s?.html).toContain('differ from this forecast');
    expect(s?.html).not.toContain('not been adopted');
  });

  it('makes no adoption claim when the calculation ran on exactly this stream', () => {
    const s = projectionExhibit(ADOPTED, { ...CTX, projection: run() });
    expect(s?.html).not.toContain('not been adopted');
    expect(s?.html).not.toContain('differ from this forecast');
  });

  it('records a terminal value without letting it read as the conclusion’s', () => {
    const s = projectionExhibit(ADOPTED, {
      ...CTX,
      projection: run({ terminal_method: 'gordon', terminal_value: 24_000_000 }),
    });
    expect(s?.html).toContain('$24,000,000');
    // The DCF strikes its own; counting both would carry it in twice.
    expect(s?.html).toContain('not');
    expect(s?.html).toContain('twice');
  });

  it('says what it dropped when the forecast is wider than the page', () => {
    const long = Array.from({ length: 20 }, (_, i) => year(i + 1, 1_000_000 * (i + 1), 100_000 * (i + 1)));
    const s = projectionExhibit(discounting(long.map((y) => y.fcff)), {
      ...CTX,
      projection: run({ years: 20, projections: long, free_cash_flows: long.map((y) => y.fcff) }),
    });
    expect(s?.html).toContain('Year 12');
    expect(s?.html).not.toContain('Year 13');
    // A silent truncation reads as a complete forecast; this one says so.
    expect(s?.html).toContain('runs to 20 years');
  });

  it('survives the report sanitizer with its tables intact', () => {
    const html = projectionExhibit(ADOPTED, { ...CTX, projection: run() })?.html ?? '';
    const clean = sanitizeHtml(html, ALLOWED_TAGS);
    expect(clean).toContain('<table>');
    expect(clean).toContain('Free cash flow to the firm');
  });
});
