import { describe, expect, it } from 'vitest';
import type pg from 'pg';
import { latestEventAt, listEvents, recordEvent } from '../../src/events/record.js';

/**
 * The event-spine readers build SQL by hand, so the shape of that SQL is the
 * contract worth pinning: predicates are parameterised (never interpolated),
 * every filter reaches the database rather than being applied in memory, and
 * a limited read still hands rows back in causal order.
 */

interface Captured {
  sql: string;
  params: unknown[];
}

function fakePool(rows: unknown[] = []): { pool: pg.Pool; calls: Captured[] } {
  const calls: Captured[] = [];
  const pool = {
    query: async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      return { rows };
    },
  } as unknown as pg.Pool;
  return { pool, calls };
}

const squash = (sql: string) => sql.replace(/\s+/g, ' ').trim();

describe('listEvents', () => {
  it('filters to one valuation and orders by sequence', async () => {
    const { pool, calls } = fakePool();
    await listEvents(pool, 'val-1');
    expect(squash(calls[0]!.sql)).toBe(
      'SELECT * FROM valuation_events WHERE valuation_id = $1 ORDER BY seq ASC',
    );
    expect(calls[0]!.params).toEqual(['val-1']);
  });

  it('pushes a type filter into SQL as an array match', async () => {
    const { pool, calls } = fakePool();
    await listEvents(pool, 'val-1', { types: ['state_changed', 'report_rendered'] });
    expect(calls[0]!.sql).toContain('type = ANY($2)');
    expect(calls[0]!.params).toEqual(['val-1', ['state_changed', 'report_rendered']]);
  });

  it('copies the type list so a caller cannot mutate the query after the fact', async () => {
    const { pool, calls } = fakePool();
    const types = ['state_changed'];
    await listEvents(pool, 'val-1', { types });
    types.push('mutated');
    expect(calls[0]!.params[1]).toEqual(['state_changed']);
  });

  it('pushes actor and date filters into SQL', async () => {
    const { pool, calls } = fakePool();
    const from = new Date('2026-01-01T00:00:00Z');
    const to = new Date('2026-02-01T00:00:00Z');
    await listEvents(pool, 'val-1', { actorType: 'human', actorId: 'u1', from, to });
    const sql = calls[0]!.sql;
    expect(sql).toContain('actor_type = $2');
    expect(sql).toContain('actor_id = $3');
    expect(sql).toContain('occurred_at >= $4');
    expect(sql).toContain('occurred_at <= $5');
    expect(calls[0]!.params).toEqual(['val-1', 'human', 'u1', from, to]);
  });

  it('numbers placeholders in order when only some filters are present', async () => {
    const { pool, calls } = fakePool();
    await listEvents(pool, 'val-1', { to: new Date('2026-02-01T00:00:00Z') });
    expect(calls[0]!.sql).toContain('occurred_at <= $2');
    expect(calls[0]!.params).toHaveLength(2);
  });

  it('never interpolates a filter value into the SQL text', async () => {
    const { pool, calls } = fakePool();
    await listEvents(pool, "val-1'; DROP TABLE valuation_events; --", {
      actorType: "'; DROP TABLE users; --",
    });
    expect(calls[0]!.sql).not.toContain('DROP TABLE');
  });

  it('takes the newest rows but returns them oldest-first when limited', async () => {
    const { pool, calls } = fakePool();
    await listEvents(pool, 'val-1', { limit: 50 });
    const sql = squash(calls[0]!.sql);
    expect(sql).toContain('ORDER BY seq DESC LIMIT $2');
    expect(sql.endsWith('ORDER BY seq ASC')).toBe(true);
    expect(calls[0]!.params).toEqual(['val-1', 50]);
  });

  it('combines a limit with the other filters', async () => {
    const { pool, calls } = fakePool();
    await listEvents(pool, 'val-1', { types: ['state_changed'], limit: 10 });
    expect(calls[0]!.sql).toContain('type = ANY($2)');
    expect(calls[0]!.sql).toContain('LIMIT $3');
    expect(calls[0]!.params).toEqual(['val-1', ['state_changed'], 10]);
  });

  it('matches nothing for an empty type list rather than everything', async () => {
    const { pool, calls } = fakePool();
    await listEvents(pool, 'val-1', { types: [] });
    expect(calls[0]!.sql).toContain('type = ANY($2)');
    expect(calls[0]!.params[1]).toEqual([]);
  });

  it('returns the rows the database hands back', async () => {
    const { pool } = fakePool([{ id: 'e1' }, { id: 'e2' }]);
    expect(await listEvents(pool, 'val-1')).toHaveLength(2);
  });
});

describe('latestEventAt', () => {
  it('reads a single newest row off the occurred_at index', async () => {
    const { pool, calls } = fakePool([{ occurred_at: new Date('2026-03-01T00:00:00Z') }]);
    const at = await latestEventAt(pool, 'val-1');
    expect(squash(calls[0]!.sql)).toContain('ORDER BY occurred_at DESC LIMIT 1');
    expect(calls[0]!.params).toEqual(['val-1']);
    expect(at?.toISOString()).toBe('2026-03-01T00:00:00.000Z');
  });

  it('is null for a valuation with no events', async () => {
    const { pool } = fakePool([]);
    expect(await latestEventAt(pool, 'val-1')).toBeNull();
  });
});

describe('recordEvent', () => {
  it('writes the actor, source and JSON payload as bound parameters', async () => {
    const calls: Captured[] = [];
    const client = {
      query: async (sql: string, params: unknown[] = []) => {
        calls.push({ sql, params });
        return { rows: [{ id: 'e1' }] };
      },
    } as unknown as pg.PoolClient;

    await recordEvent(client, {
      valuationId: 'val-1',
      type: 'params_updated',
      actor: { actorType: 'human', actorId: 'u1' },
      payload: { changes: { dlom: { from: null, to: 0.22 } } },
    });

    const [, valuationId, type, actorType, actorId, source, payload] = calls[0]!.params;
    expect(valuationId).toBe('val-1');
    expect(type).toBe('params_updated');
    expect(actorType).toBe('human');
    expect(actorId).toBe('u1');
    expect(source).toBe('api');
    expect(JSON.parse(payload as string)).toEqual({ changes: { dlom: { from: null, to: 0.22 } } });
  });

  it('defaults a missing actor id and payload', async () => {
    const calls: Captured[] = [];
    const client = {
      query: async (sql: string, params: unknown[] = []) => {
        calls.push({ sql, params });
        return { rows: [{ id: 'e1' }] };
      },
    } as unknown as pg.PoolClient;

    await recordEvent(client, {
      valuationId: 'val-1',
      type: 'valuation_created',
      actor: { actorType: 'system' },
    });

    expect(calls[0]!.params[4]).toBeNull();
    expect(JSON.parse(calls[0]!.params[6] as string)).toEqual({});
  });
});
