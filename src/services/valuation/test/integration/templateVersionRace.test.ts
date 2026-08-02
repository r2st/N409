import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newUlid } from '@n409/shared';
import { createTemplateVersion, listTemplates } from '../../src/repos/reportTemplates.js';
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

    const persisted = await listTemplates(ctx.pool, { name });
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
