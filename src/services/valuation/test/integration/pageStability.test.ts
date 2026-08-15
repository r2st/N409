import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newUlid } from '@n409/shared';
import { listValuations } from '../../src/repos/valuations.js';
import { firmClients } from '../../src/repos/firmDashboard.js';
import { authHeader, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';

const dbUp = await isDbAvailable();

/**
 * Paging a list whose sort key ties.
 *
 * `valuations.created_at` defaults to `now()`, which in Postgres is the
 * *transaction* timestamp — every row one transaction writes carries the same
 * instant to the microsecond, and a seed, an import, a restore or a migration
 * writes many. Rows tying the ORDER BY have no defined order between them, and
 * a paged list issues the same query once per page with a different OFFSET.
 *
 * Two reads of an unchanged table usually agree anyway, which is why this
 * survived: on a small table the planner seq-scans and the heap order is the
 * insertion order, so the pages line up by luck. The luck runs out on the
 * first *write*. An UPDATE writes a new row version at the end of the heap, so
 * an engagement edited while somebody is paging moves — and it moves relative
 * to rows it ties with, which reorders the very rows the OFFSET is counting
 * through. One row is then served on two pages and its neighbour on none,
 * while `total` keeps counting both.
 *
 * That is the scenario below, and it is an ordinary Tuesday: a client walks
 * their engagement list while an analyst renames one of the engagements.
 *
 * `orderBySql` already appended `id ASC` when the caller supplied an explicit
 * sort. It did not on the default branch — and the default branch is the one
 * the UI uses, because sorting is opt-in.
 */
describe.skipIf(!dbUp)('pagination is stable across tied sort keys', () => {
  let ctx: TestApp;
  let client: Awaited<ReturnType<typeof seedUser>>;
  let ops: Awaited<ReturnType<typeof seedUser>>;

  const TIED = 6;
  let seededIds: string[] = [];

  /** Six engagements written by one transaction, so all six `created_at` tie. */
  async function seedTiedValuations(userId: string, prefix: string, partnerId?: string): Promise<string[]> {
    const ids: string[] = [];
    const conn = await ctx.pool.connect();
    try {
      await conn.query('BEGIN');
      for (let i = 0; i < TIED; i += 1) {
        const id = newUlid();
        ids.push(id);
        await conn.query(
          `INSERT INTO valuations (id, kind, company_name, user_id, partner_id, state)
           VALUES ($1, '409a', $2, $3, $4, 'pending')`,
          [id, `${prefix} ${i}`, userId, partnerId ?? null],
        );
      }
      await conn.query('COMMIT');
    } finally {
      conn.release();
    }
    return ids;
  }

  beforeAll(async () => {
    ctx = await setupTestApp({ AUTO_PIPELINE: 'off' });
    ops = await seedUser(ctx, { roles: ['admin'] });
    client = await seedUser(ctx, { roles: ['valuation_user'] });
    seededIds = await seedTiedValuations(client.id, 'Tied Co');
  });
  afterAll(async () => ctx?.teardown());

  it('really did tie — one instant across every row (vacuity guard)', async () => {
    const { rows } = await ctx.pool.query<{ instants: string }>(
      'SELECT count(DISTINCT created_at)::text AS instants FROM valuations WHERE user_id = $1',
      [client.id],
    );
    // If now() ever stopped being transaction-scoped the rows would no longer
    // tie, every test below would pass for the wrong reason, and this fails
    // first to say so.
    expect(Number(rows[0]!.instants)).toBe(1);
  });

  it('walks the engagement list one row at a time while a row is edited underneath it', async () => {
    const seen: string[] = [];
    for (let page = 1; page <= TIED; page += 1) {
      const res = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/valuations?page=${page}&per_page=1`,
        headers: authHeader(client.token),
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.total).toBe(TIED);
      expect(body.valuations).toHaveLength(1);
      seen.push(body.valuations[0].id as string);

      // The edit that moves a row's heap position. An ordinary rename through
      // the ordinary route — nothing about it is a test fixture except its
      // timing, and its timing is whatever the analyst's timing happens to be.
      if (page === 2) {
        const patched = await ctx.app.inject({
          method: 'PATCH',
          url: `/api/v1/valuations/${seededIds[0]}`,
          headers: authHeader(ops.token),
          payload: { company_name: 'Tied Co 0 (renamed)' },
        });
        expect(patched.statusCode).toBe(200);
      }
    }
    // Six pages of one row each over six rows: the union has to be the six
    // distinct ids. A duplicate and an omission are the same defect seen from
    // its two ends, and this catches either alone.
    expect(new Set(seen).size).toBe(TIED);
    expect([...seen].sort()).toEqual([...seededIds].sort());
  });

  it('holds on an explicit sort whose column ties just as completely', async () => {
    const scope = { kind: 'own' as const, userId: client.id };
    const seen: string[] = [];
    for (let page = 1; page <= TIED; page += 1) {
      // `state` is 'pending' on all six, so this branch ties on every row too.
      const { items } = await listValuations(ctx.pool, scope, {
        sort: [{ column: 'state', dir: 'asc' }],
        page,
        perPage: 1,
      });
      expect(items).toHaveLength(1);
      seen.push(items[0]!.id);
      if (page === 2) {
        await ctx.pool.query('UPDATE valuations SET company_name = company_name WHERE id = $1', [
          seededIds[1],
        ]);
      }
    }
    expect(new Set(seen).size).toBe(TIED);
  });

  describe('the firm client roster', () => {
    let partnerId: string;
    let firmUser: Awaited<ReturnType<typeof seedUser>>;
    let rosterIds: string[];

    beforeAll(async () => {
      const partner = await ctx.pool.query<{ id: string }>(
        `INSERT INTO partners (id, name, key) VALUES ($1, 'Tied Firm', $2) RETURNING id`,
        [newUlid(), `tied-firm-${newUlid().toLowerCase()}`],
      );
      partnerId = partner.rows[0]!.id;
      firmUser = await seedUser(ctx, { roles: ['partner'], partnerId });
      // One company per row, so each group's max(created_at) is that one shared
      // instant and every group ties with every other.
      rosterIds = await seedTiedValuations(firmUser.id, 'Roster', partnerId);
    });

    it('pages the roster while a client company is edited underneath it', async () => {
      const seen: string[] = [];
      for (let page = 1; page <= TIED; page += 1) {
        const res = await ctx.app.inject({
          method: 'GET',
          url: `/api/v1/firm/clients?page=${page}&per_page=1`,
          headers: authHeader(firmUser.token),
        });
        expect(res.statusCode).toBe(200);
        const body = res.json();
        expect(body.total).toBe(TIED);
        expect(body.clients).toHaveLength(1);
        seen.push(body.clients[0].company_name as string);

        if (page === 2) {
          await ctx.pool.query('UPDATE valuations SET waiting_on_client = true WHERE id = $1', [
            rosterIds[0],
          ]);
        }
      }
      expect(new Set(seen).size).toBe(TIED);
    });

    it('agrees with itself when nothing moved', async () => {
      const first = await firmClients(ctx.pool, partnerId, { limit: 2, offset: 0 });
      const again = await firmClients(ctx.pool, partnerId, { limit: 2, offset: 0 });
      expect(again.clients.map((c) => c.company_name)).toEqual(first.clients.map((c) => c.company_name));
    });
  });
});
