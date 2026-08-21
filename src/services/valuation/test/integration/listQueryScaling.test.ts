import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { authHeader, isDbAvailable, seedPartner, seedUser, setupTestApp, type TestApp } from './helpers.js';

const dbUp = await isDbAvailable();

/**
 * Every collection endpoint costs the same number of statements whatever the
 * collection holds.
 *
 * `batchedReads.test.ts` pins the three request paths whose N+1 was found and
 * batched, by name and by statement shape. That is the regression guard for
 * three known bugs; it says nothing about the fortieth list endpoint somebody
 * adds next month. This is the population guard beside it — the same argument
 * R91 made for the sweep census: a check phrased "these known cases are fine"
 * only catches regressions in those cases, and one phrased "account for every
 * one" catches the additions its author never imagined.
 *
 * The measurement is a ratio, not a count. Each endpoint is called once with a
 * few rows behind it and once with four times as many, and the second call may
 * not issue *more* statements than the first. Deliberately not "issues exactly
 * two": endpoints legitimately differ — one does a count and a page, another
 * folds both into a window function, a third reads a settings row first — and
 * pinning absolute numbers here would turn every honest refactor into a failing
 * test while still missing the loop that runs once per row.
 *
 * The inequality is `<=` rather than `===` because a cached read is a *fall*:
 * `/api/v1/valuations/counts` and `/api/v1/stats/dashboard` both warm a TTL
 * cache on the first call, and the second call is cheaper. A drop is never the
 * bug this is looking for.
 *
 * `pool.query` is the seam, as in `batchedReads.test.ts`: reads go through the
 * pool, and writes on a checked-out transaction client are invisible to it —
 * which is the right cut for GET routes.
 */

interface QueryTap {
  statements: string[];
  restore: () => void;
}

