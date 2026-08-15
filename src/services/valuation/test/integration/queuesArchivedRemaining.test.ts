import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { newUlid } from '@n409/shared';
import { isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';
import {
  countUnfiledDocuments,
  listUnfiledDocuments,
} from '../../src/repos/documents.js';
import { listInbox, markAllRead, unreadThreadCount } from '../../src/repos/inbox.js';
import {
  findRerunnableBacksolves,
  listStaleBacksolves,
  listStaleQaReviews,
} from '../../src/repos/dataRemediation.js';

const dbUp = await isDbAvailable();

/**
 * The rest of the surfaces that build their own WHERE over `valuations` and so
 * never inherited the soft delete.
 *
 * None of these mails anybody, which is what separates them from the drip
 * campaigns, the monitor scan and the SLA sweep. They are lists and the numbers
 * printed beside them, and the failure is the one the firm console showed: a
 * count that disagrees with the list under it, or a queue offering an operator
 * work on an engagement the firm has withdrawn.
 *
 *   * the two remediation queues, whose "how many are affected" totals are
 *     counted with `count(*) OVER ()` and were overstated by every retired
 *     engagement that ever took the stale path — and whose re-run guard would
 *     have written a fresh calculation onto retired work;
 *   * the shared inbox, its unread badge and its "clear inbox" action, all
 *     three of which read through one scope fragment;
 *   * the legacy `uploads` re-filing queue and the count rendered above it.
 */
describe.skipIf(!dbUp)('the remaining queues drop retired engagements', () => {
  let ctx: TestApp;
  let pool: pg.Pool;
  let ops: Awaited<ReturnType<typeof seedUser>>;
  let owner: Awaited<ReturnType<typeof seedUser>>;

  let liveId: string;
  let retiredId: string;

  /** A valuation carrying one of everything the queues below look for. */
  async function seedQueueFodder(name: string): Promise<string> {
    const id = newUlid();
    await pool.query(
      `INSERT INTO valuations (id, kind, company_name, user_id, state)
       VALUES ($1, '409a', $2, $3, 'drafted')`,
      [id, name, owner.id],
    );

    // A stale single-breakpoint backsolve with a non-zero option pool.
    await pool.query(
      `INSERT INTO calculations
         (id, valuation_id, engine_version, status, inputs, results, created_by)
       VALUES ($1, $2, 't', 'succeeded', $3::jsonb, $4::jsonb, $5)`,
      [
        newUlid(),
        id,
        JSON.stringify({ inputs: { options_outstanding: 1000 } }),
        JSON.stringify({
          approaches: { opm_backsolve: { method: 'backsolve_single' } },
          discounts: { dlom_method: 'chaffee', dlom: 0.25 },
        }),
        ops.id,
      ],
    );
    const { rows: calc } = await pool.query<{ id: string }>(
      'SELECT id FROM calculations WHERE valuation_id = $1',
      [id],
    );
    // A QA review of that run with no dlom_range check — the second queue.
    await pool.query(
      `INSERT INTO qa_reviews (id, valuation_id, calculation_id, status, checks, created_by)
       VALUES ($1, $2, $3, 'pass', '[]'::jsonb, $4)`,
      [newUlid(), id, calc[0]!.id, ops.id],
    );
    // An uncategorised upload — the re-filing queue.
    await pool.query(
      `INSERT INTO documents
         (id, valuation_id, kind, category, filename, content_type, size_bytes, sha256, storage_path, uploaded_by)
       VALUES ($1, $2, 'other', 'uploads', 'scan.pdf', 'application/pdf', 10, $3, $4, $5)`,
      [newUlid(), id, newUlid(), `${id}/scan.pdf`, owner.id],
    );
    // A comment, so the engagement has an inbox thread.
    await pool.query(
      `INSERT INTO valuation_comments (id, valuation_id, author_id, kind, body)
       VALUES ($1, $2, $3, 'chat', 'anyone there?')`,
      [newUlid(), id, owner.id],
    );
    return id;
  }

  beforeAll(async () => {
    ctx = await setupTestApp({ AUTO_PIPELINE: 'off', EMAIL_MODE: 'off' });
    pool = ctx.pool;
    ops = await seedUser(ctx, { roles: ['reviewer'] });
    owner = await seedUser(ctx, { roles: ['valuation_user'] });

    liveId = await seedQueueFodder('Queue Live Inc');
    retiredId = await seedQueueFodder('Queue Retired Inc');
    await pool.query('UPDATE valuations SET archived_at = now() WHERE id = $1', [retiredId]);
  });
  afterAll(async () => ctx?.teardown());

  it('drops the retired engagement from the stale-backsolve queue and its total', async () => {
    const page = await listStaleBacksolves(pool, {});
    const ids = page.rows.map((r) => r.valuation_id);
    expect(ids).toContain(liveId);
    expect(ids).not.toContain(retiredId);
    // The total is the figure the queue exists to report, so it has to move too.
    expect(page.total).toBe(ids.length);
  });

  it('drops the retired engagement from the stale-QA queue and its total', async () => {
    const page = await listStaleQaReviews(pool, {});
    const ids = page.rows.map((r) => r.valuation_id);
    expect(ids).toContain(liveId);
    expect(ids).not.toContain(retiredId);
    expect(page.total).toBe(ids.length);
  });

  it('refuses to re-run a retired engagement even when it is asked for by id', async () => {
    // The guard is scoped to the ids handed to it rather than to a page of the
    // queue, so it has to carry the rule independently.
    const rerunnable = await findRerunnableBacksolves(pool, [liveId, retiredId]);
    expect(rerunnable.has(liveId)).toBe(true);
    expect(rerunnable.has(retiredId)).toBe(false);
  });

  it('keeps the retired engagement out of the inbox, its badge and clear-all', async () => {
    const inbox = await listInbox(pool, principal(), { page: 1, perPage: 50 });
    const ids = inbox.items.map((i) => i.valuation_id);
    expect(ids).toContain(liveId);
    expect(ids).not.toContain(retiredId);
    // The badge and the list must agree — a count above a list it does not
    // match is the firm-console bug.
    expect(inbox.total).toBe(ids.length);
    expect(await unreadThreadCount(pool, principal())).toBe(1);

    // "Clear inbox" reaches exactly what the inbox showed, and no further.
    expect(await markAllRead(pool, principal())).toBe(1);
    expect(await unreadThreadCount(pool, principal())).toBe(0);
  });

  it('drops the retired engagement from the re-filing queue and its count', async () => {
    const rows = await listUnfiledDocuments(pool);
    const ids = rows.map((r) => r.valuation_id);
    expect(ids).toContain(liveId);
    expect(ids).not.toContain(retiredId);
    expect(await countUnfiledDocuments(pool)).toBe(rows.length);
  });

  /** The ops principal, rebuilt per call because markAllRead consumes reads. */
  function principal() {
    return { id: ops.id, roles: ['reviewer'] as const, partnerId: null } as never;
  }
});
