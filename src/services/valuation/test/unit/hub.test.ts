import { describe, expect, it, vi } from 'vitest';
import { HubCapacityError, ValuationHub } from '../../src/realtime/hub.js';

const V1 = '01JAAAAAAAAAAAAAAAAAAAAAAA';
const V2 = '01JBBBBBBBBBBBBBBBBBBBBBBB';

describe('ValuationHub', () => {
  it('announces presence on join and leave, scoped to the valuation', () => {
    const hub = new ValuationHub();
    const a = vi.fn();
    const b = vi.fn();
    const elsewhere = vi.fn();

    const leaveA = hub.join(V1, { userId: 'u1', name: 'Ana', send: a });
    hub.join(V1, { userId: 'u2', name: 'Bo', send: b });
    hub.join(V2, { userId: 'u3', name: 'Cy', send: elsewhere });

    // Bo's join reached both V1 connections with the full viewer list…
    expect(a).toHaveBeenLastCalledWith('presence', {
      viewers: [
        { user_id: 'u1', name: 'Ana' },
        { user_id: 'u2', name: 'Bo' },
      ],
    });
    expect(b).toHaveBeenLastCalledWith('presence', expect.objectContaining({}));
    // …but never the V2 connection.
    expect(elsewhere).toHaveBeenCalledTimes(1); // its own join only

    leaveA();
    expect(b).toHaveBeenLastCalledWith('presence', {
      viewers: [{ user_id: 'u2', name: 'Bo' }],
    });
  });

  it('dedupes viewers by user across tabs and leave is idempotent', () => {
    const hub = new ValuationHub();
    const tab1 = vi.fn();
    const tab2 = vi.fn();
    const leave1 = hub.join(V1, { userId: 'u1', name: 'Ana', send: tab1 });
    hub.join(V1, { userId: 'u1', name: 'Ana', send: tab2 });

    expect(hub.viewers(V1)).toEqual([{ user_id: 'u1', name: 'Ana' }]);

    leave1();
    leave1(); // double-leave must not re-broadcast or corrupt the room
    expect(hub.viewers(V1)).toEqual([{ user_id: 'u1', name: 'Ana' }]);
  });

  it('keeps broadcasting when one connection throws', () => {
    const hub = new ValuationHub();
    const dead = vi.fn(() => {
      throw new Error('EPIPE');
    });
    const healthy = vi.fn();
    hub.join(V1, { userId: 'u1', name: 'Ana', send: dead });
    hub.join(V1, { userId: 'u2', name: 'Bo', send: healthy });

    hub.broadcast(V1, 'comment', { comment_id: 'c1' });
    expect(healthy).toHaveBeenCalledWith('comment', { comment_id: 'c1' });
  });

  it('broadcast to an empty room is a no-op', () => {
    expect(() => new ValuationHub().broadcast(V1, 'comment', {})).not.toThrow();
  });
});

/**
 * An SSE stream is a request in flight for as long as its tab stays open, so
 * the shutdown drain cannot tell one from a slow handler. Without a way to end
 * them, one open valuation page anywhere made every restart wait out the whole
 * drain deadline and then report abandoned requests that were only heartbeats.
 */
