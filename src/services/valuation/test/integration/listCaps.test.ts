import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authHeader, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';
import { createCalculation } from '../../src/repos/calculations.js';
import { upsertSubscription, SUBSCRIPTION_PAGE_LIMIT } from '../../src/repos/billing.js';
import { SAVED_VIEW_PAGE_LIMIT } from '../../src/repos/savedViews.js';
import { SCIM_TOKEN_PAGE_LIMIT } from '../../src/repos/ssoConfig.js';
import { PROMPT_VERSION_PAGE_LIMIT } from '../../src/repos/aiPrompts.js';
import { ARTICLE_PAGE_LIMIT } from '../../src/repos/helpArticles.js';
import { TEMPLATE_PAGE_LIMIT } from '../../src/repos/reportTemplates.js';
import { GRANT_PAGE_LIMIT } from '../../src/repos/grants.js';
import { COMMENT_PAGE_LIMIT } from '../../src/repos/comments.js';
import { listWorkbookCells, WORKBOOK_CELL_LIMIT } from '../../src/repos/workbook.js';
import { WORKBOOK_SHEETS } from '../../src/domain/workbook.js';

const dbUp = await isDbAvailable();

/**
 * The nine list queries that used to read a whole table, and the flag that is
 * the only thing making a cap safe.
 *
 * A `LIMIT` added to a query that had none is not, by itself, a fix: it turns
 * "slow" into "wrong but fast". Every one of these lists is read by a screen
 * that draws exactly what it is given — a grants table, a comment thread, the
 * SCIM tokens an admin is about to audit — and none of those screens can tell a
 * short page from a short list. So each endpoint has to answer three questions
 * and this suite asks all three of every one of them: how many rows did I get,
 * were there more, and what is the largest page I may ask for.
 *
 * `truncated` is the one that matters. A cap nobody is told about is a silent
 * data-loss bug with a good latency graph: a revoked SCIM token that falls off
 * the end reads as a token that was already cleaned up, and a grant missing
 * from the cap table reads as a grant that was never issued.
 *
 * The caps are far above any real tenant's row counts, so these tests reach
 * them with an explicit `?limit=` rather than by seeding ten thousand grants.
 * That is the same code path — the route clamps the request into the repo,
 * which fetches `limit + 1` to decide the flag — and it is the path a client
 * paging deliberately uses too.
 */
