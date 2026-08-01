import { describe, expect, it } from 'vitest';
import {
  EMPTY_FACTS,
  ONBOARDING_STEPS,
  completedSteps,
  onboardingProgress,
  type OnboardingFacts,
} from '../../src/domain/onboarding.js';

const ALL_DONE: OnboardingFacts = {
  valuations: 3,
  capTables: 1,
  documents: 7,
  methodology: 1,
  assumptions: 1,
  calculations: 2,
  reports: 1,
  boardSignoffs: 1,
};

describe('completedSteps', () => {
  it('ticks nothing for a brand-new account', () => {
    expect(completedSteps(EMPTY_FACTS)).toEqual([]);
  });

  it('ticks every step once each fact is non-zero', () => {
    expect(completedSteps(ALL_DONE)).toEqual([...ONBOARDING_STEPS]);
  });

  it('maps each step to its own fact, so one count cannot tick another box', () => {
    for (const step of ONBOARDING_STEPS) {
      const only = completedSteps({ ...EMPTY_FACTS, ...factFor(step) });
      expect(only).toEqual([step]);
    }
  });

  it('returns steps in their canonical display order', () => {
    // capTables set but valuations absent — order must not follow fact order.
    const partial = { ...EMPTY_FACTS, boardSignoffs: 1, valuations: 1 };
    expect(completedSteps(partial)).toEqual(['company', 'board']);
  });

  it('under-claims rather than over-claims on a malformed count', () => {
    expect(completedSteps({ ...EMPTY_FACTS, valuations: Number.NaN })).toEqual([]);
    expect(completedSteps({ ...EMPTY_FACTS, valuations: -3 })).toEqual([]);
    expect(completedSteps({ ...EMPTY_FACTS, valuations: Number.POSITIVE_INFINITY })).toEqual([]);
  });
});

/** The single fact that should tick exactly this step. */
function factFor(step: (typeof ONBOARDING_STEPS)[number]): Partial<OnboardingFacts> {
  switch (step) {
    case 'company':
      return { valuations: 1 };
    case 'cap-table':
      return { capTables: 1 };
    case 'financials':
      return { documents: 1 };
    case 'methodology':
      return { methodology: 1 };
    case 'assumptions':
      return { assumptions: 1 };
    case 'run':
      return { calculations: 1 };
    case 'report':
      return { reports: 1 };
    case 'board':
      return { boardSignoffs: 1 };
  }
}

describe('onboardingProgress', () => {
  it('counts against the full step list', () => {
    expect(onboardingProgress(EMPTY_FACTS)).toEqual({
      steps: [],
      completed: 0,
      total: ONBOARDING_STEPS.length,
      all_done: false,
    });
  });

  it('flags all_done only when nothing is left', () => {
    expect(onboardingProgress(ALL_DONE).all_done).toBe(true);
    expect(onboardingProgress({ ...ALL_DONE, boardSignoffs: 0 }).all_done).toBe(false);
  });

  it('reports a partial account honestly', () => {
    const progress = onboardingProgress({ ...EMPTY_FACTS, valuations: 3, documents: 2 });
    expect(progress).toMatchObject({ steps: ['company', 'financials'], completed: 2, all_done: false });
  });
});
