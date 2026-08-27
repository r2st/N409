import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createValuation, findValuationById, patchValuation } from '../../src/repos/valuations.js';
import { createCalculation } from '../../src/repos/calculations.js';
import { createReport } from '../../src/repos/reports.js';
import { markValuationsArchived } from '../../src/repos/retention.js';
import { listNotifications } from '../../src/repos/notifications.js';
import {
  authHeader,
  forceState,
  isDbAvailable,
  seedUser,
  setupTestApp,
  type TestApp,
} from './helpers.js';

/**
 * The auditor review journey, end to end: share → access → review → respond →
 * the engagement team hears about it.
 *
 * The last two steps did not exist. The portal served an outside reviewer a
 * report, a conclusion, the assumptions and the QA record, and gave them
 * nowhere to put the answer — every other route into the thread requires an
 * account, and an auditor is the one reader defined by not having one. So a
 * reviewer who found a problem in a signed deliverable left the product, found
 * an email address, and described which valuation they meant; and nothing in
 * the engagement's audit trail recorded that an auditor had raised anything at
 * all.
 *
 * Asserted as a journey rather than as an endpoint: what makes the round trip
 * work is not that the POST returns 201, it is that the note reaches the thread
 * the analyst reads, under the auditor's name, and that somebody is told.
 */

const dbUp = await isDbAvailable();
const actor = { actorType: 'engine' as const, actorId: 'test', source: 'test' };