describe.skipIf(!dbUp)('bounded list endpoints', () => {
  let ctx: TestApp;
  let ops: Awaited<ReturnType<typeof seedUser>>;
  let client: Awaited<ReturnType<typeof seedUser>>;
  /** Board-approved, so grants can be issued against it. */
  let valuationId: string;
  let promptId: string;

  /**
   * Drives a valuation to a signed board resolution — the precondition for
   * issuing a grant, since the exercise price is snapshotted from the adopted
   * FMV.
   */
  const approvedValuation = async (companyName: string): Promise<string> => {
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/valuations',
      headers: authHeader(client.token),
      payload: { kind: '409a', company_name: companyName },
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().valuation.id as string;
    await createCalculation(
      ctx.pool,
      {
        valuationId: id,
        engineVersion: 'test',
        status: 'succeeded',
        inputs: {},
        results: { fmv_per_share: 3.25 },
        equityValue: 32_500_000,
        fmvPerShare: 3.25,
        createdBy: ops.id,
      },
      { actorType: 'human', actorId: ops.id },
    );
    await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${id}/board`,
      headers: authHeader(ops.token),
      payload: {},
    });
    const member = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${id}/board/members`,
      headers: authHeader(ops.token),
      payload: { name: 'Chair', email: 'chair@caps.example' },
    });
    await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/board/sign',
      payload: { token: member.json().sign_token as string, decision: 'signed' },
    });
    return id;
  };

  beforeAll(async () => {
    // AUTO_PIPELINE off: a background run would append calculations and events
    // underneath the row counts these tests assert on.
    ctx = await setupTestApp({ AUTO_PIPELINE: 'off' });
    ops = await seedUser(ctx, { roles: ['admin', 'reviewer'] });
    client = await seedUser(ctx, { roles: ['valuation_user'] });
    valuationId = await approvedValuation('Caps Co');

    // ── subscriptions ────────────────────────────────────────────────────────
    // One row per user (the non-Stripe upsert keys on user_id), so three rows
    // means three subscribers.
    for (let i = 0; i < 3; i += 1) {
      const subscriber = await seedUser(ctx, {
        roles: ['valuation_user'],
        email: `caps-subscriber-${i}@test.example.com`,
      });
      await upsertSubscription(ctx.pool, { userId: subscriber.id, planTier: 'annual_retainer' });
    }

    // ── saved views ──────────────────────────────────────────────────────────
    for (let i = 0; i < 4; i += 1) {
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/saved-views',
        headers: authHeader(ops.token),
        payload: { name: `Caps view ${i}`, query: `state=in_review&kind=409a&page=${i + 1}` },
      });
      expect(res.statusCode).toBe(201);
    }

    // ── SCIM tokens ──────────────────────────────────────────────────────────
    for (let i = 0; i < 4; i += 1) {
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/admin/sso/scim-tokens',
        headers: authHeader(ops.token),
        payload: { label: `Caps token ${i}` },
      });
      expect(res.statusCode).toBe(201);
    }

    // ── prompt versions ──────────────────────────────────────────────────────
    // Only a content edit appends a version; `enabled` is operational state and
    // deliberately does not.
    const prompts = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/admin/prompts',
      headers: authHeader(ops.token),
    });
    promptId = (prompts.json().prompts as Array<{ id: string; pipeline: string }>).find(
      (p) => p.pipeline === 'extract',
    )!.id;
    for (let i = 0; i < 3; i += 1) {
      const res = await ctx.app.inject({
        method: 'PATCH',
        url: `/api/v1/admin/prompts/${promptId}`,
        headers: authHeader(ops.token),
        payload: { system_prompt: `Caps revision ${i}` },
      });
      expect(res.statusCode).toBe(200);
    }

    // ── help articles ────────────────────────────────────────────────────────
    for (let i = 0; i < 4; i += 1) {
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/admin/help/articles',
        headers: authHeader(ops.token),
        payload: {
          slug: `caps-article-${i}`,
          title: `Caps article ${i}`,
          category: 'Caps',
          body_html: `<p>Body ${i}</p>`,
          sort_order: i,
        },
      });
      expect(res.statusCode).toBe(201);
    }

    // ── report templates ─────────────────────────────────────────────────────
    for (let i = 0; i < 4; i += 1) {
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/report-templates',
        headers: authHeader(ops.token),
        payload: { name: `caps_template_${i}`, kind: '409a', body: `# Caps ${i}` },
      });
      expect(res.statusCode).toBe(201);
    }

    // ── grants ───────────────────────────────────────────────────────────────
    for (let i = 0; i < 4; i += 1) {
      const res = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/valuations/${valuationId}/grants`,
        headers: authHeader(ops.token),
        payload: {
          grantee_name: `Caps Grantee ${i}`,
          grant_date: `2026-0${i + 1}-15`,
          options_count: 1000 * (i + 1),
        },
      });
      expect(res.statusCode).toBe(201);
    }

    // ── comments ─────────────────────────────────────────────────────────────
    // Sequential, and each awaited, so `created_at` strictly increases and the
    // "which end does the cap keep" test below has a defined answer.
    for (let i = 0; i < 5; i += 1) {
      const res = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/valuations/${valuationId}/comments`,
        headers: authHeader(ops.token),
        payload: { kind: 'note', body: `Caps comment ${i}` },
      });
      expect(res.statusCode).toBe(201);
    }

    // ── workbook cells ───────────────────────────────────────────────────────
    const patched = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/valuations/${valuationId}/workbook`,
      headers: authHeader(ops.token),
      payload: {
        cells: [
          { sheet: 'income_statement', row_key: 'revenue', column_key: 'fy_minus_1', value: 4_000_000 },
          { sheet: 'income_statement', row_key: 'revenue', column_key: 'fy_current', value: 5_000_000 },
          { sheet: 'income_statement', row_key: 'cogs', column_key: 'fy_current', value: 2_000_000 },
          { sheet: 'income_statement', row_key: 'operating_expenses', column_key: 'fy_current', value: 900_000 },
        ],
      },
    });
    expect(patched.statusCode).toBe(200);
  });

  afterAll(async () => ctx?.teardown());

  /**
   * One row per capped endpoint.
   *
   * `truncatedKey` is not always `truncated`: the admin billing screen serves
   * two capped lists in one response and so names each flag after its list.
   *
   * `overCeilingStatus` records what a request above the ceiling actually gets
   * today, and it is not uniform — `paginationBounds`/`pickerLimits` pin 400 for
   * a bad query string (422 is this codebase's code for a bad *body*), and the
   * seven routes below that answer 422 diverge from that. Pinned rather than
   * papered over with `[400, 422]`: a weak assertion here would let the split
   * widen unnoticed, and it is a one-line change per route whenever it is worth
   * making the break.
   */
  const CAPPED: ReadonlyArray<{
    name: string;
    url: string;
    key: string;
    truncatedKey: string;
    ceiling: number;
    overCeilingStatus: number;
  }> = [
    {
      name: 'listAllSubscriptions',
      url: '/api/v1/admin/billing',
      key: 'subscriptions',
      truncatedKey: 'subscriptions_truncated',
      ceiling: SUBSCRIPTION_PAGE_LIMIT,
      overCeilingStatus: 422,
    },
    {
      name: 'listVisibleViews',
      url: '/api/v1/saved-views',
      key: 'views',
      truncatedKey: 'truncated',
      ceiling: SAVED_VIEW_PAGE_LIMIT,
      overCeilingStatus: 422,
    },
    {
      name: 'listScimTokens',
      url: '/api/v1/admin/sso/scim-tokens',
      key: 'tokens',
      truncatedKey: 'truncated',
      ceiling: SCIM_TOKEN_PAGE_LIMIT,
      overCeilingStatus: 422,
    },
    {
      name: 'listArticles',
      url: '/api/v1/help/articles',
      key: 'articles',
      truncatedKey: 'truncated',
      ceiling: ARTICLE_PAGE_LIMIT,
      overCeilingStatus: 422,
    },
    {
      name: 'listTemplates',
      url: '/api/v1/report-templates',
      key: 'templates',
      truncatedKey: 'truncated',
      ceiling: TEMPLATE_PAGE_LIMIT,
      overCeilingStatus: 400,
    },
  ];

  /** Endpoints whose URL is only known after `beforeAll` has seeded a parent row. */
  const scoped = () => [
    {
      name: 'listPromptVersions',
      url: `/api/v1/admin/prompts/${promptId}/versions`,
      key: 'versions',
      truncatedKey: 'truncated',
      ceiling: PROMPT_VERSION_PAGE_LIMIT,
      overCeilingStatus: 422,
    },
    {
      name: 'listGrants',
      url: `/api/v1/valuations/${valuationId}/grants`,
      key: 'grants',
      truncatedKey: 'truncated',
      ceiling: GRANT_PAGE_LIMIT,
      overCeilingStatus: 422,
    },
    {
      name: 'listComments',
      url: `/api/v1/valuations/${valuationId}/comments`,
      key: 'comments',
      truncatedKey: 'truncated',
      ceiling: COMMENT_PAGE_LIMIT,
      overCeilingStatus: 400,
    },
  ];

  const get = (url: string, query = '') =>
    ctx.app.inject({ method: 'GET', url: `${url}${query}`, headers: authHeader(ops.token) });

  const body = async (url: string, query = '') => {
    const res = await get(url, query);
    expect(res.statusCode, `${url}${query} → ${res.statusCode} ${res.body.slice(0, 200)}`).toBe(200);
    return res.json() as Record<string, unknown>;
  };

  const cases = () => [...CAPPED, ...scoped()];

  it('states the page limit it enforces, on every capped list', async () => {
    // The ceiling is not discoverable from a short page, so it is served with
    // one: it is what tells a client the difference between "ask for more" and
    // "narrow the filter".
    for (const c of cases()) {
      const json = await body(c.url);
      expect(json.page_limit, c.name).toBe(c.ceiling);
    }
  });

  it('serves the whole list, and says it is whole, when it fits', async () => {
    for (const c of cases()) {
      const json = await body(c.url);
      const rows = json[c.key] as unknown[];
      expect(rows.length, c.name).toBeGreaterThanOrEqual(3);
      expect(rows.length, c.name).toBeLessThanOrEqual(c.ceiling);
      expect(json[c.truncatedKey], c.name).toBe(false);
    }
  });

  it('caps the list at the requested limit and admits it was cut', async () => {
    for (const c of cases()) {
      const json = await body(c.url, '?limit=2');
      expect((json[c.key] as unknown[]).length, c.name).toBe(2);
      expect(json[c.truncatedKey], c.name).toBe(true);
    }
  });

  it('does not claim truncation when the limit is exactly the row count', async () => {
    // The off-by-one that a `LIMIT n` / `rows.length > n` pair invites: the repo
    // asks for `limit + 1` rows precisely so a full page can be distinguished
    // from a cut one, and getting that comparison wrong makes every complete
    // list report itself as incomplete.
    for (const c of cases()) {
      const whole = await body(c.url);
      const n = (whole[c.key] as unknown[]).length;
      const exact = await body(c.url, `?limit=${n}`);
      expect((exact[c.key] as unknown[]).length, c.name).toBe(n);
      expect(exact[c.truncatedKey], c.name).toBe(false);
    }
  });

  it('refuses a limit above the ceiling rather than quietly clamping it', async () => {
    // Clamping would be the worse failure: the caller asked for a page size,
    // got a smaller one, and nothing in the response would say so.
    for (const c of cases()) {
      const res = await get(c.url, `?limit=${c.ceiling + 1}`);
      expect(res.statusCode, c.name).toBe(c.overCeilingStatus);
    }
  });

  it('refuses a zero or negative limit', async () => {
    for (const c of cases()) {
      for (const limit of ['0', '-1']) {
        const res = await get(c.url, `?limit=${limit}`);
        expect(res.statusCode, `${c.name} limit=${limit}`).toBe(c.overCeilingStatus);
      }
    }
  });

  it('accepts the ceiling itself', async () => {
    for (const c of cases()) {
      const res = await get(c.url, `?limit=${c.ceiling}`);
      expect(res.statusCode, c.name).toBe(200);
    }
  });

  it('keeps the newest end of a comment thread when it cuts one', async () => {
    /*
     * The only list here where *which* rows survive the cut is a product
     * decision rather than an implementation detail. `listComments` orders
     * newest-first in SQL and re-sorts to oldest-first in JS after slicing, so
     * a truncated thread is the tail of the conversation. Ordering ascending
     * and taking a LIMIT would keep the first messages ever sent and drop the
     * live discussion — the opposite of what a panel wants.
     */
    const json = await body(`/api/v1/valuations/${valuationId}/comments`, '?limit=2');
    const bodies = (json.comments as Array<{ body: string }>).map((c) => c.body);
    expect(bodies).toEqual(['Caps comment 3', 'Caps comment 4']);
    expect(json.truncated).toBe(true);
  });

  describe('listWorkbookCells', () => {
    /*
     * The workbook list is capped in the repo but takes no `limit` from its
     * route: the report renderer and the auditor workbook read it to print the
     * Financial Analysis appendix, and a caller-chosen page size there would be
     * a document whose subtotals do not add up. So it is exercised at the repo
     * boundary, which is the only place the cap can be reached.
     */
    it('reports truncation rather than silently returning a short workbook', async () => {
      const cut = await listWorkbookCells(ctx.pool, valuationId, { limit: 2 });
      expect(cut.cells).toHaveLength(2);
      expect(cut.truncated).toBe(true);

      const whole = await listWorkbookCells(ctx.pool, valuationId);
      expect(whole.cells).toHaveLength(4);
      expect(whole.truncated).toBe(false);
    });

    it('cuts at a stable place, ordered by address', async () => {
      // A truncated read that returned "whatever the scan happened to give me"
      // would make the appendix differ between two renders of one valuation.
      const first = await listWorkbookCells(ctx.pool, valuationId, { limit: 3 });
      const again = await listWorkbookCells(ctx.pool, valuationId, { limit: 3 });
      expect(again.cells).toEqual(first.cells);
      // `ORDER BY sheet, row_key, column_key` — lexical on the column key, so
      // `fy_current` precedes `fy_minus_1` rather than the periods coming back
      // in fiscal order. That is fine for a cut that must only be *repeatable*;
      // the renderer lays the columns out from the model, not from this order.
      expect(first.cells.map((c) => `${c.sheet}/${c.row_key}/${c.column_key}`)).toEqual([
        'income_statement/cogs/fy_current',
        'income_statement/operating_expenses/fy_current',
        'income_statement/revenue/fy_current',
      ]);
    });

    it('clamps a caller asking for more than the ceiling instead of honouring it', async () => {
      const res = await listWorkbookCells(ctx.pool, valuationId, { limit: WORKBOOK_CELL_LIMIT + 1_000 });
      expect(res.cells).toHaveLength(4);
      expect(res.truncated).toBe(false);
    });

    it('leaves the cap an order of magnitude clear of every address the model defines', () => {
      /*
       * This is the assertion `repos/workbook.ts` names when it argues the cap
       * is safe on the report path. Only input rows are persisted, and
       * `validateCellRef` rejects everything else on write, so the number of
       * cells a valuation can legitimately hold is fixed by the template. If a
       * future sheet pushes that count toward the cap, the appendix starts
       * being at risk of a silent short read and this fails first.
       */
      const ADDRESSABLE_WORKBOOK_CELLS = WORKBOOK_SHEETS.reduce(
        (total, sheet) =>
          total + sheet.rows.filter((r) => r.kind === 'input').length * sheet.columns.length,
        0,
      );
      expect(ADDRESSABLE_WORKBOOK_CELLS).toBeGreaterThan(0);
      expect(ADDRESSABLE_WORKBOOK_CELLS * 10).toBeLessThan(WORKBOOK_CELL_LIMIT);
    });
  });
});
