import { describe, expect, it } from 'vitest';
import { VALUATION_STATES, type ValuationState } from '../../src/domain/valuation.js';
import {
  AUTO_ADVANCE,
  canRestart,
  canTransition,
  decisionTarget,
  nextState,
  NAMED_BUCKETS,
  namedBucketsFor,
  REVIEW_DECISIONS,
  REVIEW_SEND_BACK,
  RESTART_STATE,
  WORKFLOW_TRANSITIONS,
} from '../../src/domain/workflow.js';

/**
 * The lifecycle diagram, stated as invariants rather than as a picture.
 *
 * `workflow.test.ts` next door walks the happy path and spot-checks the forks it
 * was written for. This asks the questions a diagram answers and a list of
 * examples cannot: is every edge's destination a real state, can every state be
 * reached, can every state still get *out*, and do the three derived answers the
 * routes actually call — `nextState`, `canRestart`, `decisionTarget` — only ever
 * name edges the table has.
 *
 * The point of the shape is that a state added to `VALUATION_STATES` fails here
 * until somebody decides where it sits, rather than passing by not appearing in
 * any example. Two of these caught nothing when they were written and that is
 * what they are for.
 *
 *   pending ─┬─→ started ─┬─→ onboarding_completed ─┬─→ user_finished ─┬─→ completed
 *            │            │                         │                  │
 *            │            │                         │                  ├─→ paid ─→ review
 *            │            │                         │                  └─→ review
 *            ↓            ↓                         ↓
 *      cancelled/ignored/timeout ──(restart)──→ started
 *
 *   review ⇄ reviewed ─→ drafted ─→ draft_accepted ─→ published (terminal)
 *      ↑                    ↓
 *      └──── draft_changes ←┘
 */

/** Breadth-first over the table's edges. */
function reachableFrom(start: ValuationState): Set<ValuationState> {
  const seen = new Set<ValuationState>([start]);
  const queue: ValuationState[] = [start];
  while (queue.length > 0) {
    for (const next of WORKFLOW_TRANSITIONS[queue.shift()!]) {
      if (seen.has(next)) continue;
      seen.add(next);
      queue.push(next);
    }
  }
  return seen;
}

