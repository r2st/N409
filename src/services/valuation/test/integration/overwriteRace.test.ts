import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OVERWRITE_FIELDS_BY_KEY } from '../../src/domain/overwrites.js';
import { listOverwrites, upsertOverwrite } from '../../src/repos/overwrites.js';
import { authHeader, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';

const dbUp = await isDbAvailable();

/**
 * Override cells under concurrency.
 *
 * `overwrites` is `UNIQUE (valuation_id, field_key)`, and `upsertOverwrite`
 * chose between its UPDATE and INSERT arms by reading the row first, under
 * `SELECT ... FOR UPDATE`. That lock does nothing for the case that needs it:
 * the *first* write of a field has no row to lock, so two concurrent writes
 * both read "no override", both take the INSERT arm, and the loser's
 * transaction dies on the unique violation. The route has no handler for it,
 * so the PUT comes back 500 — a double-clicked Save, or two analysts on one
 * engagement reaching for the same field.
 *
 * A transaction-scoped advisory lock on (valuation, field) makes the check and
 * the write one step, and gives the audit event a `from` value that was read
 * under the same lock that decided which arm ran.
 */
describe.skipIf(!dbUp)('overwrite cells under concurrency', () => {
  let ctx: TestApp;
  let ops: Awaited<ReturnType<typeof seedUser>>;
  let client: Awaited<ReturnType<typeof seedUser>>;

  beforeAll(async () => {
    ctx = await setupTestApp();
    ops = await seedUser(ctx, { roles: ['reviewer'] });
    client = await seedUser(ctx, { roles: ['valuation_user'] });
  });
  afterAll(async () => ctx?.teardown());

  /** A fresh 409a valuation owned by `client`. */
  async function newValuation(): Promise<string> {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/valuations',
      headers: authHeader(client.token),
      payload: { kind: '409a', company_name: 'Acme Robotics, Inc.' },
    });
    expect(res.statusCode).toBe(201);
    return res.json().valuation.id as string;
  }

  const dlom = OVERWRITE_FIELDS_BY_KEY.get('dlom')!;
  const actor = () => ({ actorType: 'human' as const, actorId: ops.id, source: 'api' });

  it('survives concurrent first writes of the same field', async () => {
    const valuationId = await newValuation();
    const values = [0.21, 0.22, 0.23, 0.24];

    const settled = await Promise.allSettled(
      values.map((value) =>
        upsertOverwrite(ctx.pool, {
          valuationId,
          def: dlom,
          value,
          reason: null,
          originalValue: 0.3,
          actor: actor(),
        }),
      ),
    );
    // Under the race every writer but one rejected with a unique violation on
    // (valuation_id, field_key).
    expect(settled.filter((s) => s.status === 'rejected')).toEqual([]);

    // Exactly one cell, holding one of the four values — last write wins.
    const rows = await listOverwrites(ctx.pool, valuationId);
    expect(rows).toHaveLength(1);
    expect(values).toContain(rows[0]!.value);
    // `original_value` is frozen by whichever write created the row, and every
    // writer passed the same one, so it must have survived the updates.
    expect(rows[0]!.original_value).toBe(0.3);
  });

  it('answers every concurrent PUT of a brand-new field', async () => {
    const valuationId = await newValuation();
    const responses = await Promise.all(
      [0.25, 0.26, 0.27, 0.28].map((value) =>
        ctx.app.inject({
          method: 'PUT',
          url: `/api/v1/valuations/${valuationId}/overwrites/dlom`,
          headers: authHeader(ops.token),
          payload: { value, original_value: 0.3 },
        }),
      ),
    );
    expect(responses.map((r) => r.statusCode)).toEqual([200, 200, 200, 200]);
    expect(await listOverwrites(ctx.pool, valuationId)).toHaveLength(1);
  });

  it('records one audit event per write, none claiming a stale prior value', async () => {
    const valuationId = await newValuation();
    await Promise.all(
      [0.21, 0.22, 0.23, 0.24].map((value) =>
        upsertOverwrite(ctx.pool, {
          valuationId,
          def: dlom,
          value,
          reason: null,
          originalValue: 0.3,
          actor: actor(),
        }),
      ),
    );

    const { rows } = await ctx.pool.query<{ payload: { from: unknown; to: number } }>(
      `SELECT payload FROM valuation_events
       WHERE valuation_id = $1 AND type = 'overwrite_applied'
       ORDER BY seq`,
      [valuationId],
    );
    expect(rows).toHaveLength(4);

    // The creating write reports the original; each later one reports a value
    // some earlier write actually left behind, never a value never written.
    const written = new Set<unknown>([0.3, 0.21, 0.22, 0.23, 0.24]);
    for (const r of rows) expect(written).toContain(r.payload.from);
    // ...and each write is present exactly once, under its own value.
    expect(rows.map((r) => r.payload.to).sort()).toEqual([0.21, 0.22, 0.23, 0.24]);
  });

  it('does not serialize different fields of the same valuation', async () => {
    const valuationId = await newValuation();
    const keys = ['dlom', 'dloc', 'volatility', 'risk_free_rate'];
    const settled = await Promise.allSettled(
      keys.map((key) =>
        upsertOverwrite(ctx.pool, {
          valuationId,
          def: OVERWRITE_FIELDS_BY_KEY.get(key)!,
          value: 0.2,
          reason: null,
          originalValue: null,
          actor: actor(),
        }),
      ),
    );
    expect(settled.filter((s) => s.status === 'rejected')).toEqual([]);
    const rows = await listOverwrites(ctx.pool, valuationId);
    expect(rows.map((r) => r.field_key).sort()).toEqual([...keys].sort());
  });
});
