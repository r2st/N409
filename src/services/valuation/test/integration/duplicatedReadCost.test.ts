import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { newUlid } from '@n409/shared';
import { authHeader, isDbAvailable, seedPartner, seedUser, setupTestApp, type TestApp } from './helpers.js';
import { firmSummary } from '../../src/repos/firmDashboard.js';

const dbUp = await isDbAvailable();

/**
 * Two answers that were paying twice for one question.
 *
 * `listQueryScaling.test.ts` asks whether an endpoint's statement count grows
 * with the *collection*; both defects here are invisible to that, because
 * neither grows with anything — one is a constant second scan, and the other is
 * the same constant query repeated once per caller. A ratio cannot see either.
 * So this measures the absolute count, which is only safe to pin because both
 * numbers are argued for rather than merely observed: the firm header is one
 * pass because every figure in it is a tally of the same rows, and the badge is
 * one query per TTL because that is what a cache means.
 */

/** Statements issued through the pool, as `batchedReads` and the scaling guard tap them. */
function tapQueries(pool: pg.Pool): { statements: string[]; restore: () => void } {
  const statements: string[] = [];
  const original = pool.query.bind(pool);
  const patched = (...args: unknown[]) => {
    const first = args[0];
    const text = typeof first === 'string' ? first : ((first as { text?: string })?.text ?? '');
    statements.push(text.replace(/\s+/g, ' ').trim());
    return (original as (...a: unknown[]) => unknown)(...args);
  };
  (pool as unknown as { query: unknown }).query = patched;
  return {
    statements,
    restore: () => {
      (pool as unknown as { query: unknown }).query = original;
    },
  };
}

const daysFromNow = (days: number) => new Date(Date.now() + days * 86_400_000);

