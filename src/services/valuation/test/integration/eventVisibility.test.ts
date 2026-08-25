import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { recordEvent } from '../../src/events/record.js';
import { recordAdminEvent } from '../../src/events/adminRecord.js';
import { CLIENT_VISIBLE_EVENT_TYPES, EVENT_CATALOG } from '../../src/domain/auditTrail.js';
import { authHeader, isDbAvailable, seedPartner, seedUser, setupTestApp, type TestApp } from './helpers.js';

const dbUp = await isDbAvailable();

/**
 * The catalog's `visibility` is a rule, and every door onto the spine has to
 * apply it.
 *
 * `EVENT_CATALOG` has marked 37 of its 66 types `internal` — "analyst tooling,
 * never shown outside ops" — since it was written, and exactly one reader
 * enforced it: `filterAuditEntries`, for the audit-trail route. Of the four
 * other routes on the same table, the progress timeline reads its own
 * client-safe allow-list and the evidence bundle and engagement panel are
 * ops-only; `GET /valuations/:id/events` had neither guard, and the dashboard
 * activity band — which is *not* ops-only — read both event tables whole.
 *
 * So a client who owned the engagement could read the analyst's `overwrite_
 * applied`, the `review_decision` behind it, and every internal `comment_added`
 * with its payload, either by asking the events route or by loading their own
 * dashboard. Nothing in the response said the rows were internal; they arrived
 * labelled in English beside the ones that were meant for them.
 */
