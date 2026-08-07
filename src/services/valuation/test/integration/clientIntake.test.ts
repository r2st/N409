import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authHeader, isDbAvailable, seedPartner, seedUser, setupTestApp, type TestApp } from './helpers.js';

/**
 * Firm-branded client intake.
 *
 * The client half of these routes authenticates on a token alone, so the
 * properties worth pinning are the ones that hold when the caller is anonymous:
 * a token only ever reaches its own row, a dead link cannot be written through,
 * unknown keys never land in the jsonb column, and a firm cannot read another
 * firm's pipeline by naming its ids.
 */

const dbUp = await isDbAvailable();

const COMPLETE_ANSWERS = {
  legal_name: 'Northwind Robotics, Inc.',
  state_of_incorporation: 'Delaware',
  incorporation_date: '2021-03-04',
  industry: 'Robotics',
  business_description: 'Autonomous warehouse robots.',
  revenue_status: 'post_revenue',
  total_shares_outstanding: 10_000_000,
  has_articles: true,
};

describe.skipIf(!dbUp)('client intake links', () => {
  let ctx: TestApp;
  let firmId: string;
  let rivalId: string;
  let firmAdmin: { id: string; token: string };
  let rivalAdmin: { id: string; token: string };
  let outsider: { id: string; token: string };

  beforeAll(async () => {
    ctx = await setupTestApp();
    firmId = await seedPartner(ctx, 'Meridian Valuation');
    rivalId = await seedPartner(ctx, 'Rival Advisory');
    firmAdmin = await seedUser(ctx, { roles: ['partner'], partnerId: firmId });
    rivalAdmin = await seedUser(ctx, { roles: ['partner'], partnerId: rivalId });
    outsider = await seedUser(ctx, { roles: ['valuation_user'] });
  });
  afterAll(async () => ctx?.teardown());

  const create = (token: string, payload: object = {}) =>
    ctx.app.inject({
      method: 'POST',
      url: '/api/v1/firm/intake-links',
      headers: authHeader(token),
      payload,
    });

  const openPortal = (token: string) =>
    ctx.app.inject({ method: 'POST', url: '/api/v1/intake/portal', payload: { token } });

  const save = (token: string, answers: Record<string, unknown>) =>
    ctx.app.inject({ method: 'POST', url: '/api/v1/intake/portal/answers', payload: { token, answers } });

  const submit = (token: string) =>
    ctx.app.inject({ method: 'POST', url: '/api/v1/intake/portal/submit', payload: { token } });

  it('mints a link the client can open without an account', async () => {
    const created = await create(firmAdmin.token, {
      client_name: 'Northwind Robotics',
      client_email: 'founder@northwind.test',
      expires_in_days: 30,
    });
    expect(created.statusCode).toBe(201);
    const { token, url, link } = created.json();
    // The token belongs in the fragment: a query string would put the
    // credential in access logs and the Referer header.
    expect(url).toContain('/intake#token=');
    expect(link.status).toBe('sent');
    expect(link).not.toHaveProperty('token_hash');

    const portal = await openPortal(token);
    expect(portal.statusCode).toBe(200);
    const body = portal.json();
    expect(body.client_name).toBe('Northwind Robotics');
    expect(body.can_edit).toBe(true);
    expect(body.sections.length).toBeGreaterThan(0);
    // The prospect learns the firm's brand and nothing about its other clients.
    expect(body.firm).not.toHaveProperty('id');
  });

  it('saves partial answers and reports completion as it goes', async () => {
    const { token } = (await create(firmAdmin.token)).json();

    const first = await save(token, { legal_name: 'Halcyon Bio, Inc.' });
    expect(first.statusCode).toBe(200);
    expect(first.json().completion.ready).toBe(false);

    // Merged, not replaced — a client filling one section at a time must not
    // lose the section before it.
    const second = await save(token, { industry: 'Biotech' });
    expect(second.json().answers).toMatchObject({
      legal_name: 'Halcyon Bio, Inc.',
      industry: 'Biotech',
    });
  });

  it('drops keys the questionnaire does not define', async () => {
    const { token } = (await create(firmAdmin.token)).json();
    const res = await save(token, { legal_name: 'Acme, Inc.', arbitrary_blob: 'x'.repeat(5000) });
    expect(res.statusCode).toBe(200);
    expect(res.json().answers).toEqual({ legal_name: 'Acme, Inc.' });
  });

  /**
   * The key filter was the whole guard, so a legal key carrying an object was
   * stored verbatim and the firm console rendered it as "[object Object]".
   */
  it('drops values the questionnaire cannot hold, whatever their key', async () => {
    const { token } = (await create(firmAdmin.token)).json();
    const res = await save(token, {
      legal_name: { $ne: null },
      business_description: ['a', 'b'],
      industry: 'Robotics',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().answers).toEqual({ industry: 'Robotics' });
  });

  /**
   * The worse half of the same hole: a required `select` answered with a
   * non-string counted as answered (`isAnswered` accepts any non-blank value)
   * and skipped the option check (it only ran on strings), so the submit gate —
   * which asks exactly those two questions — passed a questionnaire whose
   * revenue stage was neither of the two offered.
   */
  it('will not accept a submission whose required choice is not a choice', async () => {
    const { token } = (await create(firmAdmin.token)).json();
    await save(token, { ...COMPLETE_ANSWERS, revenue_status: 'sort_of' });

    const res = await submit(token);
    expect(res.statusCode).toBe(422);
    expect(JSON.stringify(res.json())).toContain('not one of the offered choices');
  });

  it('refuses free text longer than the schema it advertises', async () => {
    const { token } = (await create(firmAdmin.token)).json();

    // The browser evaluates the same rule, so the ceiling has to be *on the
    // wire* — a server-only cap is a client typing happily into a submit that
    // will refuse it.
    const sections = (await openPortal(token)).json().sections as Array<{
      fields: Array<{ key: string; rules?: { maxLength?: number } }>;
    }>;
    const field = sections.flatMap((s) => s.fields).find((f) => f.key === 'legal_name');
    expect(field?.rules?.maxLength).toBe(300);

    await save(token, { ...COMPLETE_ANSWERS, legal_name: 'a'.repeat(301) });
    const res = await submit(token);
    expect(res.statusCode).toBe(422);
    expect(JSON.stringify(res.json())).toContain('300 characters or fewer');
  });

  it('refuses to submit until every required field is answered', async () => {
    const { token } = (await create(firmAdmin.token)).json();
    await save(token, { legal_name: 'Partial Co' });

    const early = await submit(token);
    expect(early.statusCode).toBe(422);

    await save(token, COMPLETE_ANSWERS);
    const done = await submit(token);
    expect(done.statusCode).toBe(200);
    expect(done.json().submitted_at).toBeTruthy();
  });

  it('freezes a submitted link but still lets the client read it back', async () => {
    const { token } = (await create(firmAdmin.token)).json();
    await save(token, COMPLETE_ANSWERS);
    await submit(token);

    const reread = await openPortal(token);
    expect(reread.statusCode).toBe(200);
    expect(reread.json().status).toBe('submitted');
    expect(reread.json().can_edit).toBe(false);

    expect((await save(token, { legal_name: 'Changed after the fact' })).statusCode).toBe(401);
    expect((await submit(token)).statusCode).toBe(401);
  });

  it('kills a withdrawn link for the client immediately', async () => {
    const created = await create(firmAdmin.token);
    const { token, link } = created.json();

    const revoked = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/v1/firm/intake-links/${link.id}`,
      headers: authHeader(firmAdmin.token),
    });
    expect(revoked.statusCode).toBe(204);

    expect((await openPortal(token)).statusCode).toBe(401);
    expect((await save(token, { legal_name: 'Too late' })).statusCode).toBe(401);
  });

  it('rejects a token that was never issued', async () => {
    expect((await openPortal('not-a-real-token')).statusCode).toBe(401);
  });

  it('keeps one firm out of another firm’s pipeline', async () => {
    const created = await create(firmAdmin.token, { client_name: 'Confidential Prospect' });
    const { link } = created.json();

    // Same 404 as an id that never existed — a rival must not be able to tell
    // that a link exists at all.
    const peek = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/firm/intake-links/${link.id}`,
      headers: authHeader(rivalAdmin.token),
    });
    expect(peek.statusCode).toBe(404);

    const list = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/firm/intake-links',
      headers: authHeader(rivalAdmin.token),
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().links).toHaveLength(0);

    // Naming the other firm explicitly is refused rather than silently scoped.
    const named = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/firm/intake-links?partner_id=${firmId}`,
      headers: authHeader(rivalAdmin.token),
    });
    expect(named.statusCode).toBe(403);
  });

  it('is closed to accounts that belong to no firm', async () => {
    expect((await create(outsider.token)).statusCode).toBe(403);
  });

  it('shows the firm what came back, with the questionnaire it was asked from', async () => {
    const { token, link } = (await create(firmAdmin.token, { client_name: 'Readback Co' })).json();
    await save(token, { legal_name: 'Readback Co, Inc.' });

    const detail = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/firm/intake-links/${link.id}`,
      headers: authHeader(firmAdmin.token),
    });
    expect(detail.statusCode).toBe(200);
    const body = detail.json();
    expect(body.answers.legal_name).toBe('Readback Co, Inc.');
    expect(body.link.status).toBe('in_progress');
    expect(body.sections.length).toBeGreaterThan(0);
  });

  /**
   * Conversion is the point of the feature: a firm collects the answers so it
   * can start the engagement from them. Until this endpoint existed the whole
   * chain stopped one step short — `attachIntakeValuation` was never called
   * from anywhere, so the `converted` status the console styles and labels was
   * unreachable, and a firm that had just received a completed questionnaire
   * had to retype every answer into a new valuation by hand.
   */
  describe('converting a submission into an engagement', () => {
    const convert = (token: string, id: string, payload: object = {}) =>
      ctx.app.inject({
        method: 'POST',
        url: `/api/v1/firm/intake-links/${id}/convert`,
        headers: authHeader(token),
        payload,
      });

    const submitted = async (answers: Record<string, unknown> = COMPLETE_ANSWERS) => {
      const { token, link } = (await create(firmAdmin.token, { client_name: 'Convertible Co' })).json();
      await save(token, answers);
      await submit(token);
      return { token, link };
    };

    it('creates the firm’s valuation and marks the link converted', async () => {
      const { link } = await submitted();

      const res = await convert(firmAdmin.token, link.id);
      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.valuation.company_name).toBe('Northwind Robotics, Inc.');
      expect(body.valuation.kind).toBe('409a');
      expect(body.valuation.partner_id).toBe(firmId);
      expect(body.valuation.user_id).toBe(firmAdmin.id);
      expect(body.link.valuation_id).toBe(body.valuation.id);
      expect(body.link.status).toBe('converted');
    });

    it('carries the answers into the engagement’s own questionnaire', async () => {
      const { link } = await submitted();
      const { valuation } = (await convert(firmAdmin.token, link.id)).json();

      const q = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/valuations/${valuation.id}/questionnaire`,
        headers: authHeader(firmAdmin.token),
      });
      expect(q.statusCode).toBe(200);
      // Already submitted — the client answered it once; the firm should not be
      // shown a form asking them to answer it again.
      expect(q.json().answers).toMatchObject(COMPLETE_ANSWERS);
      expect(q.json().submitted_at).toBeTruthy();
    });

    it('seeds the params the questionnaire already answers', async () => {
      const { link } = await submitted({
        ...COMPLETE_ANSWERS,
        last_fy_revenue: 1_234.56,
        ytd_revenue: 900,
        last_round_date: '2024-05-01',
      });
      const { valuation } = (await convert(firmAdmin.token, link.id)).json();

      const params = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/valuations/${valuation.id}/params`,
        headers: authHeader(firmAdmin.token),
      });
      expect(params.statusCode).toBe(200);
      const p = params.json().params;
      expect(p.business_overview).toBe('Autonomous warehouse robots.');
      expect(p.revenue_status).toBe('post_revenue');
      expect(String(p.inception_date)).toContain('2021-03-04');
      expect(Number(p.last_year_revenue_cents)).toBe(123_456);
      expect(Number(p.ytd_revenue_cents)).toBe(90_000);
      // Judgement, not intake: nothing here may pre-set the analyst's weights.
      expect(p.weight_opm).toBeNull();
      expect(p.dlom).toBeNull();
    });

    it('refuses a questionnaire the client has not submitted', async () => {
      const { token, link } = (await create(firmAdmin.token)).json();
      await save(token, COMPLETE_ANSWERS);

      const res = await convert(firmAdmin.token, link.id);
      expect(res.statusCode).toBe(409);
    });

    it('converts once, however many times it is asked', async () => {
      const { link } = await submitted();
      const countValuations = async (): Promise<number> => {
        const { rows } = await ctx.pool.query<{ count: string }>(
          'SELECT count(*) FROM valuations WHERE partner_id = $1',
          [firmId],
        );
        return Number(rows[0]!.count);
      };

      const before = await countValuations();
      const [first, second] = await Promise.all([
        convert(firmAdmin.token, link.id),
        convert(firmAdmin.token, link.id),
      ]);

      // The link row is locked before anything is created, so a double-click
      // cannot leave one client owning two engagements — nor an orphaned
      // valuation whose link points somewhere else.
      expect([first.statusCode, second.statusCode].sort()).toEqual([201, 409]);
      expect(await countValuations()).toBe(before + 1);
    });

    it('lets the firm name the company and the kind itself', async () => {
      const { link } = await submitted();
      const res = await convert(firmAdmin.token, link.id, {
        kind: 'fmv',
        company_name: 'Northwind Robotics (UK) Ltd',
        currency: 'GBP',
      });
      expect(res.statusCode).toBe(201);
      expect(res.json().valuation.company_name).toBe('Northwind Robotics (UK) Ltd');
      expect(res.json().valuation.kind).toBe('fmv');
      expect(res.json().valuation.currency).toBe('GBP');
    });

    it('falls back to the name the link was addressed to', async () => {
      // A firm may convert a partial intake to get the engagement moving; a
      // missing legal name must not be an error about a field the client never
      // filled in.
      const { token, link } = (await create(firmAdmin.token, { client_name: 'Halcyon Bio' })).json();
      await save(token, { ...COMPLETE_ANSWERS, legal_name: null });
      await submit(token);
      // Submission is refused while a required field is blank, so name it here.
      await ctx.pool.query('UPDATE client_intake_links SET submitted_at = now() WHERE id = $1', [link.id]);

      const res = await convert(firmAdmin.token, link.id);
      expect(res.statusCode).toBe(201);
      expect(res.json().valuation.company_name).toBe('Halcyon Bio');
    });

    it('will not let one firm convert another firm’s intake', async () => {
      const { link } = await submitted();
      expect((await convert(rivalAdmin.token, link.id)).statusCode).toBe(404);
      expect((await convert(outsider.token, link.id)).statusCode).toBe(403);
    });
  });

  it('keeps answers out of the roster listing', async () => {
    const { token } = (await create(firmAdmin.token)).json();
    await save(token, COMPLETE_ANSWERS);

    const list = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/firm/intake-links',
      headers: authHeader(firmAdmin.token),
    });
    // A page load shouldn't hand over every prospect's answers; the roster
    // carries progress, and reading one client's responses is its own request.
    for (const row of list.json().links) {
      expect(row).not.toHaveProperty('answers');
      expect(row).not.toHaveProperty('token_hash');
      expect(row.completion).toBeTruthy();
    }
  });
});
