import { describe, expect, it } from 'vitest';
import {
  REVIEW_TASK_STATUSES,
  TASK_TRANSITIONS,
  canTransitionTask,
  type ReviewTaskStatus,
} from '../../src/domain/pipeline.js';

function reachableFrom(start: ReviewTaskStatus): Set<ReviewTaskStatus> {
  const seen = new Set<ReviewTaskStatus>([start]);
  const queue: ReviewTaskStatus[] = [start];
  while (queue.length > 0) {
    for (const next of TASK_TRANSITIONS[queue.shift()!]) {
      if (seen.has(next)) continue;
      seen.add(next);
      queue.push(next);
    }
  }
  return seen;
}

describe('review task transition table', () => {
  it('gives every status a row, and every edge a valid destination', () => {
    const known = new Set<string>(REVIEW_TASK_STATUSES);
    expect(Object.keys(TASK_TRANSITIONS).sort()).toEqual([...REVIEW_TASK_STATUSES].sort());
    for (const from of REVIEW_TASK_STATUSES) {
      for (const to of TASK_TRANSITIONS[from]) {
        expect(known.has(to), `${from} → ${to} names a status that does not exist`).toBe(true);
      }
    }
  });

  it('has no self-edges and no edge listed twice', () => {
    for (const from of REVIEW_TASK_STATUSES) {
      const edges = TASK_TRANSITIONS[from];
      expect(edges, `${from} has a self-edge`).not.toContain(from);
      expect(new Set(edges).size, `${from} lists an edge twice`).toBe(edges.length);
    }
  });

  it('makes done and cancelled terminal', () => {
    const terminal = REVIEW_TASK_STATUSES.filter((s) => TASK_TRANSITIONS[s].length === 0);
    expect(terminal.sort()).toEqual(['cancelled', 'done']);
  });

  it('can reach every status from open', () => {
    const reachable = reachableFrom('open');
    for (const s of REVIEW_TASK_STATUSES) {
      expect(reachable.has(s), `${s} is unreachable from open`).toBe(true);
    }
  });

  it('canTransitionTask agrees with the table', () => {
    for (const from of REVIEW_TASK_STATUSES) {
      for (const to of REVIEW_TASK_STATUSES) {
        const allowed = (TASK_TRANSITIONS[from] as readonly string[]).includes(to);
        expect(canTransitionTask(from, to), `${from} → ${to}`).toBe(allowed);
      }
    }
  });

  it('refuses resurrection from terminal states', () => {
    for (const to of REVIEW_TASK_STATUSES) {
      if (to === 'done' || to === 'cancelled') continue;
      expect(canTransitionTask('done', to), `done → ${to}`).toBe(false);
      expect(canTransitionTask('cancelled', to), `cancelled → ${to}`).toBe(false);
    }
  });
});
