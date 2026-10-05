import { describe, expect, it } from 'vitest';
import {
  ORDER_STATUSES,
  ORDER_TRANSITIONS,
  canTransitionOrder,
  isTerminalOrderStatus,
} from '../../src/domain/orderLifecycle.js';

describe('the order state machine', () => {
  it('gives every status a row in the transition table', () => {
    expect(Object.keys(ORDER_TRANSITIONS).sort()).toEqual([...ORDER_STATUSES].sort());
  });

  it('every edge destination is a valid status', () => {
    const known = new Set<string>(ORDER_STATUSES);
    for (const from of ORDER_STATUSES) {
      for (const to of ORDER_TRANSITIONS[from]) {
        expect(known.has(to), `${from} → ${to} names a status that does not exist`).toBe(true);
      }
    }
  });

  it('has no self-edges', () => {
    for (const from of ORDER_STATUSES) {
      expect(ORDER_TRANSITIONS[from], `${from} has a self-edge`).not.toContain(from);
    }
  });

  it('completed and canceled are terminal', () => {
    const terminal = ORDER_STATUSES.filter((s) => ORDER_TRANSITIONS[s].length === 0);
    expect(terminal).toEqual(['completed', 'canceled']);
  });

  it('pending can reach every other status', () => {
    expect(canTransitionOrder('pending', 'active')).toBe(true);
    expect(canTransitionOrder('pending', 'completed')).toBe(true);
    expect(canTransitionOrder('pending', 'canceled')).toBe(true);
  });

  it('active can only be canceled', () => {
    expect(canTransitionOrder('active', 'canceled')).toBe(true);
    expect(canTransitionOrder('active', 'pending')).toBe(false);
    expect(canTransitionOrder('active', 'completed')).toBe(false);
  });

  it('terminal statuses cannot be moved', () => {
    expect(isTerminalOrderStatus('completed')).toBe(true);
    expect(isTerminalOrderStatus('canceled')).toBe(true);
    expect(isTerminalOrderStatus('pending')).toBe(false);
    expect(isTerminalOrderStatus('active')).toBe(false);
  });

  it('backward transitions are refused', () => {
    expect(canTransitionOrder('completed', 'pending')).toBe(false);
    expect(canTransitionOrder('canceled', 'pending')).toBe(false);
    expect(canTransitionOrder('canceled', 'active')).toBe(false);
    expect(canTransitionOrder('active', 'pending')).toBe(false);
  });
});
