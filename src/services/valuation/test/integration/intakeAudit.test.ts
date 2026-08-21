import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authHeader, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';

const dbUp = await isDbAvailable();

/**
 * What the audit trail can say about the client's own answers.
 *
 * `intake_saved` is one of the few events the *client* can see, and the answers
 * behind it become statements of fact in the deliverable — "10,000,000 shares
 * outstanding, per the company". So the question the trail has to answer is
 * whether a figure the report relies on was ever something else, and who moved
 * it: the client, or the analyst editing the same questionnaire from the
 * workspace.
 *
 * It recorded `{ fields: [every key in the section] }`. The wizard saves a
 * whole section at a time, so eleven saves of the company-details section
 * produced eleven identical events, and the share count could have changed in
 * any of them or none.
 */
interface Change {
  from: unknown;
  to: unknown;
}

describe.skipIf(!dbUp)('intake audit trail', () => {
  let ctx: TestApp;
  let owner: Awaited<ReturnType<typeof seedUser>>;
  let valuationId: string;

  beforeAll(async () => {
    ctx = await setupTestApp();
    owner = await seedUser(ctx, { roles: ['valuation_user'] });
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/valuations',
      headers: authHeader(owner.token),
      payload: { kind: '409a', company_name: 'Audited Intake Co' },
    });
    valuationId = created.json().valuation.id;
  });
  afterAll(async () => ctx?.teardown());

  const save = (answers: Record<string, unknown>) =>
    ctx.app.inject({
      method: 'PUT',
      url: `/api/v1/valuations/${valuationId}/questionnaire`,
      headers: authHeader(owner.token),
      payload: { answers },
    });

  const events = async (): Promise<Array<{ changes?: Record<string, Change>; fields?: string[] }>> => {
    const { rows } = await ctx.pool.query<{
      payload: { changes?: Record<string, Change>; fields?: string[] };
    }>(
      `SELECT payload FROM valuation_events
       WHERE valuation_id = $1 AND type = 'intake_saved'
       ORDER BY seq`,
      [valuationId],
    );
    return rows.map((r) => r.payload);
  };

  /** One section of the wizard, as the wizard posts it: every field in it. */
  const section = (over: Record<string, unknown> = {}) => ({
    legal_name: 'Audited Intake, Inc.',
    state_of_incorporation: 'Delaware',
    incorporation_date: '2021-03-04',
    industry: 'Robotics',
    total_shares_outstanding: 10_000_000,
    ...over,
  });

  it('records the answers a first save actually supplied', async () => {
    const res = await save(section());
    expect(res.statusCode, res.body).toBe(200);
    const [first] = await events();
    expect(Object.keys(first!.changes ?? {}).sort()).toEqual(
      [
        'incorporation_date',
        'industry',
        'legal_name',
        'state_of_incorporation',
        'total_shares_outstanding',
      ].sort(),
    );
    expect(first!.changes!.total_shares_outstanding).toEqual({ from: null, to: 10_000_000 });
  });

  /**
   * The one that matters: the figure the report will quote, changed, in a save
   * that carried the whole section unchanged around it.
   */
  it('records only the answer that moved when a whole section is posted back', async () => {
    const before = (await events()).length;
    const res = await save(section({ total_shares_outstanding: 12_000_000 }));
    expect(res.statusCode, res.body).toBe(200);

    const all = await events();
    expect(all).toHaveLength(before + 1);
    expect(Object.keys(all[all.length - 1]!.changes ?? {})).toEqual(['total_shares_outstanding']);
    expect(all[all.length - 1]!.changes!.total_shares_outstanding).toEqual({
      from: 10_000_000,
      to: 12_000_000,
    });
  });

  /**
   * Saving a section the client did not touch is what the wizard does on every
   * Next click. Recording it would fill the client's own trail with rows that
   * say nothing.
   */
  it('records nothing for a save that answers nothing new', async () => {
    const before = await events();
    const res = await save(section({ total_shares_outstanding: 12_000_000 }));
    expect(res.statusCode, res.body).toBe(200);
    expect(await events()).toHaveLength(before.length);
  });

  it('records an answer being cleared, with the value it held', async () => {
    await save({ industry: null });
    const all = await events();
    expect(all[all.length - 1]!.changes!.industry).toEqual({ from: 'Robotics', to: null });
  });

  it('renders through the audit trail route as a field-level change', async () => {
    await save({ state_of_incorporation: 'Nevada' });
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/valuations/${valuationId}/audit-trail`,
      headers: authHeader(owner.token),
    });
    expect(res.statusCode, res.body).toBe(200);
    const entries = res.json().entries as Array<{
      type: string;
      changes: Array<{ field: string; from: unknown; to: unknown }>;
    }>;
    // Newest-first, per `filterAuditEntries`.
    const latest = entries.filter((e) => e.type === 'intake_saved')[0]!;
    expect(latest.changes).toEqual([{ field: 'state_of_incorporation', from: 'Delaware', to: 'Nevada' }]);
  });
});