function tapQueries(pool: pg.Pool): QueryTap {
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

/**
 * The collection endpoints, as `[label, url]`. `:partner` is substituted with
 * the seeded firm so the firm console — which is partner-scoped and answers
 * 400 to an ops caller without one — is measured rather than skipped.
 */
const ENDPOINTS: Array<[string, string]> = [
  ['valuations', '/api/v1/valuations?per_page=50'],
  ['valuations (sorted)', '/api/v1/valuations?per_page=50&sort=company_name:asc'],
  ['valuations counts', '/api/v1/valuations/counts'],
  ['valuations export', '/api/v1/valuations/export'],
  ['engagements', '/api/v1/engagements?per_page=50'],
  ['inbox', '/api/v1/inbox?per_page=50'],
  ['tasks', '/api/v1/tasks'],
  ['reviews', '/api/v1/reviews'],
  ['search', '/api/v1/search?q=Scaling'],
  ['stats dashboard', '/api/v1/stats/dashboard'],
  ['firm dashboard', '/api/v1/firm/dashboard?partner_id=:partner'],
  ['firm clients', '/api/v1/firm/clients?partner_id=:partner'],
  ['firm attention', '/api/v1/firm/attention?partner_id=:partner'],
  ['partner valuations', '/api/v1/partners/:partner/valuations'],
  ['organizations', '/api/v1/organizations'],
  ['monitors', '/api/v1/monitors'],
  ['notifications', '/api/v1/notifications'],
  ['saved views', '/api/v1/saved-views'],
  ['funds', '/api/v1/funds'],
  ['debt instruments', '/api/v1/debt/instruments'],
  ['report templates', '/api/v1/report-templates'],
  ['blog posts', '/api/v1/blog/posts'],
  ['help articles', '/api/v1/help/articles'],
  ['support messages', '/api/v1/support/messages'],
  ['contact submissions', '/api/v1/contact/submissions'],
  ['users', '/api/v1/users'],
  ['user invitations', '/api/v1/users/invitations'],
  ['partners', '/api/v1/partners'],
  ['admin events', '/api/v1/admin/events'],
  ['admin jobs', '/api/v1/admin/jobs'],
  ['admin job alerts', '/api/v1/admin/jobs/alerts'],
  ['admin email outbox', '/api/v1/admin/email-outbox'],
  ['admin email suppressions', '/api/v1/admin/email/suppressions'],
  ['admin email delivery stats', '/api/v1/admin/email/delivery-stats'],
  ['admin document triage', '/api/v1/admin/documents/triage'],
  ['admin data remediation', '/api/v1/admin/data-remediation'],
  ['admin retention actions', '/api/v1/admin/retention/actions'],
  ['admin retention holds', '/api/v1/admin/retention/holds'],
  ['admin retired valuations', '/api/v1/admin/retention/valuations/retired'],
  ['admin prompts', '/api/v1/admin/prompts'],
  ['admin narrative prompts', '/api/v1/admin/narrative-prompts'],
  ['admin auto-emails', '/api/v1/admin/auto-emails'],
  ['admin communication templates', '/api/v1/admin/communication-templates'],
  ['admin api tokens', '/api/v1/admin/api-tokens'],
  ['admin webhook delivery stats', '/api/v1/admin/webhooks/deliveries/stats'],
  ['admin failed webhook deliveries', '/api/v1/admin/webhooks/deliveries/failed'],
  ['admin system metrics', '/api/v1/admin/system/metrics'],
];

/** Rows behind the first measurement, and the multiple behind the second. */
const SEED_ROWS = 4;
const GROWTH = 4;

describe.skipIf(!dbUp)('collection endpoints do not scale their statement count with the collection', () => {
  let ctx: TestApp;
  let ops: { id: string; token: string };
  let partnerId: string;
  let firmUser: { id: string; token: string };

  beforeAll(async () => {
    ctx = await setupTestApp();
    ops = await seedUser(ctx, { roles: ['admin'] });
    partnerId = await seedPartner(ctx, 'Scaling Firm');
    firmUser = await seedUser(ctx, { roles: ['partner'], partnerId });
  }, 120_000);
  afterAll(async () => ctx?.teardown());

  async function seedValuations(n: number, tag: string): Promise<void> {
    for (let i = 0; i < n; i += 1) {
      // Half under the firm so the partner-scoped console grows too.
      const as = i % 2 === 0 ? firmUser : ops;
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/valuations',
        headers: authHeader(as.token),
        payload: { kind: '409a', company_name: `Scaling ${tag} ${i}` },
      });
      if (res.statusCode >= 400) throw new Error(`seed failed (${res.statusCode}): ${res.body}`);
    }
  }

  async function measure(): Promise<Map<string, number>> {
    const counts = new Map<string, number>();
    for (const [label, template] of ENDPOINTS) {
      const url = template.replace(':partner', partnerId);
      const tap = tapQueries(ctx.pool);
      let res;
      try {
        res = await ctx.app.inject({ method: 'GET', url, headers: authHeader(ops.token) });
      } finally {
        tap.restore();
      }
      // A 4xx would make the count meaningless — an endpoint that refuses the
      // call issues no statements and would "pass" forever. Fail loudly instead.
      if (res.statusCode >= 400)
        throw new Error(`${label} answered ${res.statusCode}: ${res.body.slice(0, 200)}`);
      counts.set(label, tap.statements.length);
    }
    return counts;
  }

  it('issues no more statements for four times the rows', async () => {
    await seedValuations(SEED_ROWS, 'base');
    const small = await measure();
    await seedValuations(SEED_ROWS * (GROWTH - 1), 'grown');
    const large = await measure();

    const grew = ENDPOINTS.map(([label]) => ({
      label,
      small: small.get(label)!,
      large: large.get(label)!,
    })).filter((row) => row.large > row.small);

    expect(
      grew.map(
        (r) => `${r.label}: ${r.small} statements at ${SEED_ROWS} rows, ${r.large} at ${SEED_ROWS * GROWTH}`,
      ),
    ).toEqual([]);

    // And the measurement was real: every endpoint issued at least one
    // statement, so a route that quietly stopped touching the database cannot
    // pass this by doing nothing.
    expect([...small.entries()].filter(([, n]) => n === 0).map(([label]) => label)).toEqual([]);
  }, 180_000);
});