describe.skipIf(!dbUp)('auditor review journey', () => {
  let ctx: TestApp;
  let owner: Awaited<ReturnType<typeof seedUser>>;
  let reviewer: Awaited<ReturnType<typeof seedUser>>;
  let ops: Awaited<ReturnType<typeof seedUser>>;

  beforeAll(async () => {
    ctx = await setupTestApp();
    owner = await seedUser(ctx, { roles: ['valuation_user'] });
    reviewer = await seedUser(ctx, { roles: ['reviewer'] });
    ops = await seedUser(ctx, { roles: ['admin'] });
  });
  afterAll(async () => ctx?.teardown());

  async function seedValuation(company = 'Auditee Inc') {
    const v = await createValuation(
      ctx.pool,
      { kind: '409a', companyName: company, userId: owner.id },
      { ...actor, actorId: owner.id },
    );
    await createCalculation(
      ctx.pool,
      {
        valuationId: v.id,
        engineVersion: 'py-1.0.0',
        status: 'succeeded',
        inputs: {},
        results: { fmv_per_share: 3.25, equity_value: 12_000_000 },
        equityValue: 12_000_000,
        fmvPerShare: 3.25,
        createdBy: owner.id,
      },
      { ...actor, actorId: owner.id },
    );
    return v;
  }

  const assignReviewer = async (valuationId: string) => {
    const current = (await findValuationById(ctx.pool, valuationId))!;
    await patchValuation(
      ctx.pool,
      current,
      { assigned_reviewer_id: reviewer.id },
      { actorType: 'human', actorId: ops.id, source: 'test' },
    );
  };

  const mintLink = async (valuationId: string, label?: string) => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${valuationId}/auditor-access`,
      headers: authHeader(owner.token),
      payload: label === undefined ? {} : { label },
    });
    expect(res.statusCode).toBe(201);
    return res.json().token as string;
  };

  const submitNote = (payload: object) =>
    ctx.app.inject({ method: 'POST', url: '/api/v1/auditor/portal/notes', payload });

  const opsThread = async (valuationId: string) => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/valuations/${valuationId}/comments`,
      headers: authHeader(ops.token),
    });
    expect(res.statusCode).toBe(200);
    return res.json().comments as Array<{
      kind: string;
      body: string;
      email_meta: { from?: string; subject?: string } | null;
    }>;
  };

  it('carries a change request from the auditor into the thread the analyst reads', async () => {
    const v = await seedValuation();
    // Assigned, so the note has an owner to reach as well as a role group.
    await assignReviewer(v.id);
    const token = await mintLink(v.id, 'PwC · Engagement 4471');

    const res = await submitNote({
      token,
      disposition: 'change_requested',
      body: 'Exhibit C discounts the Series B at 22%; the term sheet on file says 25%.',
    });
    expect(res.statusCode).toBe(201);
    // Echoed back, so the portal can show what it recorded rather than only
    // that something happened.
    expect(res.json().note).toMatchObject({
      disposition: 'change_requested',
      heading: 'Auditor requested a change',
      from: 'Auditor · PwC · Engagement 4471',
    });

    // The step that makes it a journey rather than an endpoint: it is in the
    // engagement's own thread, attributed, and readable by the team.
    const thread = await opsThread(v.id);
    const note = thread.find((c) => c.body.includes('Exhibit C'));
    expect(note, 'the auditor note should be in the engagement thread').toBeDefined();
    expect(note!.kind).toBe('email');
    expect(note!.email_meta?.from).toBe('Auditor · PwC · Engagement 4471');
    expect(note!.email_meta?.subject).toBe('Auditor requested a change');
  });

  it('tells the assigned reviewer and the supervising roles', async () => {
    const v = await seedValuation('Notified Co');
    await assignReviewer(v.id);
    const token = await mintLink(v.id, 'KPMG');
    expect((await submitNote({ token, disposition: 'question', body: 'Which DLOM study?' })).statusCode).toBe(
      201,
    );

    // A note in a thread nobody opened is the same silence the journey started
    // with, so both halves of the recipient rule are asserted: the reviewer
    // whose file it is, and the role group that covers an unassigned one.
    for (const who of [reviewer, ops]) {
      const notifications = await listNotifications(ctx.pool, who.id);
      const hit = notifications.find(
        (n) => n.valuation_id === v.id && n.type === 'auditor_note_received',
      );
      expect(hit, `${who.id} should have been notified`).toBeDefined();
      expect(hit!.title).toContain('Notified Co');
      expect(hit!.body).toContain('Which DLOM study?');
    }
  });

  it('records what happened, not how it arrived', async () => {
    // The comment kind is `email` because that is this platform's vocabulary
    // for a correspondent with no account. The *event* must not inherit it:
    // "Email received" in the audit trail of an engagement an auditor raised a
    // finding on is a log line that describes the transport and hides the fact.
    const v = await seedValuation('Trail Co');
    const token = await mintLink(v.id, 'Deloitte');
    expect((await submitNote({ token, disposition: 'approved', body: 'No exceptions.' })).statusCode).toBe(
      201,
    );

    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/valuations/${v.id}/events`,
      headers: authHeader(ops.token),
    });
    expect(res.statusCode).toBe(200);
    const types = (res.json().events as Array<{ type: string; label?: string }>).map((e) => e.type);
    expect(types).toContain('auditor_note_received');
    expect(types).not.toContain('email_received');
  });

  it('attributes a link that was minted without a label rather than to nobody', async () => {
    const v = await seedValuation('Unlabelled Co');
    const token = await mintLink(v.id);
    const res = await submitNote({ token, disposition: 'question', body: 'Who signed this?' });
    expect(res.statusCode).toBe(201);
    expect(res.json().note.from).toBe('Auditor (unlabelled link)');
  });

  it('does not inflate the access count the link list reports', async () => {
    // `access_count` answers "how often has this auditor opened the link", and
    // ops read it to decide whether a link is still in use. Redeeming for a
    // write would overstate it on exactly the auditors who engage most.
    const v = await seedValuation('Counted Co');
    const token = await mintLink(v.id, 'BDO');
    await ctx.app.inject({ method: 'POST', url: '/api/v1/auditor/portal', payload: { token } });

    const countNow = async () => {
      const res = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/valuations/${v.id}/auditor-access`,
        headers: authHeader(owner.token),
      });
      expect(res.statusCode).toBe(200);
      return (res.json().access as Array<{ access_count: number }>)[0]!.access_count;
    };
    const before = await countNow();
    expect((await submitNote({ token, disposition: 'question', body: 'A question.' })).statusCode).toBe(201);
    expect(await countNow()).toBe(before);
  });

  describe('the ways a note is refused', () => {
    it('refuses a revoked link, so a withdrawn auditor cannot still write', async () => {
      const v = await seedValuation('Revoked Co');
      const token = await mintLink(v.id, 'Ex-auditor');
      const list = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/valuations/${v.id}/auditor-access`,
        headers: authHeader(owner.token),
      });
      const accessId = (list.json().access as Array<{ id: string }>)[0]!.id;
      await ctx.app.inject({
        method: 'DELETE',
        url: `/api/v1/valuations/${v.id}/auditor-access/${accessId}`,
        headers: authHeader(owner.token),
      });
      expect((await submitNote({ token, disposition: 'question', body: 'Still here?' })).statusCode).toBe(401);
    });

    it('refuses a garbage token', async () => {
      expect((await submitNote({ token: 'nope', disposition: 'question', body: 'hi' })).statusCode).toBe(401);
    });

    it('refuses an empty note rather than filing a blank one', async () => {
      const v = await seedValuation('Blank Co');
      const token = await mintLink(v.id, 'EY');
      expect((await submitNote({ token, disposition: 'question', body: '   ' })).statusCode).toBe(422);
    });

    it('tells an auditor the engagement was retired, in the words the read uses', async () => {
      // The same refusal as the read, and for the same reason: a note that
      // vanished into a withdrawn engagement is worse than one that was
      // refused, because the auditor has no way to discover it did.
      const v = await seedValuation('Retired Co');
      const token = await mintLink(v.id, 'Grant Thornton');
      await markValuationsArchived(ctx.pool, [v.id]);
      const res = await submitNote({ token, disposition: 'change_requested', body: 'Please revisit.' });
      expect(res.statusCode).toBe(404);
      expect(res.json().detail).toContain('retired');
    });
  });

  describe('what the bundle says about a report it is not showing', () => {
    it('distinguishes "not shared yet" from "not written yet"', async () => {
      // `report: null` carried two different facts and the portal rendered
      // nothing for either, which reads as a third: that the page is broken.
      const v = await seedValuation('Unshared Co');
      const token = await mintLink(v.id, 'Mazars');
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/auditor/portal',
        payload: { token },
      });
      expect(res.statusCode).toBe(200);
      const bundle = res.json();
      expect(bundle.report).toBeNull();
      // A freshly created engagement has not reached a shared state.
      expect(bundle.report_status).toBe('not_shared');
      expect(bundle.can_submit_notes).toBe(true);
    });

    it('says "available" when there is one to read', async () => {
      const v = await seedValuation('Shared Co');
      await forceState(ctx, v.id, 'drafted');
      await createReport(ctx.pool, {
        valuationId: v.id,
        templateVersion: 'v1',
        content: { title: 'Valuation report', sections: [] } as never,
        actor: { ...actor, actorId: ops.id },
      });

      const token = await mintLink(v.id, 'RSM');
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/auditor/portal',
        payload: { token },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().report_status).toBe('available');
      expect(res.json().report).not.toBeNull();
    });
  });
});
