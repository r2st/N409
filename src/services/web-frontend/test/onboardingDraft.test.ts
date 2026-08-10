import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearDraft,
  loadDraft,
  MAX_AGE_MS,
  ONBOARDING_DRAFT_KEY,
  saveDraft,
} from '../src/lib/onboardingDraft';
import type { Valuation } from '../src/lib/types';

const VALUATION = {
  id: '01TESTVALUATION0000000000A',
  kind: '409a',
  company_name: 'Acme Robotics, Inc.',
  currency: 'USD',
  state: 'pending',
} as unknown as Valuation;

const NOW = Date.UTC(2026, 7, 10, 12, 0, 0);

describe('onboarding draft', () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  it('round-trips the step, the valuation and the upload ticks', () => {
    saveDraft({ step: 2, valuation: VALUATION, uploaded: { cap_table: ['cap.xlsx'] } }, NOW);
    const draft = loadDraft(NOW);
    expect(draft?.step).toBe(2);
    expect(draft?.valuation.id).toBe(VALUATION.id);
    expect(draft?.uploaded.cap_table).toEqual(['cap.xlsx']);
  });

  it('has nothing to resume before the wizard has created anything', () => {
    expect(loadDraft(NOW)).toBeNull();
  });

  it('uses sessionStorage, so a shared machine does not keep a half-finished request', () => {
    saveDraft({ step: 1, valuation: VALUATION, uploaded: {} }, NOW);
    expect(sessionStorage.getItem(ONBOARDING_DRAFT_KEY)).toBeTruthy();
    expect(localStorage.getItem(ONBOARDING_DRAFT_KEY)).toBeNull();
  });

  it('drops a draft older than a day rather than resuming a forgotten visit', () => {
    saveDraft({ step: 2, valuation: VALUATION, uploaded: {} }, NOW);
    expect(loadDraft(NOW + MAX_AGE_MS - 1000)).not.toBeNull();
    expect(loadDraft(NOW + MAX_AGE_MS + 1000)).toBeNull();
    // And it is cleared, not merely ignored — a second read agrees.
    expect(sessionStorage.getItem(ONBOARDING_DRAFT_KEY)).toBeNull();
  });

  it('discards corrupt JSON instead of throwing on mount', () => {
    sessionStorage.setItem(ONBOARDING_DRAFT_KEY, '{not json');
    expect(() => loadDraft(NOW)).not.toThrow();
    expect(loadDraft(NOW)).toBeNull();
  });

  it('discards a draft from an older shape', () => {
    sessionStorage.setItem(
      ONBOARDING_DRAFT_KEY,
      JSON.stringify({ version: 0, step: 2, valuation: VALUATION, savedAt: NOW }),
    );
    expect(loadDraft(NOW)).toBeNull();
  });

  it('refuses a draft with no usable valuation — there would be nothing to resume against', () => {
    for (const valuation of [null, {}, { id: '' }, { id: 'x' }, 'string']) {
      sessionStorage.setItem(
        ONBOARDING_DRAFT_KEY,
        JSON.stringify({ version: 1, step: 2, valuation, savedAt: NOW }),
      );
      expect(loadDraft(NOW)).toBeNull();
    }
  });

  it('clamps a step outside the wizard rather than rendering nothing', () => {
    for (const [stored, expected] of [
      [99, 3],
      [-4, 0],
      [1.7, 1],
      ['two', 0],
    ] as const) {
      sessionStorage.setItem(
        ONBOARDING_DRAFT_KEY,
        JSON.stringify({ version: 1, step: stored, valuation: VALUATION, savedAt: NOW }),
      );
      expect(loadDraft(NOW)?.step).toBe(expected);
    }
  });

  it('ignores an upload map that is not one, keeping the rest of the draft', () => {
    sessionStorage.setItem(
      ONBOARDING_DRAFT_KEY,
      JSON.stringify({
        version: 1,
        step: 2,
        valuation: VALUATION,
        uploaded: { cap_table: 'not-an-array' },
        savedAt: NOW,
      }),
    );
    const draft = loadDraft(NOW);
    expect(draft?.uploaded).toEqual({});
    expect(draft?.step).toBe(2);
  });

  it('clears on demand', () => {
    saveDraft({ step: 1, valuation: VALUATION, uploaded: {} }, NOW);
    clearDraft();
    expect(loadDraft(NOW)).toBeNull();
  });

  it('never throws when storage is unavailable — the wizard must still work', () => {
    const original = Object.getOwnPropertyDescriptor(window, 'sessionStorage');
    Object.defineProperty(window, 'sessionStorage', {
      configurable: true,
      get() {
        throw new Error('SecurityError: storage disabled');
      },
    });
    try {
      expect(() => saveDraft({ step: 1, valuation: VALUATION, uploaded: {} }, NOW)).not.toThrow();
      expect(() => clearDraft()).not.toThrow();
      expect(loadDraft(NOW)).toBeNull();
    } finally {
      if (original) Object.defineProperty(window, 'sessionStorage', original);
    }
  });
});
