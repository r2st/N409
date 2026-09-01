import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newUlid } from '@n409/shared';
import { activateTemplate, createTemplateVersion, listTemplates } from '../../src/repos/reportTemplates.js';
import { isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';

const dbUp = await isDbAvailable();

/**
 * Report-template version allocation under concurrency.
 *
 * `report_templates` is keyed `UNIQUE (name, version)`, and the next version
 * used to be picked with
 *
 *     SELECT version ... WHERE name = $1 ORDER BY version DESC LIMIT 1 FOR UPDATE
 *
 * immediately before the insert, which serializes neither case.
 *
 * A brand-new name returns no rows, so there is nothing to lock and no gap lock
 * in Postgres to stand in for the missing row: every concurrent create reads
 * "no versions" and picks v1.
 *
 * An existing name is no better. `FOR UPDATE` locks the single row `LIMIT 1`
 * returned, and a waiter that blocks on it re-evaluates *that row* once the
 * lock clears — not the query — so it never sees the higher version the other
 * transaction inserted in the meantime, and picks the same next number.
 *
 * Either way the unique index rejects every writer but the winner. The route
 * has no handler for that, so the losers surface as 500s — which is what an ops
 * admin gets from a double-clicked "New template" button, or from two people
 * setting up the same template name at once.
 *
 * A transaction-scoped advisory lock on the name serializes the read and the
 * insert together whether or not the name already exists.
 */
describe.skipIf(!dbUp)('report template versioning under concurrency', () => {
  let ctx: TestApp;
  let ops: Awaited<ReturnType<typeof seedUser>>;

  beforeAll(async () => {
    ctx = await setupTestApp();
    ops = await seedUser(ctx, { roles: ['admin'] });
  });
  afterAll(async () => ctx?.teardown());

  const freshName = () => `tpl_${newUlid().toLowerCase().slice(-12)}`;

  it('gives every concurrent create of a brand-new name its own version', async () => {
    const name = freshName();
    // Four, not more: the test pool caps at 5 connections and each create
    // holds one for the length of its transaction.
    const created = await Promise.all(
      Array.from({ length: 4 }, () =>
        createTemplateVersion(ctx.pool, { name, kind: '409a', createdBy: ops.id }),
      ),
    );

    expect(created.map((t) => t.version).sort((a, b) => a - b)).toEqual([1, 2, 3, 4]);
    expect(new Set(created.map((t) => t.id)).size).toBe(4);

    const { templates: persisted } = await listTemplates(ctx.pool, { name });
    expect(persisted.map((t) => t.version).sort((a, b) => a - b)).toEqual([1, 2, 3, 4]);
  });

  it('keeps doing so once the name exists', async () => {
    const name = freshName();
    const first = await createTemplateVersion(ctx.pool, { name, kind: '409a', createdBy: ops.id });
    expect(first.version).toBe(1);

    const created = await Promise.all(
      Array.from({ length: 4 }, () =>
        createTemplateVersion(ctx.pool, { name, kind: '409a', createdBy: ops.id }),
      ),
    );
    expect(created.map((t) => t.version).sort((a, b) => a - b)).toEqual([2, 3, 4, 5]);
  });

  it('serializes per name, so unrelated names each start at v1', async () => {
    const names = Array.from({ length: 4 }, freshName);
    const created = await Promise.all(
      names.map((name) => createTemplateVersion(ctx.pool, { name, kind: '409a', createdBy: ops.id })),
    );
    expect(created.map((t) => t.version)).toEqual([1, 1, 1, 1]);
    expect(created.map((t) => t.name).sort()).toEqual([...names].sort());
  });

  it('mints a version per request when the route is hit concurrently', async () => {
    const name = freshName();
    const responses = await Promise.all(
      Array.from({ length: 4 }, () =>
        ctx.app.inject({
          method: 'POST',
          url: '/api/v1/report-templates',
          headers: { authorization: `Bearer ${ops.token}` },
          payload: { name, kind: '409a' },
        }),
      ),
    );

    // Every one a 201 — under the race the losers came back 500.
    expect(responses.map((r) => r.statusCode)).toEqual([201, 201, 201, 201]);
    const labels = responses.map((r) => r.json().template.label as string);
    expect(new Set(labels).size).toBe(4);
    expect([...labels].sort()).toEqual([1, 2, 3, 4].map((v) => `${name}.v${v}`).sort());
  });
});

/**
 * Activation of one name is also a per-name operation, and locking the target
 * row does not make it one.
 *
 * `activateTemplate` locks the version being activated, archives whichever
 * version of the name was active, then flips its own row to active. Two
 * concurrent activations of *different* versions of the same name lock two
 * different rows, so neither waits: both archive (the second finding the first
 * already did it) and both set themselves active. The partial unique index
 * `report_templates_one_active_per_name` is the only thing left standing
 * between that and two live templates for one name, and it stops it the only
 * way it can — by failing the loser's transaction, which the route surfaces as
 * a 500.
 *
 * Serializing on the name means the second activation sees the first one's
 * result and archives it properly.
 */
describe.skipIf(!dbUp)('report template activation under concurrency', () => {
  let ctx: TestApp;
  let ops: Awaited<ReturnType<typeof seedUser>>;

  beforeAll(async () => {
    ctx = await setupTestApp();
    ops = await seedUser(ctx, { roles: ['admin'] });
  });
  afterAll(async () => ctx?.teardown());

  const freshName = () => `act_${newUlid().toLowerCase().slice(-12)}`;

  /** Somebody is stopped on a lock — see `measurementLinkRace.test.ts`. */
  const waitForABlockedBackend = async (): Promise<void> => {
    const deadline = Date.now() + 5000;
    for (;;) {
      const { rows } = await ctx.pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM pg_stat_activity
          WHERE datname = current_database() AND wait_event_type = 'Lock'
            AND pid <> pg_backend_pid()`,
      );
      if ((rows[0]?.n ?? 0) > 0) return;
      if (Date.now() >= deadline) throw new Error('no backend ever blocked on the template name');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };

  /** Rows of `name`, by version, as `{version: status}`. */
  async function statuses(name: string): Promise<Record<number, string>> {
    const { templates: rows } = await listTemplates(ctx.pool, { name });
    return Object.fromEntries(rows.map((r) => [r.version, r.status]));
  }

  it('leaves exactly one version active when three are activated at once', async () => {
    const name = freshName();
    const versions = [];
    for (let i = 0; i < 3; i++) {
      versions.push(await createTemplateVersion(ctx.pool, { name, kind: '409a', createdBy: ops.id }));
    }

    const settled = await Promise.allSettled(versions.map((v) => activateTemplate(ctx.pool, v.id)));
    // Under the race the losers rejected with a unique violation on
    // report_templates_one_active_per_name.
    expect(settled.map((s) => s.status)).toEqual(['fulfilled', 'fulfilled', 'fulfilled']);

    const byVersion = await statuses(name);
    const active = Object.entries(byVersion).filter(([, s]) => s === 'active');
    expect(active).toHaveLength(1);
    // Everything that was not the winner is archived history, never left draft.
    expect(Object.values(byVersion).filter((s) => s === 'archived')).toHaveLength(2);
  });

  it('is idempotent when the same version is activated concurrently', async () => {
    const name = freshName();
    const v1 = await createTemplateVersion(ctx.pool, { name, kind: '409a', createdBy: ops.id });

    const settled = await Promise.allSettled(
      Array.from({ length: 4 }, () => activateTemplate(ctx.pool, v1.id)),
    );
    expect(settled.every((s) => s.status === 'fulfilled')).toBe(true);
    expect(await statuses(name)).toEqual({ 1: 'active' });
  });

  it('answers every concurrent activate request over the route', async () => {
    const name = freshName();
    const versions = [];
    for (let i = 0; i < 3; i++) {
      versions.push(await createTemplateVersion(ctx.pool, { name, kind: '409a', createdBy: ops.id }));
    }

    const responses = await Promise.all(
      versions.map((v) =>
        ctx.app.inject({
          method: 'POST',
          url: `/api/v1/report-templates/${v.id}/activate`,
          headers: { authorization: `Bearer ${ops.token}` },
        }),
      ),
    );
    expect(responses.map((r) => r.statusCode)).toEqual([200, 200, 200]);

    const byVersion = await statuses(name);
    expect(Object.values(byVersion).filter((s) => s === 'active')).toHaveLength(1);
  });

  /**
   * The predicate the lock was not re-checking.
   *
   * The activate route refuses an archived version on the pool, one statement
   * before `activateTemplate` opens its transaction; the lock inside it was
   * added for the two-versions-at-once race and asked only whether the target
   * was already active. So an archive committing in the window walked through
   * a refusal that had already been made — and an activation does not merely
   * restore its own row, it archives whichever version of the name is live, so
   * the withdrawn skeleton came back and took the intended one down with it.
   */
  it('refuses to re-activate a version archived while the request was in flight', async () => {
    const name = freshName();
    const v1 = await createTemplateVersion(ctx.pool, { name, kind: '409a', createdBy: ops.id });
    const v2 = await createTemplateVersion(ctx.pool, { name, kind: '409a', createdBy: ops.id });
    await activateTemplate(ctx.pool, v1.id);

    const holder = await ctx.pool.connect();
    let inFlight: ReturnType<typeof ctx.app.inject> | null = null;
    try {
      // The competing archive of v1, in flight and not yet committed. It holds
      // the name's advisory lock, which is what the activation queues on.
      await holder.query('BEGIN');
      await holder.query('SELECT pg_advisory_xact_lock($1, hashtext($2))', [0x74706c6, name]);
      await holder.query(
        `UPDATE report_templates SET status = 'archived', updated_at = now() WHERE id = $1`,
        [v1.id],
      );
      // v2 takes v1's place, so this is not "the name has no active version"
      // but the ordinary replacement an operator performs.
      await holder.query(`UPDATE report_templates SET status = 'active', updated_at = now() WHERE id = $1`, [
        v2.id,
      ]);

      // The route reads v1 as 'active' — the archive is uncommitted — passes
      // its own check, and stops on the name lock inside the repo.
      inFlight = ctx.app.inject({
        method: 'POST',
        url: `/api/v1/report-templates/${v1.id}/activate`,
        headers: { authorization: `Bearer ${ops.token}` },
      });
      await waitForABlockedBackend();
      await holder.query('COMMIT');
    } finally {
      holder.release();
    }

    expect((await inFlight!).statusCode).toBe(409);
    // v2 is still the live skeleton: the refused activation did not archive it
    // on its way to restoring v1.
    expect(await statuses(name)).toEqual({ 1: 'archived', 2: 'active' });
  });

  /**
   * The archive is the other half of the activation's invariant, and it took no
   * lock at all (R320, methodology M3).
   *
   * The test above stages the competing archive *holding the name lock*,
   * because that is the only way the interleaving it describes is safe. The
   * real `POST /:id/archive` did not take it: one statement on the pool, no
   * transaction. So it could land in the middle of an activation's two writes —
   * incumbent archived, promotion not yet written — and the promotion then set
   * active the very version the operator had just retired. Their archive
   * answered 200 and the version they retired is the skeleton every new report
   * of that kind is built from.
   *
   * Under the lock both orderings are answers: here the archive queues behind
   * the activation and retires what it promoted, leaving the name with no
   * active version, which is a state ops is allowed to ask for.
   */
  it('makes an archive wait for an activation of the same name', async () => {
    const name = freshName();
    const v1 = await createTemplateVersion(ctx.pool, { name, kind: '409a', createdBy: ops.id });
    const v2 = await createTemplateVersion(ctx.pool, { name, kind: '409a', createdBy: ops.id });
    await activateTemplate(ctx.pool, v1.id);

    const holder = await ctx.pool.connect();
    let inFlight: ReturnType<typeof ctx.app.inject> | null = null;
    try {
      // An activation of v2, mid-flight: the name lock taken, the incumbent
      // archived, the promotion not yet written.
      await holder.query('BEGIN');
      await holder.query('SELECT pg_advisory_xact_lock($1, hashtext($2))', [0x74706c6, name]);
      await holder.query(
        `UPDATE report_templates SET status = 'archived', updated_at = now()
          WHERE name = $1 AND status = 'active'`,
        [name],
      );

      inFlight = ctx.app.inject({
        method: 'POST',
        url: `/api/v1/report-templates/${v2.id}/archive`,
        headers: { authorization: `Bearer ${ops.token}` },
      });
      // Fails outright without the lock: the archive would already have
      // committed by now, and no backend ever blocks.
      await waitForABlockedBackend();

      await holder.query(`UPDATE report_templates SET status = 'active', updated_at = now() WHERE id = $1`, [
        v2.id,
      ]);
      await holder.query('COMMIT');
    } finally {
      holder.release();
    }

    expect((await inFlight!).statusCode).toBe(200);
    // The archive ran after the whole activation, so what it retired is what
    // the activation promoted — not a version left live behind its back.
    expect(await statuses(name)).toEqual({ 1: 'archived', 2: 'archived' });
  });

  it('does not re-stamp a version that is already archived', async () => {
    // `updated_at` and the `template_archived` trail line are the whole record
    // of who retired a skeleton and when, and the admin screen lists archived
    // versions with the control still on them.
    const name = freshName();
    const v1 = await createTemplateVersion(ctx.pool, { name, kind: '409a', createdBy: ops.id });
    const archive = () =>
      ctx.app.inject({
        method: 'POST',
        url: `/api/v1/report-templates/${v1.id}/archive`,
        headers: { authorization: `Bearer ${ops.token}` },
      });
    expect((await archive()).statusCode).toBe(200);
    const first = await ctx.pool.query<{ updated_at: Date }>(
      'SELECT updated_at FROM report_templates WHERE id = $1',
      [v1.id],
    );

    expect((await archive()).statusCode).toBe(200);
    const second = await ctx.pool.query<{ updated_at: Date }>(
      'SELECT updated_at FROM report_templates WHERE id = $1',
      [v1.id],
    );
    expect(second.rows[0]!.updated_at).toEqual(first.rows[0]!.updated_at);
  });

  it('keeps activations of different names independent', async () => {
    const names = Array.from({ length: 3 }, freshName);
    const rows = [];
    for (const name of names) {
      rows.push(await createTemplateVersion(ctx.pool, { name, kind: '409a', createdBy: ops.id }));
    }

    await Promise.all(rows.map((r) => activateTemplate(ctx.pool, r.id)));
    for (const name of names) expect(await statuses(name)).toEqual({ 1: 'active' });
  });
});
