/**
 * Improvement 4 — realtime collaboration hub. In-memory per-valuation SSE
 * fan-out: who is viewing (presence) and domain pushes (new comments). State
 * is per-process by design — presence is ephemeral and a restart simply drops
 * connections, which clients re-establish.
 */

export interface Viewer {
  user_id: string;
  name: string;
}

export type SendFn = (event: string, data: unknown) => void;

interface Connection {
  userId: string;
  name: string;
  send: SendFn;
  /**
   * Ends the underlying stream. Optional because presence and fan-out need
   * nothing of the sort — only {@link ValuationHub.closeAll} does, and only at
   * shutdown. A connection registered without one is simply dropped from the
   * hub's books there and left for the server's own force-close.
   */
  close?: () => void;
}

/** Which ceiling a refused {@link ValuationHub.join} ran into. */
export type CapacityScope = 'user' | 'room' | 'total';

export class HubCapacityError extends Error {
  constructor(readonly scope: CapacityScope) {
    super(`Realtime stream capacity reached (${scope})`);
    this.name = 'HubCapacityError';
  }
}

/**
 * Ceilings on concurrent streams. Every SSE connection is a held socket, a
 * heartbeat timer and a room entry that lives until the client goes away, so
 * nothing about the request rate limiter bounds them: a caller allowed N new
 * requests a minute can accumulate connections for as long as it keeps them
 * open. Presence makes that worse than linear — each join broadcasts the full
 * viewer list to everyone already in the room, so an unbounded room costs
 * O(n²) writes to fill.
 *
 * The defaults are far above what the UI asks for (one stream per open
 * valuation tab) and far below what exhausts a process.
 */
export interface HubLimits {
  /** Streams one user may hold at once, across every valuation. */
  maxPerUser?: number;
  /** Streams one valuation's room may hold, across every user. */
  maxPerRoom?: number;
  /** Streams this process may hold at all. */
  maxTotal?: number;
}

const DEFAULT_LIMITS = { maxPerUser: 12, maxPerRoom: 64, maxTotal: 1024 } as const;

export class ValuationHub {
  private rooms = new Map<string, Map<number, Connection>>();
  private perUser = new Map<string, number>();
  private total = 0;
  private seq = 0;
  private readonly limits: Required<HubLimits>;

  constructor(limits: HubLimits = {}) {
    this.limits = { ...DEFAULT_LIMITS, ...limits };
  }

  /**
   * The ceiling a join would hit right now, or null if there is room.
   *
   * Exists because the SSE route must decide before it hijacks the socket: once
   * the 200 and the event-stream headers are on the wire there is no longer a
   * way to answer 429. Nothing may await between this and {@link join} — on one
   * thread that keeps the two answers identical.
   */
  capacityFor(valuationId: string, userId: string): CapacityScope | null {
    if (this.total >= this.limits.maxTotal) return 'total';
    if ((this.perUser.get(userId) ?? 0) >= this.limits.maxPerUser) return 'user';
    if ((this.rooms.get(valuationId)?.size ?? 0) >= this.limits.maxPerRoom) return 'room';
    return null;
  }

  /**
   * Registers a connection and announces presence; returns the leave fn.
   *
   * Throws {@link HubCapacityError} when a ceiling in {@link HubLimits} is
   * already met — the caller turns that into a 429 rather than accepting a
   * stream it cannot afford to hold.
   */
  join(valuationId: string, conn: Connection): () => void {
    const full = this.capacityFor(valuationId, conn.userId);
    if (full) throw new HubCapacityError(full);

    const id = ++this.seq;
    let room = this.rooms.get(valuationId);
    if (!room) {
      room = new Map();
      this.rooms.set(valuationId, room);
    }
    room.set(id, conn);
    this.perUser.set(conn.userId, (this.perUser.get(conn.userId) ?? 0) + 1);
    this.total += 1;
    this.broadcast(valuationId, 'presence', { viewers: this.viewers(valuationId) });
    return () => {
      const r = this.rooms.get(valuationId);
      if (!r?.delete(id)) return; // idempotent
      const held = (this.perUser.get(conn.userId) ?? 1) - 1;
      if (held > 0) this.perUser.set(conn.userId, held);
      else this.perUser.delete(conn.userId);
      this.total -= 1;
      if (r.size === 0) this.rooms.delete(valuationId);
      this.broadcast(valuationId, 'presence', { viewers: this.viewers(valuationId) });
    };
  }

  /** Streams currently held, for the saturation gauge and for tests. */
  stats(): { total: number; rooms: number; users: number } {
    return { total: this.total, rooms: this.rooms.size, users: this.perUser.size };
  }

  /**
   * Ends every open stream. Returns how many were closed.
   *
   * For shutdown, and nothing else. An SSE stream is a request that is still
   * being served for as long as the client keeps its tab open, so to the
   * request drain it is indistinguishable from a slow handler — one open
   * valuation page anywhere would make every restart wait out the full drain
   * deadline and then report requests abandoned, on a service where the
   * abandoned request is a heartbeat nobody is waiting for. Ending them first
   * makes the drain measure what it is for: work with a caller behind it.
   *
   * Closing a stream runs its own teardown, which calls back into `join`'s
   * leave fn and mutates the room maps, so the connections are snapshotted
   * before the walk. The books are cleared afterwards regardless — a connection
   * that threw on close is one this process can no longer account for, and
   * keeping it counted would only understate the next capacity check.
   */
  closeAll(): number {
    const open = [...this.rooms.values()].flatMap((room) => [...room.values()]);
    for (const conn of open) {
      try {
        conn.close?.();
      } catch {
        // Ending a socket that has already gone away is not worth a line, and
        // must not stop the stream after it from being told to go.
      }
    }
    this.rooms.clear();
    this.perUser.clear();
    this.total = 0;
    return open.length;
  }

  /** Distinct people in the room (one badge per user, however many tabs). */
  viewers(valuationId: string): Viewer[] {
    const byUser = new Map<string, Viewer>();
    for (const conn of this.rooms.get(valuationId)?.values() ?? []) {
      byUser.set(conn.userId, { user_id: conn.userId, name: conn.name });
    }
    return [...byUser.values()];
  }

  broadcast(valuationId: string, event: string, data: unknown): void {
    for (const conn of this.rooms.get(valuationId)?.values() ?? []) {
      try {
        conn.send(event, data);
      } catch {
        // A dying socket must never break the loop for the healthy ones;
        // its own close handler will remove it.
      }
    }
  }
}
