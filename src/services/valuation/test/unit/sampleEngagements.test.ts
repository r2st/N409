import { describe, expect, it } from 'vitest';
import { SAMPLE_ENGAGEMENTS, asc718SectionHtml } from '../../src/domain/sampleEngagements.js';
import { sanitizeHtml, templateForKind } from '../../src/domain/report.js';
import { reportFigures } from '../../src/domain/reportFigures.js';
import { asc718Portfolio } from '../../src/domain/asc718.js';
import type { CalculationRow } from '../../src/repos/calculations.js';

/**
 * The samples are seeded onto a production host by `tools/seed-samples.mjs`,
 * which drives them through the live API. Everything that can be known about
 * them before that point should fail here instead — a sample that has drifted
 * from the schema is otherwise discovered halfway through a run that has
 * already published two engagements and created a user.
 *
 * These assert the things the seeder cannot: that a narrative names chapters
 * the 409A skeleton actually has, that its placeholders are ones the renderer
 * resolves, and that nothing carries the ellipsis the publish gate reads as
 * "not written yet".
 */

const SECTION_KEYS = new Set(templateForKind('409a').sections.map((s) => s.key));

/** The placeholders the renderer can resolve, taken from a complete calculation. */
const RESOLVABLE = new Set(
  Object.keys(
    reportFigures(
      {
        status: 'succeeded',
        results: {
          equity_value: 42_664_609.74,
          fmv_per_share: 1.4947,
          common_equity_value: 19_900_044.87,
          fully_diluted_common: 9_250_000,
          allocation: { common_per_share: 2.151356 },
          assumptions: { time_to_exit_years: 4, risk_free_rate: 0.0421, volatility: 0.62 },
          discounts: { dloc: 0.08, dlom: 0.2448, dlom_method: 'finnerty' },
          market_movement: { factor: 0.899, index_return: -0.0878, index_name: 'S&P Software' },
        },
      } as unknown as CalculationRow,
      'USD',
    ),
  ),
);

const FISCAL_COLUMNS = new Set(['fy_minus_2', 'fy_minus_1', 'fy_current', 'fy_plus_1', 'fy_plus_2', 'value']);

