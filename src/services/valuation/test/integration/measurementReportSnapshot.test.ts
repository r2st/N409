import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { newUlid } from '@n409/shared';
import { isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';
import { loadFundReport } from '../../src/repos/measurementReport.js';
import { findValuationById } from '../../src/repos/valuations.js';

const dbUp = await isDbAvailable();

/**
 * The fund report pack is one figure, so it reads one snapshot.
 *
 * `loadFundReport` answers with three statements: the portfolio, its holdings,
 * and the current mark of each holding. On the pool that is three READ
 * COMMITTED snapshots, and the parts are not independent — the NAV schedule is
 * a sum over the marks of exactly the holdings the first statement returned.
 *
 * Delete a holding between the second and the third and `fund_marks` cascades
 * with it (0086). The position row, already read, comes back with no mark, and
 * `markedPositions` in `domain/navExhibits.ts` reads "no mark" as "never
 * marked": the deliverable prints a holding that no longer exists, at cost,
 * classified Level 3, under a sentence stating that N of M holdings carry no
 * mark at the measurement date. Every clause of that is false, and none of it
 * looks wrong on the page.
 *
 * `DELETE /funds/:id/positions/:pid` is not an exotic thing to happen during a
 * render. It is deliberately one of the few measurement writes that stays open
 * on a withdrawn engagement — "a position entered against the wrong fund is the
 * ordinary correction this exists for".
 *
 * Driven by interposing on the pool rather than by racing it: the deletion is
 * issued from inside the loader's own `fund_positions` read, on a second
 * connection, and committed before the mark lookup runs. That is the
 * interleaving under test, so it happens every time.
 */
describe.skipIf(!dbUp)('the fund report pack reads one snapshot', () => {
  let ctx: TestApp;
  let pool: pg.Pool;
  let fundId: string;
  let valuationId: string;
  let keptId: string;
  let doomedId: string;

  beforeAll(async () => {
    ctx = await setupTestApp({ AUTO_PIPELINE: 'off', EMAIL_MODE: 'off' });
    pool = ctx.pool;

    const userId = (await seedUser(ctx, { roles: ['valuation_user'] })).id;
    valuationId = newUlid();
    await pool.query(
      `INSERT INTO valuations (id, user_id, company_name, kind) VALUES ($1, $2, 'Snapshot Fund', 'fund')`,
      [valuationId, userId],
    );
    fundId = newUlid();
    await pool.query(
      `INSERT INTO fund_portfolios (id, name, fund_type, currency, valuation_id)
       VALUES ($1, 'Snapshot Fund', 'vc', 'USD', $2)`,
      [fundId, valuationId],
    );

    const position = async (name: string): Promise<string> => {
      const id = newUlid();
      await pool.query(
        `INSERT INTO fund_positions (id, fund_id, company_name, security_type, quantity, cost_basis, mark_method)
         VALUES ($1, $2, $3, 'preferred', 100, 1000, 'market')`,
        [id, fundId, name],
      );
      await pool.query(
        `INSERT INTO fund_marks (id, position_id, measurement_date, method, fair_value, level, inputs)
         VALUES ($1, $2, current_date, 'market', 4200, 1, '{}')`,
        [newUlid(), id],
      );
      return id;
    };
    // `listPositions` orders by company_name, so 'A…' is read before 'B…'.
    keptId = await position('A PortCo');
    doomedId = await position('B PortCo');
  }, 60_000);

  afterAll(async () => ctx?.teardown());

  it('sees the marks of a holding deleted mid-read', async () => {
    let fired = false;
    /**
     * The real pool, except that the client it hands out deletes a holding the
     * moment the loader has read the holdings list. On a second connection and
     * committed, so the loader's own transaction is the only thing that can
     * decide whether it is visible.
     */
    const after = async (text: string): Promise<void> => {
      if (fired || !/FROM fund_positions/.test(text)) return;
      fired = true;
      await pool.query('DELETE FROM fund_positions WHERE id = $1', [doomedId]);
    };
    const textOf = (arg: unknown): string =>
      typeof arg === 'string' ? arg : ((arg as { text?: string })?.text ?? '');
    /**
     * Hooked on both doors, so the interleaving happens whether the loader
     * reads on the pool or inside a transaction. A hook on `connect` alone
     * would make this file a test of *how* the pack is written rather than of
     * what it answers, and it would report a loader that never opened a
     * transaction as "the deletion never fired".
     */
    const interposed = {
      connect: async (): Promise<pg.PoolClient> => {
        const client = await pool.connect();
        const query = client.query.bind(client) as (...args: unknown[]) => Promise<unknown>;
        (client as unknown as { query: unknown }).query = async (...args: unknown[]) => {
          const result = await query(...args);
          await after(textOf(args[0]));
          return result;
        };
        return client;
      },
      query: async (...args: unknown[]) => {
        const query = pool.query.bind(pool) as (...a: unknown[]) => Promise<unknown>;
        const result = await query(...args);
        await after(textOf(args[0]));
        return result;
      },
    } as unknown as pg.Pool;

    const valuation = await findValuationById(pool, valuationId);
    const data = await loadFundReport(interposed, valuation!);
    expect(fired).toBe(true);
    expect(data).not.toBeNull();

    const byId = new Map(data!.positions.map((p) => [p.position.id, p]));
    // The control: the untouched holding is marked, so a pack that lost every
    // mark would not pass this file.
    expect(byId.get(keptId)?.mark?.fair_value).toBe('4200.0000');
    // The holding deleted mid-read. The snapshot either shows it with its mark
    // or does not show it at all; what it must never do is show it stripped of
    // one, because that is the row the exhibit states is carried at cost.
    const doomed = byId.get(doomedId);
    if (doomed) expect(doomed.mark).not.toBeNull();
  });

  it('is a live read, not a stale one', async () => {
    // The snapshot is per call. A mark taken before the next call must be in
    // it — otherwise "one snapshot" would have bought consistency by freezing.
    await pool.query(
      `INSERT INTO fund_marks (id, position_id, measurement_date, method, fair_value, level, inputs)
       VALUES ($1, $2, current_date + 1, 'market', 5100, 1, '{}')`,
      [newUlid(), keptId],
    );
    const valuation = await findValuationById(pool, valuationId);
    const data = await loadFundReport(pool, valuation!);
    const kept = data!.positions.find((p) => p.position.id === keptId);
    expect(kept?.mark?.fair_value).toBe('5100.0000');
  });
});
