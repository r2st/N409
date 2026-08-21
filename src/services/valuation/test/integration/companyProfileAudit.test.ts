import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authHeader, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';

const dbUp = await isDbAvailable();

/**
 * What the audit trail can say about the company profile.
 *
 * Three parties write this row — ops, the client from their portal, and the
 * `company_profile` agent — and the trail's job is to say which of them wrote
 * the sentence a reader is looking at. It could not. The Company tab posts all
 * sixteen columns on every save, and the event recorded the fields the caller
 * *sent*: correcting a postcode produced `company_profile_updated` naming legal
 * name, website, industry, description, SIC, NAICS and ten more, with no values
 * attached to any of them. Every save looked exactly like every other, so the
 * only fact recoverable from a hundred events was that somebody had pressed
 * Save a hundred times.
 *
 * The event now records the fields that moved, with what they moved from and
 * to, which is what `fieldHistory` in domain/auditTrail.ts has always been
 * written to read.
 */
interface Change {
  from: unknown;
  to: unknown;
}

describe.skipIf(!dbUp)('company profile audit trail', () => {
  let ctx: TestApp;
  let ops: Awaited<ReturnType<typeof seedUser>>;
  let valuationId: string;

  beforeAll(async () => {
    ctx = await setupTestApp();
    ops = await seedUser(ctx, { roles: ['admin'] });
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/valuations',
      headers: authHeader(ops.token),
      payload: { kind: '409a', company_name: 'Audited Profile Co' },
    });
    valuationId = created.json().valuation.id;
  });
  afterAll(async () => ctx?.teardown());

  const patch = (body: Record<string, unknown>) =>
    ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/valuations/${valuationId}/company-profile`,
      headers: authHeader(ops.token),
      payload: body,
    });

  const events = async (): Promise<Array<{ changes?: Record<string, Change>; fields?: string[] }>> => {
    const { rows } = await ctx.pool.query<{
      payload: { changes?: Record<string, Change>; fields?: string[] };
    }>(
      `SELECT payload FROM valuation_events
       WHERE valuation_id = $1 AND type = 'company_profile_updated'
       ORDER BY seq`,
      [valuationId],
    );
    return rows.map((r) => r.payload);
  };

  /** Every column the Company tab posts, as it posts them — all sixteen. */
  const wholeForm = (over: Record<string, unknown> = {}) => ({
    legal_name: 'Audited Profile, Inc.',
    website: 'https://audited.example',
    address_line1: '1 Main St',
    address_line2: null,
    city: 'Palo Alto',
    region: 'CA',
    postal_code: '94301',
    country: 'US',
    industry: 'Robotics',
    business_description: 'Autonomous warehouse robots.',
    sic_code: '3559',
    naics_code: '333249',
    founded_on: '2021-03-04',
    employee_count: 40,
    revenue_range: '1m_10m',
    cap_table_summary: null,
    ...over,
  });

  it('records the first save as the fields it actually set', async () => {
    const res = await patch(wholeForm());
    expect(res.statusCode, res.body).toBe(200);
    const [first] = await events();
    // Nulls sent into an empty row are not changes; the thirteen that carry a
    // value are.
    expect(Object.keys(first!.changes ?? {}).sort()).toEqual(
      [
        'address_line1',
        'business_description',
        'city',
        'country',
        'employee_count',
        'founded_on',
        'industry',
        'legal_name',
        'naics_code',
        'postal_code',
        'region',
        'revenue_range',
        'sic_code',
        'website',
      ].sort(),
    );
  });

  /**
   * The one that matters. A one-field correction sent as a sixteen-field form
   * has to read as a one-field correction.
   */
  it('records only the field that moved when the whole form is posted back', async () => {
    const before = (await events()).length;
    const res = await patch(wholeForm({ postal_code: '94304' }));
    expect(res.statusCode, res.body).toBe(200);

    const all = await events();
    expect(all).toHaveLength(before + 1);
    const latest = all[all.length - 1]!;
    expect(Object.keys(latest.changes ?? {})).toEqual(['postal_code']);
    expect(latest.changes!.postal_code).toEqual({ from: '94301', to: '94304' });
  });

  it('carries the prior value, so the trail can say what the field used to be', async () => {
    await patch({ industry: 'Freight logistics' });
    const all = await events();
    expect(all[all.length - 1]!.changes!.industry).toEqual({
      from: 'Robotics',
      to: 'Freight logistics',
    });
  });

  /**
   * A save that moves nothing is not an edit. Recording one would put a row in
   * the trail that an auditor has to read and dismiss — and burning a version
   * for it would conflict a colleague's open form over a click that changed
   * nothing.
   */
  it('records nothing, and burns no version, for a save that changes nothing', async () => {
    const before = await events();
    const read = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/valuations/${valuationId}/company-profile`,
      headers: authHeader(ops.token),
    });
    const version = read.json().profile.version as number;

    const res = await patch(wholeForm({ postal_code: '94304', industry: 'Freight logistics' }));
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().profile.version).toBe(version);
    expect(await events()).toHaveLength(before.length);
  });

  /** Clearing a field is a change, and the trail has to hold what was cleared. */
  it('records a field being cleared, with the value it held', async () => {
    await patch({ website: null });
    const all = await events();
    expect(all[all.length - 1]!.changes!.website).toEqual({
      from: 'https://audited.example',
      to: null,
    });
  });

  /**
   * The audit tab reads these events through `describeEvent`, so the shape has
   * to survive the trip — a payload the reader cannot parse is a change list
   * that renders as a bare label.
   */
  it('renders through the audit trail route as a field-level change', async () => {
    await patch({ city: 'Menlo Park' });
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/valuations/${valuationId}/audit-trail`,
      headers: authHeader(ops.token),
    });
    expect(res.statusCode, res.body).toBe(200);
    const entries = res.json().entries as Array<{
      type: string;
      changes: Array<{ field: string; from: unknown; to: unknown }>;
    }>;
    // The route hands the trail back newest-first (`filterAuditEntries`).
    const latest = entries.filter((e) => e.type === 'company_profile_updated')[0]!;
    expect(latest.changes).toEqual([{ field: 'city', from: 'Palo Alto', to: 'Menlo Park' }]);
  });
});