describe.skipIf(!dbUp)('the firm header reads the book once', () => {
  let ctx: TestApp;
  let firmId: string;
  let firmAdmin: { id: string; token: string };
  let reviewer: { id: string };

  const seedValuation = async (args: {
    company: string;
    state?: string;
    dueDate?: Date | null;
    waiting?: boolean;
    reviewerId?: string | null;
  }) => {
    await ctx.pool.query(
      `INSERT INTO valuations
         (id, kind, company_name, user_id, partner_id, state, due_date, waiting_on_client,
          assigned_reviewer_id, created_at, published_at)
       VALUES ($1, '409a', $2, $3, $4, $5, $6, $7, $8, now(), $9)`,
      [
        newUlid(),
        args.company,
        firmAdmin.id,
        firmId,
        args.state ?? 'review',
        args.dueDate === undefined ? daysFromNow(30) : args.dueDate,
        args.waiting ?? false,
        args.reviewerId ?? null,
        args.state === 'published' ? new Date() : null,
      ],
    );
  };

  beforeAll(async () => {
    ctx = await setupTestApp();
    firmId = await seedPartner(ctx, 'Single Scan Advisory');
    firmAdmin = await seedUser(ctx, { roles: ['partner'], partnerId: firmId });
    reviewer = await seedUser(ctx, { roles: ['reviewer'] });

    // A spread that lights up every field independently: the overdue one is
    // not the waiting one, the unassigned ones are not the published one, and
    // `due_soon` is separated from `overdue` by the sign of the interval.
    await seedValuation({ company: 'Overdue Co', dueDate: daysFromNow(-5), reviewerId: reviewer.id });
    await seedValuation({ company: 'Due Soon Co', dueDate: daysFromNow(3), reviewerId: reviewer.id });
    await seedValuation({ company: 'Waiting Co', waiting: true, reviewerId: reviewer.id });
    await seedValuation({ company: 'Unassigned Co', state: 'review', reviewerId: null });
    await seedValuation({ company: 'Drafted Co', state: 'drafted', reviewerId: null });
    await seedValuation({ company: 'Open Co', state: 'pending', reviewerId: reviewer.id });
    await seedValuation({ company: 'Published Co', state: 'published', reviewerId: reviewer.id });
    await seedValuation({ company: 'Cancelled Co', state: 'cancelled', reviewerId: reviewer.id });
    // Archived rows must not reach any figure — the same rule the rest of this
    // file's queries carry.
    await ctx.pool.query(
      `INSERT INTO valuations (id, kind, company_name, user_id, partner_id, state, archived_at)
       VALUES ($1, '409a', 'Retired Co', $2, $3, 'review', now())`,
      [newUlid(), firmAdmin.id, firmId],
    );
  }, 120_000);
  afterAll(async () => ctx?.teardown());

  it('issues one statement, not one per breakdown', async () => {
    const tap = tapQueries(ctx.pool);
    try {
      await firmSummary(ctx.pool, firmId, 7);
    } finally {
      tap.restore();
    }
    // The defect this pins: the eight headline counts and the by-state
    // breakdown were two passes over `valuations` under an identical WHERE.
    expect(tap.statements).toHaveLength(1);
    expect(tap.statements[0]).toMatch(/GROUP BY state/);
  });

  it('reports what the two-query version reported', async () => {
    const summary = await firmSummary(ctx.pool, firmId, 7);

    // 8 live rows; the archived one is absent from the total and from by_state.
    expect(summary.total).toBe(8);
    // open + in_review + drafted: pending, drafted, and the five `review` rows.
    expect(summary.active).toBe(6);
    expect(summary.published).toBe(1);
    expect(summary.closed).toBe(1);
    expect(summary.waiting_on_client).toBe(1);
    expect(summary.overdue).toBe(1);
    expect(summary.due_soon).toBe(1);
    // Unassigned counts only in_review + drafted — never the open or published
    // rows, which is the one predicate that differs from `active`.
    expect(summary.unassigned).toBe(2);
    expect(summary.by_state).toEqual({
      review: 4,
      drafted: 1,
      pending: 1,
      published: 1,
      cancelled: 1,
    });
  });

  it('keeps every figure inside the by_state breakdown it ships beside', async () => {
    // The invariant that makes the fold checkable without restating it: the
    // headline groups partition the same rows the breakdown counts, so they
    // must add to the same total. A fold that filed a state under the wrong
    // set would satisfy `total` and break this.
    const summary = await firmSummary(ctx.pool, firmId, 7);
    const fromBreakdown = Object.values(summary.by_state).reduce((a, b) => a + b, 0);
    expect(fromBreakdown).toBe(summary.total);
    expect(summary.active + summary.published + summary.closed).toBe(summary.total);
  });

  it('answers a firm with an empty book with zeros rather than nothing', async () => {
    // The fold starts from a zeroed record; a rewrite that built the object
    // from the rows would return `{}` here and put `undefined` on the dashboard.
    const empty = await seedPartner(ctx, 'No Engagements LLP');
    const summary = await firmSummary(ctx.pool, empty, 7);
    expect(summary).toEqual({
      total: 0,
      active: 0,
      published: 0,
      closed: 0,
      waiting_on_client: 0,
      overdue: 0,
      due_soon: 0,
      unassigned: 0,
      by_state: {},
    });
  });
});

