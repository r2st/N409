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