describe('sample engagements', () => {
  it('covers the three engagement shapes the seeder advertises', () => {
    expect(SAMPLE_ENGAGEMENTS.map((s) => s.key)).toEqual(['saas', 'biotech', 'manufacturing']);
  });

  it('has a unique key and company name per sample', () => {
    const keys = SAMPLE_ENGAGEMENTS.map((s) => s.key);
    const names = SAMPLE_ENGAGEMENTS.map((s) => s.companyName);
    expect(new Set(keys).size).toBe(keys.length);
    expect(new Set(names).size).toBe(names.length);
  });

  describe.each(SAMPLE_ENGAGEMENTS.map((s) => [s.key, s] as const))('%s', (_key, sample) => {
    it('names chapters the 409A skeleton actually has', () => {
      for (const key of Object.keys(sample.narrative)) {
        expect(SECTION_KEYS, `narrative chapter '${key}'`).toContain(key);
      }
    });

    it('carries no analyst ellipsis — the publish gate rejects one', () => {
      for (const [key, html] of Object.entries(sample.narrative)) {
        expect(html, `chapter '${key}'`).not.toMatch(/…|\.\.\./);
      }
    });

    it('uses only placeholders the renderer resolves', () => {
      for (const [key, html] of Object.entries(sample.narrative)) {
        for (const [, name] of html.matchAll(/\{\{(\w+)\}\}/g)) {
          expect(RESOLVABLE, `chapter '${key}' names {{${name}}}`).toContain(name);
        }
      }
    });

    it('survives the sanitizer unchanged — authored markup is already legal', () => {
      for (const [key, html] of Object.entries(sample.narrative)) {
        expect(sanitizeHtml(html), `chapter '${key}'`).toBe(html);
      }
    });

    it('addresses workbook cells at real columns, with finite values', () => {
      for (const cell of sample.workbook) {
        expect(FISCAL_COLUMNS, `${cell.sheet}.${cell.row_key}`).toContain(cell.column_key);
        expect(Number.isFinite(cell.value), `${cell.sheet}.${cell.row_key}`).toBe(true);
      }
      const seen = new Set(sample.workbook.map((c) => `${c.sheet}/${c.row_key}/${c.column_key}`));
      expect(seen.size, 'duplicate workbook cell').toBe(sample.workbook.length);
    });

    it('gives every peer a distinct ticker and a positive enterprise value', () => {
      const tickers = sample.comparables.map((c) => c.ticker);
      expect(new Set(tickers).size).toBe(tickers.length);
      for (const peer of sample.comparables) {
        expect(peer.ev, peer.ticker).toBeGreaterThan(0);
      }
    });

    it('says why a peer it excludes is excluded', () => {
      for (const peer of sample.comparables.filter((c) => !c.included)) {
        expect(peer.exclude_reason?.trim(), peer.ticker).toBeTruthy();
      }
    });

    it('strikes a multiple only on a peer that carries the metric', () => {
      for (const peer of sample.comparables.filter((c) => c.included)) {
        const metrics = [peer.revenue_ltm, peer.revenue_ntm, peer.ebitda_ltm, peer.ebitda_ntm];
        expect(
          metrics.some((m) => typeof m === 'number' && m > 0),
          `${peer.ticker} is included but carries no revenue or EBITDA`,
        ).toBe(true);
      }
    });

    it('keeps option grants inside their contractual term, at sane rates', () => {
      for (const grant of sample.grants) {
        expect(grant.options_granted, grant.label).toBeGreaterThan(0);
        expect(grant.exercise_price, grant.label).toBeGreaterThan(0);
        expect(grant.vesting_months / 12, grant.label).toBeLessThanOrEqual(grant.contractual_term_years);
        expect(grant.risk_free_rate, grant.label).toBeGreaterThanOrEqual(0);
        expect(grant.risk_free_rate, grant.label).toBeLessThan(0.25);
        expect(grant.forfeiture_rate, grant.label).toBeGreaterThanOrEqual(0);
        expect(grant.forfeiture_rate, grant.label).toBeLessThan(1);
        expect(Number.isNaN(Date.parse(grant.grant_date)), grant.label).toBe(false);
      }
    });

    it('signs with a named person and a title', () => {
      expect(sample.signature.signer_name.trim()).toBeTruthy();
      expect(sample.signature.signer_title.trim()).toBeTruthy();
      expect(sample.signature.signature_text.trim()).toBeTruthy();
    });
  });
});

describe('asc718SectionHtml', () => {
  /**
   * The ASC 718 chapter is the one the seeder writes from a live measurement
   * rather than from authored prose, so it is the one that can emit markup the
   * sanitizer then strips back out on save.
   */
  // Measured by the real aggregator from a real sample's grants, so the chapter
  // under test is rendered from the same shape the seeder hands it in
  // production rather than from a hand-built literal that can drift from it.
  const sample = SAMPLE_ENGAGEMENTS.find((s) => s.grants.length > 0);
  if (!sample) throw new Error('no sample carries an option grant to measure');

  const portfolio = asc718Portfolio(
    sample.grants.map((g) => ({
      label: g.label,
      optionsGranted: g.options_granted,
      grantDate: g.grant_date,
      vestingMonths: g.vesting_months,
      forfeitureRate: g.forfeiture_rate,
      assumptions: {
        companyType: 'private' as const,
        grantDateFairValue: g.exercise_price,
        exercisePrice: g.exercise_price,
        expectedTermYears: g.contractual_term_years,
        volatility: 0.62,
        riskFreeRate: g.risk_free_rate,
      },
    })),
  );

  it('renders markup the sanitizer keeps verbatim', () => {
    const html = asc718SectionHtml(portfolio, { currency: 'USD' });
    expect(html.trim()).toBeTruthy();
    expect(sanitizeHtml(html)).toBe(html);
  });

  it('leaves no ellipsis behind for the publish gate to catch', () => {
    expect(asc718SectionHtml(portfolio, { currency: 'USD' })).not.toMatch(/…|\.\.\./);
  });
});
