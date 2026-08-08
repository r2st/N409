import { describe, expect, it } from 'vitest';
import { VALUATION_STATES, type ValuationState } from '../../src/domain/valuation.js';
import {
  AUTO_ADVANCE,
  canRestart,
  canTransition,
  nextState,
  RESTART_STATE,
  WORKFLOW_TRANSITIONS,
} from '../../src/domain/workflow.js';

describe('workflow engine (M4 #22)', () => {
  it('defines transitions for every state', () => {
    for (const state of VALUATION_STATES) {
      expect(WORKFLOW_TRANSITIONS[state], state).toBeDefined();
    }
  });

  it('every auto-advance step is itself a legal transition', () => {
    for (const [from, to] of Object.entries(AUTO_ADVANCE) as Array<[ValuationState, ValuationState]>) {
      expect(canTransition(from, to), `${from} → ${to}`).toBe(true);
    }
  });

  it('walks the happy path from pending to published', () => {
    const path: ValuationState[] = ['pending'];
    let current: ValuationState = 'pending';
    for (let i = 0; i < 20; i++) {
      const next = nextState(current);
      if (!next) break;
      path.push(next);
      current = next;
    }
    expect(current).toBe('published');
    expect(path).toEqual([
      'pending',
      'started',
      'onboarding_completed',
      'user_finished',
      'completed',
      'review',
      'reviewed',
      'drafted',
      'draft_accepted',
      'published',
    ]);
  });

  it('published is terminal', () => {
    expect(WORKFLOW_TRANSITIONS.published).toEqual([]);
    expect(nextState('published')).toBeNull();
    expect(canRestart('published')).toBe(false);
  });

  it('review can fork to reviewed or draft_changes but not straight to published', () => {
    expect(canTransition('review', 'reviewed')).toBe(true);
    expect(canTransition('review', 'draft_changes')).toBe(true);
    expect(canTransition('review', 'published')).toBe(false);
  });

  describe('the paid gate', () => {
    it('diverts a settled file through paid on its way out of completed', () => {
      expect(nextState('completed', { paidStatus: 'paid' })).toBe('paid');
      expect(nextState('completed', { paidStatus: 'paid_by_partner' })).toBe('paid');
      expect(nextState('paid')).toBe('review');
    });

    it('routes around the gate when the money has not arrived', () => {
      // Production has no Stripe keys, so this is every live valuation today.
      // A gate that defaulted to closed would strand all of them at completed.
      expect(nextState('completed', { paidStatus: 'unpaid' })).toBe('review');
      expect(nextState('completed')).toBe('review');
    });

    it('makes both edges out of completed legal, so an invoiced file is not stuck', () => {
      expect(canTransition('completed', 'paid')).toBe(true);
      expect(canTransition('completed', 'review')).toBe(true);
    });

    it('does not let payment skip review', () => {
      expect(canTransition('paid', 'drafted')).toBe(false);
      expect(canTransition('paid', 'published')).toBe(false);
    });

    it('only gates the entry to review — payment landing later moves nothing', () => {
      // The divert is keyed to `completed` alone. A settled file already in
      // review has passed the gate; re-answering it would rewind the work.
      expect(nextState('review', { paidStatus: 'paid' })).toBe('reviewed');
      expect(nextState('drafted', { paidStatus: 'paid' })).toBe('draft_accepted');
    });

    it('walks the settled happy path through paid to published', () => {
      const path: ValuationState[] = ['completed'];
      let current: ValuationState = 'completed';
      for (let i = 0; i < 20; i++) {
        const next = nextState(current, { paidStatus: 'paid' });
        if (!next) break;
        path.push(next);
        current = next;
      }
      expect(path).toEqual([
        'completed',
        'paid',
        'review',
        'reviewed',
        'drafted',
        'draft_accepted',
        'published',
      ]);
    });
  });

  it('terminal-ish states can be restarted, mid-flight restart is allowed', () => {
    expect(canRestart('cancelled')).toBe(true);
    expect(canRestart('timeout')).toBe(true);
    expect(canRestart('review')).toBe(true);
    expect(RESTART_STATE).toBe('started');
    // restarting an already-started valuation is a no-op, so it's rejected
    expect(canRestart('started')).toBe(false);
  });
});
