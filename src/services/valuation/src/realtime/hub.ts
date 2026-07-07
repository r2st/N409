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
}

export class ValuationHub {
  private rooms = new Map<string, Map<number, Connection>>();
  private seq = 0;

  /** Registers a connection and announces presence; returns the leave fn. */
  join(valuationId: string, conn: Connection): () => void {
    const id = ++this.seq;
    let room = this.rooms.get(valuationId);
    if (!room) {
      room = new Map();
      this.rooms.set(valuationId, room);
    }
    room.set(id, conn);
    this.broadcast(valuationId, 'presence', { viewers: this.viewers(valuationId) });
    return () => {
      const r = this.rooms.get(valuationId);
      if (!r?.delete(id)) return; // idempotent
      if (r.size === 0) this.rooms.delete(valuationId);
      this.broadcast(valuationId, 'presence', { viewers: this.viewers(valuationId) });
    };
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