describe('ValuationHub.closeAll', () => {
  it('ends every open stream across rooms and empties the books', () => {
    const hub = new ValuationHub();
    const closes = [vi.fn(), vi.fn(), vi.fn()];
    hub.join(V1, { userId: 'u1', name: 'Ana', send: vi.fn(), close: closes[0] });
    hub.join(V1, { userId: 'u2', name: 'Bo', send: vi.fn(), close: closes[1] });
    hub.join(V2, { userId: 'u3', name: 'Cy', send: vi.fn(), close: closes[2] });

    expect(hub.closeAll()).toBe(3);
    for (const close of closes) expect(close).toHaveBeenCalledTimes(1);
    expect(hub.stats()).toEqual({ total: 0, rooms: 0, users: 0 });
  });

  /**
   * A real `close` runs the stream's own teardown, which calls back into the
   * leave fn `join` returned and mutates the very maps being walked. Snapshot
   * first, or the connection after each one closed is skipped.
   */
  it('closes every stream even though closing one mutates the rooms', () => {
    const hub = new ValuationHub();
    const closed: string[] = [];
    for (const user of ['u1', 'u2', 'u3']) {
      const leave = hub.join(V1, {
        userId: user,
        name: user,
        send: vi.fn(),
        close: () => {
          closed.push(user);
          leave();
        },
      });
    }

    expect(hub.closeAll()).toBe(3);
    expect(closed).toEqual(['u1', 'u2', 'u3']);
    expect(hub.stats().total).toBe(0);
  });

  it('a stream that throws on close does not strand the ones after it', () => {
    const hub = new ValuationHub();
    const survivor = vi.fn();
    hub.join(V1, {
      userId: 'u1',
      name: 'Ana',
      send: vi.fn(),
      close: () => {
        throw new Error('socket already gone');
      },
    });
    hub.join(V1, { userId: 'u2', name: 'Bo', send: vi.fn(), close: survivor });

    expect(hub.closeAll()).toBe(2);
    expect(survivor).toHaveBeenCalledTimes(1);
    // The thrower is dropped from the books too — a connection this process can
    // no longer account for must not keep occupying a capacity slot.
    expect(hub.stats()).toEqual({ total: 0, rooms: 0, users: 0 });
  });

  it('frees the capacity the closed streams held', () => {
    const hub = new ValuationHub({ maxPerUser: 1 });
    hub.join(V1, { userId: 'u1', name: 'Ana', send: vi.fn(), close: vi.fn() });
    expect(hub.capacityFor(V1, 'u1')).toBe('user');

    hub.closeAll();
    expect(hub.capacityFor(V1, 'u1')).toBeNull();
  });

  it('is a no-op with nothing open, and tolerates a connection with no closer', () => {
    const hub = new ValuationHub();
    expect(hub.closeAll()).toBe(0);
    hub.join(V1, { userId: 'u1', name: 'Ana', send: vi.fn() });
    expect(hub.closeAll()).toBe(1);
    expect(hub.stats().total).toBe(0);
  });
});

describe('ValuationHub connection ceilings', () => {
  const conn = (userId: string) => ({ userId, name: userId, send: vi.fn() });

  it('caps the streams one user may hold, across valuations', () => {
    const hub = new ValuationHub({ maxPerUser: 2 });
    hub.join(V1, conn('u1'));
    hub.join(V2, conn('u1')); // a different room still spends the same budget

    expect(hub.capacityFor(V1, 'u1')).toBe('user');
    expect(() => hub.join(V1, conn('u1'))).toThrow(HubCapacityError);
    // …and only that user is refused.
    expect(hub.capacityFor(V1, 'u2')).toBeNull();
    expect(() => hub.join(V1, conn('u2'))).not.toThrow();
  });

  it('caps one room regardless of how many users fill it', () => {
    const hub = new ValuationHub({ maxPerRoom: 2 });
    hub.join(V1, conn('u1'));
    hub.join(V1, conn('u2'));

    expect(hub.capacityFor(V1, 'u3')).toBe('room');
    expect(() => hub.join(V1, conn('u3'))).toThrow(HubCapacityError);
    // A different valuation is unaffected.
    expect(hub.capacityFor(V2, 'u3')).toBeNull();
  });

  it('caps the process total ahead of the narrower ceilings', () => {
    const hub = new ValuationHub({ maxTotal: 2 });
    hub.join(V1, conn('u1'));
    hub.join(V2, conn('u2'));

    expect(hub.capacityFor(V1, 'u3')).toBe('total');
    expect(() => hub.join(V1, conn('u3'))).toThrow(HubCapacityError);
  });

  it('names the ceiling it hit on the thrown error', () => {
    const hub = new ValuationHub({ maxPerUser: 1 });
    hub.join(V1, conn('u1'));
    try {
      hub.join(V1, conn('u1'));
      expect.unreachable('join should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(HubCapacityError);
      expect((err as HubCapacityError).scope).toBe('user');
    }
  });

  it('leaving returns the budget, and a double-leave does not return it twice', () => {
    const hub = new ValuationHub({ maxPerUser: 1 });
    const leave = hub.join(V1, conn('u1'));
    expect(hub.stats()).toEqual({ total: 1, rooms: 1, users: 1 });

    leave();
    expect(hub.stats()).toEqual({ total: 0, rooms: 0, users: 0 });
    leave(); // idempotent — must not credit a second slot
    expect(hub.stats().total).toBe(0);

    // The freed slot is reusable exactly once.
    hub.join(V1, conn('u1'));
    expect(() => hub.join(V1, conn('u1'))).toThrow(HubCapacityError);
  });

  it('defaults leave room for ordinary multi-tab use', () => {
    const hub = new ValuationHub();
    for (let i = 0; i < 8; i++) hub.join(V1, conn('u1'));
    expect(hub.capacityFor(V1, 'u1')).toBeNull();
    expect(hub.stats().total).toBe(8);
  });
});
