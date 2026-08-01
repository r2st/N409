/**
 * Onboarding progress, derived from what the account actually contains.
 *
 * The dashboard checklist used to be a purely manual affair: the boxes lived
 * in localStorage, so a user who had already run three valuations still saw
 * "0/8 — your first valuation, step by step". A checklist that disagrees with
 * the screen behind it teaches people to ignore it.
 *
 * The step *copy* stays in the frontend (it is presentation, and it links to
 * help articles); this module owns the step ids and the rule that decides
 * whether each one has genuinely happened. The mapping is pure so it can be
 * tested without a database, and the counts it consumes come from one scoped
 * query in `repos/onboarding.ts`.
 */

export const ONBOARDING_STEPS = [
  'company',
  'cap-table',
  'financials',
  'methodology',
  'assumptions',
  'run',
  'report',
  'board',
] as const;

export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];

/**
 * Raw counts over the valuations the caller can see. Each is "how many
 * valuations have cleared this step", so any non-zero count means the user has
 * done the thing at least once — which is what a first-run checklist asks.
 */
export interface OnboardingFacts {
  valuations: number;
  /** Cap tables holding at least one share-class row. */
  capTables: number;
  /** Documents uploaded and not since deleted. */
  documents: number;
  /** Params carrying an approach weight or a market method. */
  methodology: number;
  /** Params carrying a marketability or control discount. */
  assumptions: number;
  /** Calculations the engine completed successfully. */
  calculations: number;
  /** Reports that have been rendered at least once. */
  reports: number;
  /** Board sign-offs actually signed — sent-but-unsigned does not count. */
  boardSignoffs: number;
}

export const EMPTY_FACTS: OnboardingFacts = {
  valuations: 0,
  capTables: 0,
  documents: 0,
  methodology: 0,
  assumptions: 0,
  calculations: 0,
  reports: 0,
  boardSignoffs: 0,
};

/** The fact backing each step. One place to look when a box won't tick. */
const STEP_FACTS: Record<OnboardingStep, keyof OnboardingFacts> = {
  company: 'valuations',
  'cap-table': 'capTables',
  financials: 'documents',
  methodology: 'methodology',
  assumptions: 'assumptions',
  run: 'calculations',
  report: 'reports',
  board: 'boardSignoffs',
};

/**
 * Which steps the account has genuinely completed.
 *
 * A negative or non-finite count is treated as zero rather than trusted — the
 * checklist should under-claim, never over-claim, if a count arrives malformed.
 */
export function completedSteps(facts: OnboardingFacts): OnboardingStep[] {
  return ONBOARDING_STEPS.filter((step) => {
    const count = facts[STEP_FACTS[step]];
    return Number.isFinite(count) && count > 0;
  });
}

export interface OnboardingProgress {
  steps: OnboardingStep[];
  completed: number;
  total: number;
  /** True once every step has happened — the card can retire itself. */
  all_done: boolean;
}

export function onboardingProgress(facts: OnboardingFacts): OnboardingProgress {
  const steps = completedSteps(facts);
  return {
    steps,
    completed: steps.length,
    total: ONBOARDING_STEPS.length,
    all_done: steps.length === ONBOARDING_STEPS.length,
  };
}