describe.skipIf(!dbUp)('event visibility', () => {
  let ctx: TestApp;
  let ops: Awaited<ReturnType<typeof seedUser>>;
  let client: Awaited<ReturnType<typeof seedUser>>;
  let partner: Awaited<ReturnType<typeof seedUser>>;
  let valuationId: string;

  beforeAll(async () => {
    ctx = await setupTestApp();
    ops = await seedUser(ctx, { roles: ['reviewer'] });
    const partnerId = await seedPartner(ctx, 'Northbridge Capital');
    // The partner is the reachable path: the dashboard band is fetched by the
    // browser for ops *and* partners, so a firm admin read every analyst event
    // on every engagement in their portfolio without asking for it.
    client = await seedUser(ctx, { roles: ['valuation_user'], partnerId });
    partner = await seedUser(ctx, { roles: ['partner'], partnerId });

    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/valuations',
      headers: authHeader(client.token),
      payload: { kind: '409a', company_name: 'Acme Robotics, Inc.' },
    });
    expect(res.statusCode).toBe(201);
    valuationId = res.json().valuation.id as string;

    // One of each side of the rule, and the internal ones carry the payloads
    // that make the disclosure matter: what an analyst overwrote, and what a
    // reviewer said about it.
    const analyst = { actorType: 'human', actorId: ops.id, source: 'api' } as const;
    await recordEvent(ctx.pool, {
      valuationId,
      type: 'document_uploaded',
      actor: analyst,
      payload: { filename: 'cap-table.xlsx' },
    });
    await recordEvent(ctx.pool, {
      valuationId,
      type: 'overwrite_applied',
      actor: analyst,
      payload: { field: 'dlom', from: 0.22, to: 0.35, reason: 'client pushed back on the discount' },
    });
    await recordEvent(ctx.pool, {
      valuationId,
      type: 'comment_added',
      actor: analyst,
      payload: { body: 'strike looks aggressive, flag before we sign' },
    });
    await recordEvent(ctx.pool, {
      valuationId,
      type: 'review_decision',
      actor: analyst,
      payload: { decision: 'changes_requested' },
    });
    await recordAdminEvent(ctx.pool, {
      type: 'volatility_applied',
      actor: analyst,
      subjectType: 'valuation',
      subjectId: valuationId,
      subjectLabel: 'Acme Robotics, Inc.',
      payload: { sigma: 0.61 },
    });
  });
  afterAll(async () => ctx?.teardown());

  const events = (token: string, query = '') =>
    ctx.app.inject({
      method: 'GET',
      url: `/api/v1/valuations/${valuationId}/events${query}`,
      headers: authHeader(token),
    });

  const dashboard = (token: string) =>
    ctx.app.inject({ method: 'GET', url: '/api/v1/stats/dashboard', headers: authHeader(token) });

  it('agrees with the catalog about which types are client-visible', () => {
    // The derived list is the rule itself, not a second copy of it.
    const fromCatalog = Object.entries(EVENT_CATALOG)
      .filter(([, d]) => d.visibility === 'client')
      .map(([type]) => type);
    expect([...CLIENT_VISIBLE_EVENT_TYPES].sort()).toEqual(fromCatalog.sort());
    expect(CLIENT_VISIBLE_EVENT_TYPES).toContain('document_uploaded');
    expect(CLIENT_VISIBLE_EVENT_TYPES).not.toContain('overwrite_applied');

    // Every lifecycle event a non-ops principal can *cause* has to be one they
    // can then see. `valuation_cloned` was not: clients may clone their own
    // engagement, and the rule made them blind to the one they had just made.
    // `comment_added` stays internal on purpose — the type does not say whether
    // the comment was a client `chat` or an analyst `note`, and the payload
    // carries the body either way.
    expect(CLIENT_VISIBLE_EVENT_TYPES).toContain('valuation_cloned');
    expect(CLIENT_VISIBLE_EVENT_TYPES).not.toContain('comment_added');
  });

  it('gives the owning client only client-visible events', async () => {
    const res = await events(client.token);
    expect(res.statusCode).toBe(200);
    const types = res.json().events.map((e: { type: string }) => e.type);

    expect(types).toContain('document_uploaded');
    for (const internal of ['overwrite_applied', 'comment_added', 'review_decision']) {
      expect(types).not.toContain(internal);
    }
    // Not just the type: the payload is what the disclosure was.
    expect(JSON.stringify(res.json())).not.toContain('client pushed back');
    expect(JSON.stringify(res.json())).not.toContain('flag before we sign');
  });

  it('still gives operations the whole spine', async () => {
    const types = (await events(ops.token)).json().events.map((e: { type: string }) => e.type);
    for (const type of ['document_uploaded', 'overwrite_applied', 'comment_added', 'review_decision']) {
      expect(types).toContain(type);
    }
  });

  it('bounds the client page against what the client may see, not the spine', async () => {
    // The filter is pushed into the query for this reason: applied to the page
    // instead, `limit=2` would select the two newest rows — both internal —
    // and hand back an empty list that claimed to be the newest two.
    const res = await events(client.token, '?limit=2');
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.events.length).toBeGreaterThan(0);
    expect(body.events.every((e: { type: string }) => CLIENT_VISIBLE_EVENT_TYPES.includes(e.type))).toBe(
      true,
    );
  });

  it('keeps internal events out of the client dashboard feed', async () => {
    const res = await dashboard(client.token);
    expect(res.statusCode).toBe(200);
    const activity = res.json().activity as { type: string; scope: string }[];
    expect(activity.some((row) => row.type === 'document_uploaded')).toBe(true);
    for (const internal of ['overwrite_applied', 'comment_added', 'review_decision']) {
      expect(activity.some((row) => row.type === internal)).toBe(false);
    }
    // The admin branch is dropped whole: every admin type is an ops action.
    expect(activity.some((row) => row.scope === 'admin')).toBe(false);
  });

  it("keeps internal events out of a partner firm's feed and events route", async () => {
    // Same rule, the other non-ops scope. A partner reads a whole portfolio,
    // so this is the wider of the two disclosures, and the only one a browser
    // actually rendered.
    const activity = (await dashboard(partner.token)).json().activity as { type: string }[];
    expect(activity.some((row) => row.type === 'document_uploaded')).toBe(true);
    expect(activity.some((row) => row.type === 'overwrite_applied')).toBe(false);

    const types = (await events(partner.token)).json().events.map((e: { type: string }) => e.type);
    expect(types).toContain('document_uploaded');
    expect(types).not.toContain('review_decision');
  });

  it('keeps the ops dashboard feed complete', async () => {
    const activity = (await dashboard(ops.token)).json().activity as { type: string; scope: string }[];
    expect(activity.some((row) => row.type === 'overwrite_applied')).toBe(true);
    expect(activity.some((row) => row.type === 'volatility_applied' && row.scope === 'admin')).toBe(true);
  });
});
