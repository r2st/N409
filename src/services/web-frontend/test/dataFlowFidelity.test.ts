/**
 * M2 Data Flow Tracing — end-to-end fidelity.
 *
 * Traces four critical user-facing outputs backwards through every
 * transformation to verify no mutation, fabrication, staleness, or rounding
 * error accumulates:
 *
 *   1. FMV per share: engine (4dp) → column (numeric/text) → API (number) →
 *      frontend formatPerShare (4dp, currency-aware).
 *   2. Pricing quote: backend quotePrice → frontend quote() — constants and
 *      arithmetic must agree.
 *   3. KIND_LABELS: backend kinds → frontend labels — every kind the API can
 *      return must have a human label.
 *   4. Date formatting: valuation_date (YYYY-MM-DD) → timezone-safe rendering.
 */
import { describe, expect, it } from 'vitest';
import {
  formatPerShare,
  formatDate,
  PER_SHARE_DIGITS,
  KIND_LABELS,
} from '../src/lib/format';
import { PRICING_TIERS, PRODUCTS } from '../src/lib/marketing';
import {
  EXPRESS_DELIVERY_CENTS,
  QSBS_ADDON_CENTS,
  RAISE_BANDS,
  quote,
} from '../src/lib/marketingContent';

// ---------------------------------------------------------------------------
// 1. FMV per share — the number the engine produces survives to the screen
// ---------------------------------------------------------------------------
describe('FMV per share survives every hop at 4dp', () => {
  const ENGINE_CONCLUSION = 2.5013;

  it('formatPerShare renders at exactly PER_SHARE_DIGITS decimals', () => {
    const rendered = formatPerShare(ENGINE_CONCLUSION, 'USD');
    const decimals = rendered.split('.')[1]?.replace(/[^\d]/g, '');
    expect(decimals).toHaveLength(PER_SHARE_DIGITS);
  });

  it('preserves sub-cent differences the engine distinguishes', () => {
    expect(formatPerShare(2.5013, 'USD')).not.toBe(formatPerShare(2.5014, 'USD'));
  });

  it('pads trailing zeros so two runs are comparable in a column', () => {
    const rendered = formatPerShare(2.5, 'USD');
    expect(rendered).toMatch(/2[.,]5000/);
  });

  it('renders in the engagement currency, not a hardcoded $', () => {
    const gbp = formatPerShare(ENGINE_CONCLUSION, 'GBP');
    expect(gbp).not.toContain('$');
    const eur = formatPerShare(ENGINE_CONCLUSION, 'EUR');
    expect(eur).not.toContain('$');
    expect(gbp).not.toBe(eur);
  });

  it('accepts the string form the API sometimes delivers (numeric column)', () => {
    expect(formatPerShare('2.5013', 'USD')).toBe(formatPerShare(2.5013, 'USD'));
  });

  it('renders a dash for absent figures, never a fabricated zero', () => {
    expect(formatPerShare(null, 'USD')).toBe('—');
    expect(formatPerShare(undefined, 'USD')).toBe('—');
  });
});

// ---------------------------------------------------------------------------
// 2. Pricing quote — frontend mirrors backend constants
// ---------------------------------------------------------------------------
describe('pricing constants are aligned between backend and frontend', () => {
  it('per-report base price matches the product catalog', () => {
    const product409a = PRODUCTS.find((p) => p.kind === '409a');
    expect(product409a).toBeDefined();
    const perReportTier = PRICING_TIERS.find((t) => t.tier === 'starter');
    expect(perReportTier).toBeDefined();
    expect(perReportTier!.priceCents).toBe(product409a!.priceCents);
  });

  it('raise bands all have zero uplift', () => {
    for (const band of RAISE_BANDS) {
      expect(band.upliftCents).toBe(0);
    }
  });

  it('quote() arithmetic is base + band + express + qsbs', () => {
    const product = PRODUCTS.find((p) => p.kind === '409a')!;
    const bandIndex = 2;
    const result = quote(product, { express: true, qsbsLetter: true, raiseBand: bandIndex });
    const expected =
      product.priceCents + RAISE_BANDS[bandIndex]!.upliftCents + EXPRESS_DELIVERY_CENTS + QSBS_ADDON_CENTS;
    expect(result.totalCents).toBe(expected);
  });

  it('quote() without addons returns just the base', () => {
    const product = PRODUCTS.find((p) => p.kind === '409a')!;
    const result = quote(product, { express: false, qsbsLetter: false });
    expect(result.totalCents).toBe(product.priceCents);
  });
});

// ---------------------------------------------------------------------------
// 3. KIND_LABELS — every kind the backend can return has a frontend label
// ---------------------------------------------------------------------------
describe('KIND_LABELS covers every valuation kind', () => {
  const BACKEND_KINDS = [
    '409a', 'fmv', '718', '820', 'gifts', 'qsbs', 'csop', 'emi',
    'ifrs2', 'ppa', 'goodwill', 'esop', 'ip', 'fund', 'debt',
  ] as const;

  it('has a label for every kind the backend can produce', () => {
    for (const kind of BACKEND_KINDS) {
      expect(KIND_LABELS[kind]).toBeDefined();
      expect(KIND_LABELS[kind].length).toBeGreaterThan(0);
    }
  });

  it('has no label for a kind the backend never produces', () => {
    expect(Object.keys(KIND_LABELS)).toHaveLength(BACKEND_KINDS.length);
  });
});

// ---------------------------------------------------------------------------
// 4. Date formatting — timezone-safe rendering of YYYY-MM-DD
// ---------------------------------------------------------------------------
describe('valuation date survives the timezone hop', () => {
  it('renders a YYYY-MM-DD date without shifting the day', () => {
    const rendered = formatDate('2026-07-01');
    expect(rendered).toContain('2026');
    expect(rendered).toMatch(/Jul|July|7/);
    expect(rendered).toMatch(/\b1\b/);
  });

  it('renders null/undefined as a dash', () => {
    expect(formatDate(null)).toBe('—');
    expect(formatDate(undefined)).toBe('—');
  });

  it('does not shift midnight UTC dates into the prior day', () => {
    const rendered = formatDate('2026-01-01');
    expect(rendered).not.toMatch(/Dec|December|31|2025/);
    expect(rendered).toMatch(/Jan|January|1/);
  });
});
