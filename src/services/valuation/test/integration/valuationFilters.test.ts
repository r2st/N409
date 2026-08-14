import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newUlid } from '@n409/shared';
import { authHeader, isDbAvailable, seedPartner, seedUser, setupTestApp, type TestApp } from './helpers.js';

const dbUp = await isDbAvailable();

/**
 * Every filter the worklist offers, one at a time.
 *
 * `buildValuationWhere` is a chain of independent `if (filters.x)` clauses, and
 * roughly a third of them had never been exercised — `source`, `paid_status`,
 * `waiting_on_client`, `unread`, the four date bounds, the tag conjunction and
 * the id-vs-text branch of `q`. That is the shape of code where an untested arm
 * hides best: each clause looks obviously right on its own, and the failure mode
 * is not an error but a list with the wrong rows in it.
 *
 * The tag filter is the one with a design decision behind it worth pinning. It
 * is a conjunction of EXISTS clauses, not `slug = ANY(...)` — `tags=saas,ai`
 * means both, not either, and the two forms differ silently in what they return.
 */
describe.skipIf(!dbUp)('valuation worklist filters', () => {
  let ctx: TestApp;
  let ops: Awaited<ReturnType<typeof seedUser>>;
  let client: Awaited<ReturnType<typeof seedUser>>;
  let partnerId: string;

  beforeAll(async () => {
    ctx = await setupTestApp({ AUTO_PIPELINE: 'off', EMAIL_MODE: 'off' });
    ops = await seedUser(ctx, { roles: ['admin'] });
    client = await seedUser(ctx, { roles: ['valuation_user'] });
    partnerId = await seedPartner(ctx, 'Filter LLP');
  });
  afterAll(async () => ctx?.teardown());

  const list = (query = '', token = ops.token) =>
    ctx.app.inject({ method: 'GET', url: `/api/v1/valuations${query}`, headers: authHeader(token) });

  const names = async (query: string): Promise<string[]> => {
    const res = await list(query);
    expect(res.statusCode, query).toBe(200);
    return (res.json().valuations as Array<{ company_name: string }>).map((v) => v.company_name);
  };

  async function create(companyName: string, kind = '409a'): Promise<string> {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/valuations',
      headers: authHeader(client.token),
      payload: { kind, company_name: companyName },
    });
    expect(res.statusCode, res.body).toBe(201);
    return res.json().valuation.id as string;
  }

  let sourced: string;
  let paid: string;
  let waiting: string;
  let dated: string;
  let tagged: string;

  beforeAll(async () => {
    sourced = await create('Sourced Co');
    paid = await create('Paid Co');
    waiting = await create('Waiting Co');
    dated = await create('Dated Co');
    tagged = await create('Tagged Co');

    await ctx.pool.query(`UPDATE valuations SET source = 'partner' WHERE id = $1`, [sourced]);
    await ctx.pool.query(`UPDATE valuations SET paid_status = 'paid_by_partner' WHERE id = $1`, [paid]);
    await ctx.pool.query(`UPDATE valuations SET waiting_on_client = true WHERE id = $1`, [waiting]);
    await ctx.pool.query(
      `UPDATE valuations SET created_at = '2020-06-15T00:00:00Z', due_date = '2020-07-20' WHERE id = $1`,
      [dated],
    );
    await ctx.pool.query(`UPDATE valuations SET partner_id = $2 WHERE id = $1`, [tagged, partnerId]);
    for (const slug of ['saas', 'pre_revenue']) {
      await ctx.pool.query(
        `INSERT INTO valuation_tags (id, valuation_id, slug, status, source)
         VALUES ($1, $2, $3, 'accepted', 'manual')
         ON CONFLICT (valuation_id, slug) DO UPDATE SET status = 'accepted'`,
        [newUlid(), tagged, slug],
      );
    }
  });

  // ── Simple equality filters ───────────────────────────────────────────────
  describe('the equality filters', () => {
    it('filters by source', async () => {
      expect(await names('?source=partner')).toEqual(['Sourced Co']);
      expect(await names('?source=referral')).not.toContain('Sourced Co');
    });

    it('filters by paid status', async () => {
      expect(await names('?paid_status=paid_by_partner')).toEqual(['Paid Co']);
      const unpaid = await names('?paid_status=unpaid');
      expect(unpaid).toContain('Sourced Co');
      expect(unpaid).not.toContain('Paid Co');
    });

    it('filters by whether the engagement is waiting on the client, both ways', async () => {
      // `waiting_on_client=false` is a filter, not an absent one — the boolean
      // is checked with `!== undefined` precisely so false narrows the list.
      expect(await names('?waiting_on_client=true')).toEqual(['Waiting Co']);
      expect(await names('?waiting_on_client=false')).not.toContain('Waiting Co');
    });

    it('filters by partner and by owner', async () => {
      expect(await names(`?partner_id=${partnerId}`)).toEqual(['Tagged Co']);
      const mine = await names(`?user_id=${client.id}`);
      expect(mine.length).toBeGreaterThan(0);
      expect(await names('?user_id=01ARZ3NDEKTSV4RRFFQ69G5FAV')).toEqual([]);
    });

    it('filters by kind', async () => {
      const id = await create('Fund Co', 'fund');
      expect(await names('?kind=fund')).toContain('Fund Co');
      expect(await names('?kind=409a')).not.toContain('Fund Co');
      expect(id).toBeTruthy();
    });
  });

  // ── Date bounds ───────────────────────────────────────────────────────────
  describe('the date bounds', () => {
    it('bounds by creation date, inclusively at the upper end', async () => {
      // `created_to=2020-06-15` keeps the whole of the 15th — the clause is
      // `< date + 1 day`, and an exclusive bound would silently drop every
      // engagement created on the day somebody typed.
      expect(await names('?created_from=2020-06-01&created_to=2020-06-30')).toEqual(['Dated Co']);
      expect(await names('?created_to=2020-06-15')).toEqual(['Dated Co']);
      expect(await names('?created_to=2020-06-14')).toEqual([]);
      expect(await names('?created_from=2020-06-16')).not.toContain('Dated Co');
    });

    it('bounds by due date the same way', async () => {
      expect(await names('?due_from=2020-07-01&due_to=2020-07-31')).toEqual(['Dated Co']);
      expect(await names('?due_to=2020-07-20')).toEqual(['Dated Co']);
      expect(await names('?due_to=2020-07-19')).toEqual([]);
    });

    it('400s a date that is not one', async () => {
      for (const q of ['?created_from=yesterday', '?due_to=2020-13-45', '?created_to=2020-02-30']) {
        const res = await list(q);
        expect(res.statusCode, q).toBe(400);
      }
    });
  });

  // ── Tags ──────────────────────────────────────────────────────────────────
  describe('the tag filter', () => {
    it('means AND, not OR, across several slugs', async () => {
      // The whole reason it is a conjunction of EXISTS clauses. An OR would
      // return every SaaS engagement when the analyst asked for pre-revenue
      // SaaS, and nothing about the result would look wrong.
      expect(await names('?tags=saas')).toEqual(['Tagged Co']);
      expect(await names('?tags=saas,pre_revenue')).toEqual(['Tagged Co']);
      // `growth_stage` is a real slug that is not on this engagement, so the
      // conjunction is empty — an OR would have returned it anyway.
      expect(await names('?tags=saas,growth_stage')).toEqual([]);
    });

    it('drops a slug the catalogue does not know rather than refusing the URL', async () => {
      // A saved view written against a tag later retired should keep working on
      // the tags it still names — a 422 on a six-month-old bookmark is a worse
      // answer than a narrower result.
      expect(await names('?tags=saas,Not A Slug')).toEqual(['Tagged Co']);
      // Every slug dropped leaves no tag filter at all rather than an empty one.
      expect((await names('?tags=%20')).length).toBeGreaterThan(0);
    });

    it('ignores a tag that is only suggested, not accepted', async () => {
      // The index the filter reads is partial on `status = 'accepted'`, and a
      // suggested tag is one nobody has agreed to.
      const proposed = await create('Proposed Co');
      // `suggested`, the status the agent writes — nobody has accepted it.
      await ctx.pool.query(
        `INSERT INTO valuation_tags (id, valuation_id, slug, status, source)
         VALUES ($1, $2, 'saas', 'suggested', 'ai')`,
        [newUlid(), proposed],
      );
      expect(await names('?tags=saas')).not.toContain('Proposed Co');
    });
  });

  // ── Free text ─────────────────────────────────────────────────────────────
  describe('the search box', () => {
    it('treats a ULID as an id lookup rather than as text', async () => {
      // Pasting an id into the search box is what an operator does with an id,
      // and matching it as text against company names would return nothing.
      expect(await names(`?q=${paid}`)).toEqual(['Paid Co']);
      expect(await names(`?q=${paid.toLowerCase()}`)).toEqual(['Paid Co']);
    });

    it('matches company names case-insensitively otherwise', async () => {
      expect(await names('?q=waiting')).toContain('Waiting Co');
      expect(await names('?q=nothing-matches-this')).toEqual([]);
    });

    it('takes an explicit id list and drops the entries that are not ids', async () => {
      const both = await names(`?ids=${paid},${waiting}`);
      expect(both.sort()).toEqual(['Paid Co', 'Waiting Co']);
      expect(await names(`?ids=${paid},not-a-ulid`)).toEqual(['Paid Co']);
    });
  });

  // ── Unread ────────────────────────────────────────────────────────────────
  describe('the unread filter', () => {
    it('is empty when nothing has been commented on', async () => {
      expect(await names('?unread=true')).toEqual([]);
    });

    it('resolves to the caller’s own side of the conversation', async () => {
      // Two read columns, and which one applies depends on who is asking — an
      // ops user's unread list and a client's are different lists over the same
      // rows.
      await ctx.pool.query(
        `UPDATE valuations SET last_comment_at = now(), admin_read_at = NULL, user_read_at = now()
         WHERE id = $1`,
        [waiting],
      );
      expect(await names('?unread=true')).toContain('Waiting Co');

      const asClient = await list('?unread=true', client.token);
      expect(asClient.statusCode).toBe(200);
      expect(
        (asClient.json().valuations as Array<{ company_name: string }>).map((v) => v.company_name),
      ).not.toContain('Waiting Co');
    });
  });

  // ── Tab tallies ───────────────────────────────────────────────────────────
  describe('the tab tallies', () => {
    const counts = (query = '', token = ops.token) =>
      ctx.app.inject({
        method: 'GET',
        url: `/api/v1/valuations/counts${query}`,
        headers: authHeader(token),
      });

    it('counts every tab, honouring the other filters but not the tab itself', async () => {
      // Each tab shows its own total, so the state/group filter is dropped from
      // the count — otherwise every tab would report the count of the open one.
      const res = await counts('?paid_status=unpaid');
      expect(res.statusCode).toBe(200);
      const body = res.json().counts as Record<string, number>;
      expect(body.all).toBeGreaterThan(0);
      // `all` is the sum of the lifecycle groups, and asking for one group does
      // not shrink it.
      const scoped = await counts('?paid_status=unpaid&group=open');
      expect((scoped.json().counts as Record<string, number>).all).toBe(body.all);
    });

    it('narrows the tallies with a non-tab filter', async () => {
      const all = (await counts()).json().counts as Record<string, number>;
      const partnerOnly = (await counts(`?partner_id=${partnerId}`)).json().counts as Record<string, number>;
      expect(partnerOnly.all).toBeLessThan(all.all);
      expect(partnerOnly.all).toBe(1);
    });

    it('answers a caller with no scope with zeros rather than an error', async () => {
      // `scope.kind === 'none'` short-circuits before any query runs. A 403
      // would be defensible; zeros are what the worklist renders, and either
      // way it must not be a 500 or an unfiltered list.
      const nobody = await seedUser(ctx, { roles: ['ignored'] });

      const listed = await list('', nobody.token);
      expect(listed.statusCode).toBe(200);
      expect(listed.json().valuations).toEqual([]);
      expect(listed.json().total).toBe(0);

      const tallied = await counts('', nobody.token);
      expect(tallied.statusCode).toBe(200);
      expect((tallied.json().counts as Record<string, number>).all).toBe(0);
    });
  });
});