describe.skipIf(!dbUp)('the nav badge answers a poll burst once', () => {
  let ctx: TestApp;
  let admin: { id: string; token: string };
  let admin2: { id: string; token: string };
  let client: { id: string; token: string };
  let other: { id: string; token: string };

  /** The badge query, told apart from the auth read that precedes every request. */
  const badgeReads = (statements: string[]) =>
    statements.filter((s) => /count\(DISTINCT c\.valuation_id\)/.test(s));

  const badge = async (token: string): Promise<number> => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/inbox/unread-count',
      headers: authHeader(token),
    });
    expect(res.statusCode).toBe(200);
    return res.json().unread_threads as number;
  };

  const createValuation = async (token: string, company: string): Promise<string> => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/valuations',
      headers: authHeader(token),
      payload: { kind: '409a', company_name: company },
    });
    expect(res.statusCode).toBe(201);
    return res.json().valuation.id as string;
  };

  const comment = async (token: string, valuationId: string, body: string) => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${valuationId}/comments`,
      headers: authHeader(token),
      payload: { kind: 'chat', body },
    });
    expect(res.statusCode).toBe(201);
  };

  beforeAll(async () => {
    ctx = await setupTestApp();
    admin = await seedUser(ctx, { roles: ['admin'] });
    // A second operator, because two ops principals are the pair that shares a
    // `valuationScope` — `{ kind: 'all' }` for both — and so the only pair a
    // reader-blind cache key would actually collide. Two `valuation_user`s
    // cannot demonstrate it: their scope is `{ kind: 'own', userId }`, which
    // carries the reader already. This is the collision migration 0113 was
    // written for, where "two operators share one badge and it goes stale for
    // both at once".
    admin2 = await seedUser(ctx, { roles: ['admin'] });
    client = await seedUser(ctx, { roles: ['valuation_user'] });
    other = await seedUser(ctx, { roles: ['valuation_user'] });

    // Two engagements the client owns and one the other user owns, so the
    // three readers genuinely differ: admin sees all three threads, the client
    // sees two, and `other` sees one.
    const a = await createValuation(client.token, 'Badge Alpha');
    const b = await createValuation(client.token, 'Badge Beta');
    const c = await createValuation(other.token, 'Badge Gamma');
    await comment(admin.token, a, 'First note.');
    await comment(admin.token, b, 'Second note.');
    await comment(admin.token, c, 'Third note.');
  }, 120_000);
  afterAll(async () => ctx?.teardown());

  it('issues one query for a burst of identical polls', async () => {
    // Every AppLayout badge poll carries `location.pathname` in its effect
    // dependencies, so a client-side navigation re-fires it immediately —
    // the burst this absorbs is navigation and open tabs, not the 60s timer.
    const tap = tapQueries(ctx.pool);
    try {
      for (let i = 0; i < 5; i += 1) await badge(admin.token);
    } finally {
      tap.restore();
    }
    expect(badgeReads(tap.statements)).toHaveLength(1);
  });

  it('gives each reader their own count and not the last caller’s', async () => {
    // The cache-key test, and the one that matters: this endpoint is scoped
    // three ways at once — the scope clause, the read-mark join and the
    // visible-kind filter — and a key missing any of them serves one reader
    // another reader's number rather than merely a stale one.
    expect(await badge(admin.token)).toBe(3);
    expect(await badge(client.token)).toBe(2);
    expect(await badge(other.token)).toBe(1);

    // And again, now that all three are cached — a key collision would show up
    // on the second pass, once every entry is warm.
    expect(await badge(admin.token)).toBe(3);
    expect(await badge(client.token)).toBe(2);
    expect(await badge(other.token)).toBe(1);

    // The two operators: same scope, same visible kinds, different read state.
    // `admin2` clears one thread, so the two badges must diverge — and they can
    // only diverge if the key carries the reader.
    const threads = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/inbox',
      headers: authHeader(admin2.token),
    });
    expect(threads.statusCode).toBe(200);
    const read = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/inbox/read',
      headers: authHeader(admin2.token),
      payload: { valuation_id: threads.json().items[0].valuation_id },
    });
    expect(read.statusCode).toBe(200);

    expect(await badge(admin2.token)).toBe(2);
    expect(await badge(admin.token)).toBe(3);
  });

  it('drops the badge the moment the reader clears a thread', async () => {
    const before = await badge(client.token);
    expect(before).toBe(2);

    const threads = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/inbox',
      headers: authHeader(client.token),
    });
    expect(threads.statusCode).toBe(200);
    const valuationId = threads.json().items[0].valuation_id as string;

    const read = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/inbox/read',
      headers: authHeader(client.token),
      payload: { valuation_id: valuationId },
    });
    expect(read.statusCode).toBe(200);

    // Not "eventually, within the TTL" — the reader clicked and is watching
    // the number. A cache without this invalidation leaves it sitting there
    // for fifteen seconds, which reads as a write that failed.
    expect(await badge(client.token)).toBe(1);
  });

  it('clears the badge on read-all rather than leaving a number behind', async () => {
    expect(await badge(other.token)).toBe(1);
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/inbox/read-all',
      headers: authHeader(other.token),
    });
    expect(res.statusCode).toBe(200);
    expect(await badge(other.token)).toBe(0);
  });

  it('still counts a thread that moves after the reader cleared it', async () => {
    // The cache must not outlive its own invalidation: `other` cleared their
    // inbox above, so the entry is a fresh zero. A new comment has to be able
    // to put the badge back up once the TTL turns over — this asserts the
    // *repo* still sees it, so a passing badge of 0 is a TTL artefact and not
    // a lost thread.
    const gamma = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/inbox',
      headers: authHeader(other.token),
    });
    const valuationId = gamma.json().items[0].valuation_id as string;
    await comment(admin.token, valuationId, 'One more thing.');

    const { unreadThreadCount } = await import('../../src/repos/inbox.js');
    const principal = { id: other.id, roles: ['valuation_user' as const], partnerId: null };
    expect(await unreadThreadCount(ctx.pool, principal)).toBe(1);
  });
});
