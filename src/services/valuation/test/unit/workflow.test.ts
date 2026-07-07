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

  it('terminal-ish states can be restarted, mid-flight restart is allowed', () => {
    expect(canRestart('cancelled')).toBe(true);
    expect(canRestart('timeout')).toBe(true);
    expect(canRestart('review')).toBe(true);
    expect(RESTART_STATE).toBe('started');
    // restarting an already-started valuation is a no-op, so it's rejected
    expect(canRestart('started')).toBe(false);
  });
});
