import { describe, expect, it, vi } from 'vitest';
import { ValuationHub } from '../../src/realtime/hub.js';

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
