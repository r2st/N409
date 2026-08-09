import { describe, expect, it } from 'vitest';
import {
  DEVELOPMENT_STAGES,
  STAGE_DEFINITIONS,
  isDevelopmentStage,
  stageLabel,
  suggestDevelopmentStage,
} from '../../src/domain/developmentStage.js';

/**
 * The AICPA six-stage scale.
 *
 * The practice aid frames the valuation around where a company sits on it, so
 * the scale itself has to be right and the suggestion has to be honest about
 * being a suggestion. The line between stage 4 and stage 5 is whether cash flow
 * is *sustainably* positive — a question about the business, not about whether
 * a forecast row happens to be above zero — which is why nothing here applies
 * itself.
 */

describe('the scale', () => {
  it('has the practice aid’s six stages, in order', () => {
    expect(DEVELOPMENT_STAGES).toEqual([1, 2, 3, 4, 5, 6]);
    for (const stage of DEVELOPMENT_STAGES) {
      expect(STAGE_DEFINITIONS[stage].stage).toBe(stage);
      expect(STAGE_DEFINITIONS[stage].description.length).toBeGreaterThan(80);
    }
  });

  it('puts the revenue boundary between 3 and 4', () => {
    // The single most load-bearing distinction on the scale: stages 1-3 are
    // pre-revenue, 4-6 have product revenue.
    for (const stage of [1, 2, 3] as const) {
      expect(STAGE_DEFINITIONS[stage].description).toMatch(/no product revenue/i);
    }
    for (const stage of [4, 5, 6] as const) {
      expect(STAGE_DEFINITIONS[stage].description).not.toMatch(/no product revenue/i);
    }
  });

  it('labels a stage for a reader who does not have the practice aid open', () => {
    expect(stageLabel(4)).toBe('Stage 4 — Product revenue, operating at a loss');
  });

  it('refuses anything off the scale', () => {
    for (const bad of [0, 7, -1, 3.5, null, undefined, '4']) {
      expect(isDevelopmentStage(bad)).toBe(false);
      expect(stageLabel(bad)).toBeNull();
    }
  });
});

describe('the suggestion', () => {
  it('proposes the middle of the pre-revenue range, not an end of it', () => {
    // Stage 1 is a company with a business plan and seed capital, which by the
    // time it commissions a 409A it usually no longer is; stage 3 turns on a
    // milestone nothing in the payload records. Proposing the middle of a range
    // the analyst will narrow beats proposing an end of it confidently.
    const out = suggestDevelopmentStage({ revenueStatus: 'pre_revenue' });
    expect(out.stage).toBe(2);
    expect(out.reason).toMatch(/judgement to confirm/i);
  });

  it('proposes stage 4 for a revenue company still burning cash', () => {
    const out = suggestDevelopmentStage({
      revenueStatus: 'post_revenue',
      freeCashFlows: [-2_100_000, 400_000, 3_800_000],
    });
    expect(out.stage).toBe(4);
    expect(out.reason).toMatch(/still operating at a loss/i);
  });

  it('proposes stage 5 when the projections open positive', () => {
    const out = suggestDevelopmentStage({
      revenueStatus: 'post_revenue',
      freeCashFlows: [1_200_000, 3_800_000],
    });
    expect(out.stage).toBe(5);
  });

  it('will not propose stage 6 from a forecast', () => {
    // Stage 6 requires an established history of profitable operations. A
    // projection is a plan, and nothing in the payload distinguishes a company
    // that has been profitable for three years from one that expects to be.
    for (const flows of [[5_000_000], [1, 2, 3], [10_000_000, 20_000_000]]) {
      expect(suggestDevelopmentStage({ revenueStatus: 'post_revenue', freeCashFlows: flows }).stage).not.toBe(
        6,
      );
    }
  });

  it('reads revenue off the extracted figures when the status is unset', () => {
    const out = suggestDevelopmentStage({ revenueLtm: 9_400_000, freeCashFlows: [-500_000] });
    expect(out.stage).toBe(4);
  });

  it('says what it read, so the analyst can disagree with the fact', () => {
    const out = suggestDevelopmentStage({});
    expect(out.stage).toBe(2);
    expect(out.reason).toMatch(/No product revenue is recorded/i);
  });

  it('survives junk in the projections', () => {
    const out = suggestDevelopmentStage({
      revenueStatus: 'post_revenue',
      freeCashFlows: [null, 'x', undefined] as unknown[],
    });
    expect(DEVELOPMENT_STAGES).toContain(out.stage);
  });
});
