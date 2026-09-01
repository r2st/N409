import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createValuation } from '../../src/repos/valuations.js';
import { runRetentionSweep } from '../../src/routes/retention.js';
import {
  authHeader,
  interceptPoolQueries,
  isDbAvailable,
  seedUser,
  setupTestApp,
  type TestApp,
} from './helpers.js';

const dbUp = await isDbAvailable();
const actor = { actorType: 'human' as const, actorId: 'test', source: 'test' };

describe.skipIf(!dbUp)('data retention + legal hold (feature 10)', () => {
  let ctx: TestApp;
  let admin: Awaited<ReturnType<typeof seedUser>>;

  beforeAll(async () => {
    ctx = await setupTestApp();
    admin = await seedUser(ctx, { roles: ['admin'] });
  });
  afterAll(async () => ctx?.teardown());

  async function agedValuation(company: string, ageDays: number) {
    const v = await createValuation(
      ctx.pool,
      { kind: '409a', companyName: company, userId: admin.id },
      { ...actor, actorId: admin.id },
    );
    await ctx.pool.query(
      `UPDATE valuations SET created_at = now() - ($2 || ' days')::interval WHERE id = $1`,
      [v.id, String(ageDays)],
    );
    return v;
  }

  it('lists seeded policies and updates one', async () => {
    const list = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/admin/retention/policies',
      headers: authHeader(admin.token),
    });
    expect(list.json().policies.map((p: { data_type: string }) => p.data_type)).toContain('valuation');

    const put = await ctx.app.inject({
      method: 'PUT',
      url: '/api/v1/admin/retention/policies/valuation',
      headers: authHeader(admin.token),
      payload: { archive_after_days: 365, retention_days: 730, enabled: true },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json().policy.enabled).toBe(true);
  });

  it('archives expired valuations but skips ones under legal hold', async () => {
    // Enable the policy at 365 days.
    await ctx.app.inject({
      method: 'PUT',
      url: '/api/v1/admin/retention/policies/valuation',
      headers: authHeader(admin.token),
      payload: { archive_after_days: 365, retention_days: 730, enabled: true },
    });

    const old = await agedValuation('OldCo', 500);
    const held = await agedValuation('HeldCo', 500);
    const young = await agedValuation('YoungCo', 100);

    // Place a legal hold on HeldCo.
    const hold = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/admin/retention/holds',
      headers: authHeader(admin.token),
      payload: { scope: 'valuation', reference_id: held.id, reason: 'IRS audit' },
    });
    expect(hold.statusCode).toBe(201);

    const result = await runRetentionSweep(ctx.pool);
    expect(result.archived).toBeGreaterThanOrEqual(1);
    expect(result.skipped_hold).toBeGreaterThanOrEqual(1);

    const archived = async (id: string) =>
      (await ctx.pool.query('SELECT archived_at FROM valuations WHERE id = $1', [id])).rows[0].archived_at;
    expect(await archived(old.id)).not.toBeNull();
    expect(await archived(held.id)).toBeNull(); // frozen
    expect(await archived(young.id)).toBeNull(); // too young

    // The actions log recorded both an archive and a skip.
    const actions = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/admin/retention/actions',
      headers: authHeader(admin.token),
    });
    const kinds = actions.json().actions.map((a: { action: string }) => a.action);
    expect(kinds).toContain('archived');
    expect(kinds).toContain('skipped_hold');
  });

  /**
   * The assertion the suite above was missing, and the reason a write-only soft
   * delete survived: every test here proved `archived_at` was *stamped*, and
   * none proved it was *read*. The sweep reported an archive, the action log
   * agreed, and the engagement stayed in the list the whole time.
   */
  it('takes an archived engagement out of the list, the count and the search', async () => {
    await ctx.app.inject({
      method: 'PUT',
      url: '/api/v1/admin/retention/policies/valuation',
      headers: authHeader(admin.token),
      payload: { archive_after_days: 365, retention_days: 730, enabled: true },
    });

    const gone = await agedValuation('VanishCo', 500);
    const stays = await agedValuation('RemainCo', 100);

    const list = async (query = '') => {
      const res = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/valuations${query}`,
        headers: authHeader(admin.token),
      });
      expect(res.statusCode).toBe(200);
      return res.json() as { valuations: { id: string }[]; total: number };
    };

    const before = await list();
    expect(before.valuations.map((v) => v.id)).toContain(gone.id);
    const totalBefore = before.total;

    await runRetentionSweep(ctx.pool);

    const after = await list();
    expect(after.valuations.map((v) => v.id)).not.toContain(gone.id);
    // Still listed, so this is the archive doing it and not an empty page.
    expect(after.valuations.map((v) => v.id)).toContain(stays.id);
    // The count is a separate query over the same WHERE builder; it drifted
    // from the page it paginates when only one of the two was filtered.
    expect(after.total).toBe(totalBefore - 1);

    // Search reaches the whole table rather than the page, so it is its own way
    // back to an archived row.
    const searched = await list('?q=VanishCo');
    expect(searched.valuations).toHaveLength(0);
    expect(searched.total).toBe(0);
  });

  it('releases a hold so the next sweep archives it', async () => {
    await ctx.app.inject({
      method: 'PUT',
      url: '/api/v1/admin/retention/policies/valuation',
      headers: authHeader(admin.token),
      payload: { archive_after_days: 365, retention_days: 730, enabled: true },
    });
    const v = await agedValuation('ReleaseCo', 500);
    const placed = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/admin/retention/holds',
      headers: authHeader(admin.token),
      payload: { scope: 'valuation', reference_id: v.id, reason: 'temp' },
    });
    const holdId = placed.json().hold.id;

    await runRetentionSweep(ctx.pool);
    expect(
      (await ctx.pool.query('SELECT archived_at FROM valuations WHERE id = $1', [v.id])).rows[0].archived_at,
    ).toBeNull();

    const rel = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/admin/retention/holds/${holdId}/release`,
      headers: authHeader(admin.token),
    });
    expect(rel.statusCode).toBe(200);

    await runRetentionSweep(ctx.pool);
    expect(
      (await ctx.pool.query('SELECT archived_at FROM valuations WHERE id = $1', [v.id])).rows[0].archived_at,
    ).not.toBeNull();
  });

  it('refuses a hold whose reference names nothing, rather than freezing nothing', async () => {
    await ctx.app.inject({
      method: 'PUT',
      url: '/api/v1/admin/retention/policies/valuation',
      headers: authHeader(admin.token),
      payload: { archive_after_days: 365, retention_days: 730, enabled: true },
    });

    const place = (payload: Record<string, unknown>) =>
      ctx.app.inject({
        method: 'POST',
        url: '/api/v1/admin/retention/holds',
        headers: authHeader(admin.token),
        payload,
      });

    // Malformed: the column is the `ulid` domain, so this used to reach
    // Postgres and come back as a bare 500.
    const malformed = await place({ scope: 'valuation', reference_id: 'not-a-ulid', reason: 'litigation' });
    expect(malformed.statusCode).toBe(422);
    expect(malformed.json().detail).toMatch(/reference_id/i);

    // Well-formed but naming no valuation: accepted before, and the sweep then
    // archived everything the admin believed was frozen.
    const ghost = await place({
      scope: 'valuation',
      reference_id: '01JZZZZZZZZZZZZZZZZZZZZZZZ',
      reason: 'litigation',
    });
    expect(ghost.statusCode).toBe(422);
    expect(ghost.json().detail).toMatch(/no valuation/i);

    const ghostUser = await place({
      scope: 'user',
      reference_id: '01JZZZZZZZZZZZZZZZZZZZZZZZ',
      reason: 'litigation',
    });
    expect(ghostUser.statusCode).toBe(422);
    expect(ghostUser.json().detail).toMatch(/no user/i);

    // Nothing was written, so nothing claims to be freezing anything.
    const holds = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/admin/retention/holds',
      headers: authHeader(admin.token),
    });
    const refs = holds.json().holds.map((h: { reference_id: string | null }) => h.reference_id);
    expect(refs).not.toContain('01JZZZZZZZZZZZZZZZZZZZZZZZ');

    // The real targets still work, on both scopes…
    const held = await agedValuation('RealHoldCo', 500);
    const loose = await agedValuation('NoHoldCo', 500);
    expect((await place({ scope: 'valuation', reference_id: held.id, reason: 'audit' })).statusCode).toBe(
      201,
    );
    expect((await place({ scope: 'user', reference_id: admin.id, reason: 'audit' })).statusCode).toBe(201);

    // …and the accepted hold actually freezes, which is the point. Asserted
    // before any global hold exists, so the freeze is attributable to this hold
    // and not to one that stops every sweep regardless.
    const archivedAt = async (id: string) =>
      (await ctx.pool.query('SELECT archived_at FROM valuations WHERE id = $1', [id])).rows[0].archived_at;
    await runRetentionSweep(ctx.pool);
    expect(await archivedAt(held.id)).toBeNull();
    // The user-scope hold covers everything this admin owns, `loose` included —
    // proof the second scope resolves too, from the same sweep.
    expect(await archivedAt(loose.id)).toBeNull();

    // A global hold still needs no reference at all.
    const globalHold = await place({ scope: 'global', reason: 'estate-wide freeze' });
    expect(globalHold.statusCode).toBe(201);
    // Released again so it does not silently freeze whatever runs after this.
    await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/admin/retention/holds/${globalHold.json().hold.id}/release`,
      headers: authHeader(admin.token),
    });
  });

  /**
   * The hold ledger only grows — holds are released, never deleted — so the
   * listing is a page. The property that has to survive the cap is that it
   * cannot hide a *live* hold behind a backlog of released ones, and that
   * nothing about enforcement depends on the list: the sweep checks
   * `legal_holds` in SQL, so a hold past the cut still freezes its valuation.
   */
  describe('bounded reads', () => {
    it('caps the ledger, says so, and keeps active holds ahead of released ones', async () => {
      const place = (reason: string) =>
        ctx.app.inject({
          method: 'POST',
          url: '/api/v1/admin/retention/holds',
          headers: authHeader(admin.token),
          payload: { scope: 'global', reason },
        });
      const release = (id: string) =>
        ctx.app.inject({
          method: 'POST',
          url: `/api/v1/admin/retention/holds/${id}/release`,
          headers: authHeader(admin.token),
        });

      // Two released holds placed *after* the live one, so newest-first alone
      // would push the live hold off a two-row page.
      const live = await place('live freeze');
      for (const reason of ['done a', 'done b']) {
        await release((await place(reason)).json().hold.id);
      }

      const list = (query = '') =>
        ctx.app.inject({
          method: 'GET',
          url: `/api/v1/admin/retention/holds${query}`,
          headers: authHeader(admin.token),
        });

      const page = (await list('?limit=1')).json();
      expect(page.holds).toHaveLength(1);
      expect(page.truncated).toBe(true);
      expect(page.holds[0].id).toBe(live.json().hold.id);
      expect(page.holds[0].active).toBe(true);

      const whole = (await list()).json();
      expect(whole.truncated).toBe(false);
      expect(whole.holds.length).toBeGreaterThan(1);

      // Released so it does not freeze whatever runs after this.
      await release(live.json().hold.id);
    });

    it('refuses a limit outside the ceiling rather than honouring it', async () => {
      for (const q of ['?limit=0', '?limit=100000']) {
        const res = await ctx.app.inject({
          method: 'GET',
          url: `/api/v1/admin/retention/holds${q}`,
          headers: authHeader(admin.token),
        });
        expect(res.statusCode).toBe(400);
      }
    });
  });

  it('gates retention admin to admins', async () => {
    const plain = await seedUser(ctx, { roles: ['valuation_user'] });
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/admin/retention/policies',
      headers: authHeader(plain.token),
    });
    expect(res.statusCode).toBe(403);
  });

  /**
   * The destructive half of this surface, attributed.
   *
   * Every governance decision above writes a spine row. `POST /retention/run`
   * archives engagements and purges outbox rows on the spot and wrote nothing —
   * and `retention_actions`, the ledger it does write, has no actor column at
   * all, because it was written for the six-hourly tick. So a sweep somebody
   * ran by hand and a sweep the clock ran left identical rows.
   */
  describe('a sweep run by hand', () => {
    const sweepEvents = async () => {
      const { rows } = await ctx.pool.query<{ actor_id: string | null; payload: Record<string, unknown> }>(
        `SELECT actor_id, payload FROM admin_events WHERE type = 'retention_sweep_run' ORDER BY occurred_at`,
      );
      return rows;
    };

    it('records who triggered it, and what it did', async () => {
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/admin/retention/run',
        headers: authHeader(admin.token),
      });
      expect(res.statusCode).toBe(200);

      const row = (await sweepEvents()).at(-1)!;
      expect(row.actor_id).toBe(admin.id);
      expect(row.payload.manual).toBe(true);
      expect(row.payload.outcome).toBe('completed');
      // The counts, so the row says what was destroyed rather than only that
      // somebody pressed the button.
      expect(row.payload).toHaveProperty('archived');
      expect(row.payload).toHaveProperty('purged');
      expect(row.payload).toHaveProperty('skipped_hold');
    });

    it('records the run that failed partway, which is the one a reviewer asks about', async () => {
      const before = (await sweepEvents()).length;
      const restore = interceptPoolQueries(ctx.pool, (sql, phase) => {
        if (phase !== 'before' || !sql.includes('FROM retention_policies')) return undefined;
        throw new Error('retention policies unreadable');
      });
      try {
        const res = await ctx.app.inject({
          method: 'POST',
          url: '/api/v1/admin/retention/run',
          headers: authHeader(admin.token),
        });
        expect(res.statusCode).toBe(500);
      } finally {
        restore();
      }

      const rows = await sweepEvents();
      expect(rows).toHaveLength(before + 1);
      expect(rows.at(-1)!.payload.outcome).toBe('failed');
      expect(rows.at(-1)!.actor_id).toBe(admin.id);
    });

    it('is refused, and records nothing, for a non-admin', async () => {
      const outsider = await seedUser(ctx, { roles: ['valuation_user'] });
      const before = (await sweepEvents()).length;
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/admin/retention/run',
        headers: authHeader(outsider.token),
      });
      expect(res.statusCode).toBe(403);
      expect(await sweepEvents()).toHaveLength(before);
    });
  });
});