describe('the valuation lifecycle diagram', () => {
  it('gives every state a row, and every edge a destination that is a state', () => {
    const known = new Set<string>(VALUATION_STATES);
    expect(Object.keys(WORKFLOW_TRANSITIONS).sort()).toEqual([...VALUATION_STATES].sort());
    for (const from of VALUATION_STATES) {
      for (const to of WORKFLOW_TRANSITIONS[from]) {
        expect(known.has(to), `${from} → ${to} names a state that does not exist`).toBe(true);
      }
    }
  });

  it('has no self-edges and no edge listed twice', () => {
    // A self-edge would make "already there" indistinguishable from "moved", and
    // `assertTransition` reads `from === to` as a no-op rather than as an edge.
    for (const from of VALUATION_STATES) {
      const edges = WORKFLOW_TRANSITIONS[from];
      expect(edges, `${from} has a self-edge`).not.toContain(from);
      expect(new Set(edges).size, `${from} lists an edge twice`).toBe(edges.length);
    }
  });

  it('makes published the one and only terminal state', () => {
    const terminal = VALUATION_STATES.filter((s) => WORKFLOW_TRANSITIONS[s].length === 0);
    expect(terminal).toEqual(['published']);
  });

  it('can reach every state from pending', () => {
    // No island: a state nothing can transition into is a bucket that can only
    // ever be filled by a hand-written UPDATE.
    const reachable = reachableFrom('pending');
    for (const state of VALUATION_STATES) {
      expect(reachable.has(state), `${state} is unreachable from pending`).toBe(true);
    }
  });

  it('can reach published from every state', () => {
    // No trap either. The three dead ends get out via a restart, which is not an
    // edge in the table — but each of them *also* lists `started`, so the table
    // alone is enough to say no engagement is stranded.
    for (const state of VALUATION_STATES) {
      expect(reachableFrom(state).has('published'), `${state} cannot reach published`).toBe(true);
    }
  });

  it('gives the three dead ends exactly one way out, and it is the restart target', () => {
    // `POST /valuations/{id}/submit` in the partner API reads this property off
    // the table rather than listing the states, so it has to hold.
    const restartOnly = VALUATION_STATES.filter(
      (s) => WORKFLOW_TRANSITIONS[s].length === 1 && WORKFLOW_TRANSITIONS[s][0] === RESTART_STATE,
    );
    expect(restartOnly).toEqual(['timeout', 'cancelled', 'ignored']);
  });

  it('lets every state but the terminal one be cancelled', () => {
    // The escape hatch an operator needs on any live file. `published` is
    // deliberately excluded, and so are the three states that are already an end.
    const cancellable = VALUATION_STATES.filter((s) => canTransition(s, 'cancelled'));
    expect(cancellable).toEqual([
      'pending',
      'started',
      'onboarding_completed',
      'user_finished',
      'completed',
      'paid',
      'review',
      'reviewed',
      'drafted',
      'draft_accepted',
      'draft_changes',
    ]);
  });

  describe('the derived answers only ever name edges the table has', () => {
    it('nextState, for every state and every settlement', () => {
      for (const state of VALUATION_STATES) {
        for (const paidStatus of ['unpaid', 'paid', 'paid_by_partner'] as const) {
          const next = nextState(state, { paidStatus });
          if (next === null) continue;
          expect(canTransition(state, next), `${state} → ${next} (${paidStatus})`).toBe(true);
        }
      }
    });

    it('decisionTarget, for every state and both decisions', () => {
      for (const state of VALUATION_STATES) {
        for (const decision of REVIEW_DECISIONS) {
          const target = decisionTarget(state, decision);
          if (target === null) continue;
          expect(canTransition(state, target), `${state} --${decision}--> ${target}`).toBe(true);
        }
      }
    });

    it('and a state is decidable exactly when it has a send-back', () => {
      // The keys of REVIEW_SEND_BACK double as "which states a review decision
      // applies to", so `approve` and `request_changes` must agree about which
      // states they answer for — a state where one works and the other 409s is a
      // reviewer holding a button that does nothing.
      for (const state of VALUATION_STATES) {
        const decidable = REVIEW_SEND_BACK[state] !== undefined;
        for (const decision of REVIEW_DECISIONS) {
          expect(decisionTarget(state, decision) !== null, `${state} / ${decision}`).toBe(decidable);
        }
      }
      expect(Object.keys(REVIEW_SEND_BACK).sort()).toEqual(['drafted', 'review', 'reviewed']);
    });
  });

  describe('the states with no auto-advance are the ones a human has to fork', () => {
    it('names them, so a new one cannot be added silently', () => {
      const forks = VALUATION_STATES.filter((s) => AUTO_ADVANCE[s] === undefined);
      // `draft_changes` is the only *live* one, and it is a genuine fork: a file
      // sent back for changes goes to `review` or back to `drafted` depending on
      // what the reviewer asked for, and no default is better than a wrong one.
      // `published` is terminal; the other three need a restart, which is not a
      // step forward and must not be reachable by clicking Advance.
      expect(forks).toEqual(['draft_changes', 'published', 'timeout', 'cancelled', 'ignored']);
      for (const state of forks) expect(nextState(state)).toBeNull();
    });
  });

  describe('restart', () => {
    it('is refused exactly from published and from the state it lands on', () => {
      const forbidden = VALUATION_STATES.filter((s) => !canRestart(s));
      expect(forbidden).toEqual(['started', 'published']);
    });

    it('lands somewhere every other state can legally be restarted to', () => {
      // Restart bypasses the table on purpose — `cancelled → started` is the only
      // one of these that is also an edge. What must hold is that the target is a
      // state the workflow can then run forward from.
      expect(nextState(RESTART_STATE)).not.toBeNull();
      expect(canRestart(RESTART_STATE)).toBe(false);
    });
  });

  it('files every state under exactly one named bucket besides "all"', () => {
    // A state in no bucket is a row the worklist can never show; a state in two
    // is a row counted twice. `namedBucketsFor` deliberately has no fallback, so
    // this is the check that keeps the tab counts adding up.
    const stateBuckets = NAMED_BUCKETS.filter((b) => b.states.length > 0).map((b) => b.key);
    for (const state of VALUATION_STATES) {
      const found = namedBucketsFor(state).filter((k) => stateBuckets.includes(k));
      expect(found, `${state} is filed under ${found.length} buckets`).toHaveLength(1);
    }
  });
});
