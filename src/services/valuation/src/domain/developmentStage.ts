/**
 * Stage of enterprise development — the AICPA practice aid's six-stage scale.
 *
 * The practice aid ("Valuation of Privately-Held-Company Equity Securities
 * Issued as Compensation") frames the whole valuation around where a company
 * sits on this scale: it is what justifies weighting the market approach over
 * the income approach, reaching for a backsolve rather than a DCF, and
 * concluding a marketability discount at the top of the supportable range
 * rather than the bottom. A reviewing auditor looks for the stage stated
 * explicitly, and a 409A that never names it has left the reader to infer the
 * premise every other choice in the report rests on.
 *
 * It is a *judgement*, which is why it is stored rather than derived. The
 * suggestion below exists so an analyst does not start from a blank field, and
 * it is deliberately not applied automatically: the difference between stage 4
 * and stage 5 is whether this company's cash flow is sustainably positive, and
 * that is a question about the business rather than about whether a projection
 * row happens to be above zero.
 */

export const DEVELOPMENT_STAGES = [1, 2, 3, 4, 5, 6] as const;
export type DevelopmentStage = (typeof DEVELOPMENT_STAGES)[number];

export interface StageDefinition {
  stage: DevelopmentStage;
  label: string;
  /** The practice aid's description, as a report can state it. */
  description: string;
}

export const STAGE_DEFINITIONS: Readonly<Record<DevelopmentStage, StageDefinition>> = {
  1: {
    stage: 1,
    label: 'Stage 1 — Seed',
    description:
      'The enterprise has no product revenue and limited expenses to date. It has been in existence a ' +
      'short period, holds seed capital from founders or angel investors, and has a business plan ' +
      'rather than a product.',
  },
  2: {
    stage: 2,
    label: 'Stage 2 — Product development',
    description:
      'Product development is under way and there is still no product revenue. Expenses are more ' +
      'substantive and a second round of financing has typically been raised, often from a venture ' +
      'capital investor taking convertible preferred stock.',
  },
  3: {
    stage: 3,
    label: 'Stage 3 — Key milestones met',
    description:
      'The enterprise has met key development milestones — a working prototype or a first beta release ' +
      'tested with customers — and still has no product revenue. Later rounds of preferred financing ' +
      'have typically been raised.',
  },
  4: {
    stage: 4,
    label: 'Stage 4 — Product revenue, operating at a loss',
    description:
      'The enterprise has achieved product revenue but continues to operate at a loss. Further rounds ' +
      'of preferred financing have generally been raised to fund the shortfall.',
  },
  5: {
    stage: 5,
    label: 'Stage 5 — Breakeven or positive cash flow',
    description:
      'The enterprise has product revenue and has reached breakeven or is generating positive cash ' +
      'flow. A liquidity event — an initial public offering or a sale — is a realistic prospect within ' +
      'a foreseeable horizon.',
  },
  6: {
    stage: 6,
    label: 'Stage 6 — Established operating history',
    description:
      'The enterprise has an established financial history of profitable operations or sustainable ' +
      'positive cash flow. An initial public offering or a sale of the enterprise is likely in the ' +
      'near term.',
  },
};

export function isDevelopmentStage(value: unknown): value is DevelopmentStage {
  return typeof value === 'number' && (DEVELOPMENT_STAGES as readonly number[]).includes(value);
}

/** `"Stage 3 — Key milestones met"`, or null when the analyst has not concluded one. */
export function stageLabel(value: unknown): string | null {
  return isDevelopmentStage(value) ? STAGE_DEFINITIONS[value].label : null;
}

export interface StageSuggestion {
  stage: DevelopmentStage;
  /** Why, in the words an analyst would use to accept or reject it. */
  reason: string;
}

/**
 * A starting point, from what the engagement already knows.
 *
 * Never applied on its own. Every boundary this walks is a judgement — whether
 * a beta release counts as a key milestone, whether one profitable quarter is
 * "sustainable" — and the practice aid expects an analyst to have made it. What
 * the data can honestly narrow is the *range*, and that is what this does: it
 * separates pre-revenue from post-revenue, and loss-making from cash-generative,
 * and says which fact it read.
 *
 * The pre-revenue side deliberately lands on 2 rather than 1 or 3. Stage 1 is a
 * company with a business plan and seed capital, which by the time it is
 * commissioning a 409A it usually no longer is; stage 3 turns on a milestone
 * nothing in the payload records. Proposing the middle of the range an analyst
 * will then narrow is more useful than proposing an end of it confidently.
 */
export function suggestDevelopmentStage(args: {
  revenueStatus?: string | null;
  /** `inputs.income.free_cash_flows`, if the income approach carries them. */
  freeCashFlows?: readonly unknown[] | null;
  /** `inputs.revenue_ltm`, when extraction found it. */
  revenueLtm?: number | null;
}): StageSuggestion {
  const flows = (args.freeCashFlows ?? [])
    .map((v) => (typeof v === 'number' ? v : Number(v)))
    .filter((v) => Number.isFinite(v));
  const firstFlow = flows[0];
  const revenue = typeof args.revenueLtm === 'number' ? args.revenueLtm : null;
  const hasRevenue =
    args.revenueStatus === 'post_revenue' || (revenue !== null && revenue > 0);

  if (!hasRevenue) {
    if (args.revenueStatus === 'pre_revenue') {
      return {
        stage: 2,
        reason:
          'The methodology params record the company as pre-revenue. Stages 1 to 3 all describe a ' +
          'pre-revenue enterprise; which one applies turns on the development milestones met, which ' +
          'is a judgement to confirm.',
      };
    }
    return {
      stage: 2,
      reason:
        'No product revenue is recorded on this engagement. Confirm the revenue status and the ' +
        'development milestones met before concluding a stage.',
    };
  }

  // Post-revenue. The remaining question is whether it is funding itself.
  if (firstFlow !== undefined && firstFlow > 0) {
    return {
      stage: 5,
      reason:
        'The company has product revenue and the first projected free cash flow is positive, which ' +
        'is consistent with breakeven or better. Stage 6 requires an established history of ' +
        'profitable operations rather than a forecast of one.',
    };
  }
  return {
    stage: 4,
    reason:
      'The company has product revenue and the projections open with a cash outflow, which is ' +
      'consistent with revenue achieved while still operating at a loss.',
  };
}
