import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authHeader, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';

const dbUp = await isDbAvailable();

/**
 * The ASC 718 election is on the engagement's audit spine (R392, methodology
 * M11).
 *
 * `PUT /valuations/:id/asc718/settings` decides how the stock-compensation
 * charge is measured — the expected term every grant that states none of its
 * own inherits, the ESPP discount and lookback, the RSU conditions, the TSR
 * basket, and whether the issuer is measured as public — and it wrote the new
 * row over the old one keeping only `updated_by`/`updated_at`. Who saved last,
 * never what moved. Every one of these cases fails against the pre-fix repo:
 * there was no event of any type to find.
 */
describe.runIf(dbUp)('ASC 718 settings on the audit spine', () => {
  let ctx: TestApp;
  let ops: Awaited<ReturnType<typeof seedUser>>;
  let client: Awaited<ReturnType<typeof seedUser>>;

  beforeAll(async () => {
    ctx = await setupTestApp();
    ops = await seedUser(ctx, { roles: ['reviewer'] });
    client = await seedUser(ctx, { roles: ['valuation_user'] });
  });
  afterAll(() => ctx?.teardown());

  async function seedValuation(company: string): Promise<string> {
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/valuations',
      headers: authHeader(client.token),
      payload: { kind: '718', company_name: company },
    });
    return created.json().valuation.id as string;
  }

  const save = (id: string, payload: Record<string, unknown>) =>
    ctx.app.inject({
      method: 'PUT',
      url: `/api/v1/valuations/${id}/asc718/settings`,
      headers: authHeader(ops.token),
      payload,
    });

  async function events(id: string) {
    const { rows } = await ctx.pool.query<{
      payload: { changes: Record<string, unknown> };
      actor_id: string;
    }>(
      `SELECT payload, actor_id FROM valuation_events
        WHERE valuation_id = $1 AND type = 'asc718_settings_updated'
        ORDER BY seq`,
      [id],
    );
    return rows;
  }

  it('records the first save as a change list from nothing, attributed to the analyst', async () => {
    const id = await seedValuation('FirstSaveCo');
    expect((await save(id, { company_type: 'public', ticker: 'ACME' })).statusCode).toBe(200);

    const rows = await events(id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.actor_id).toBe(ops.id);
    expect(rows[0]!.payload.changes).toMatchObject({
      company_type: { from: null, to: 'public' },
      ticker: { from: null, to: 'ACME' },
      // The default the statement stores, not the field the body omitted.
      expected_term_method: { from: null, to: 'simplified' },
    });
  });

  it('names only the field that moved, and what it had been', async () => {
    const id = await seedValuation('MovedFieldCo');
    await save(id, { company_type: 'public', ticker: 'ACME', expected_term_method: 'simplified' });
    await save(id, { company_type: 'public', ticker: 'ACME', expected_term_method: 'lattice' });

    const rows = await events(id);
    expect(rows).toHaveLength(2);
    expect(Object.keys(rows[1]!.payload.changes)).toEqual(['expected_term_method']);
    expect(rows[1]!.payload.changes.expected_term_method).toEqual({ from: 'simplified', to: 'lattice' });
  });

  it('clearing a field is a change, and reports the value that went', async () => {
    const id = await seedValuation('ClearedCo');
    await save(id, { company_type: 'public', ticker: 'ACME', espp_discount_pct: 0.15 });
    await save(id, { company_type: 'public', ticker: 'ACME' });

    const rows = await events(id);
    expect(rows).toHaveLength(2);
    // `numeric` off the driver is a string; the baseline is normalised before
    // the diff, so this is 0.15 and not "0.150000".
    expect(rows[1]!.payload.changes.espp_discount_pct).toEqual({ from: 0.15, to: null });
  });

  it('a save that moves nothing writes no event and does not restamp the row', async () => {
    const id = await seedValuation('NoOpCo');
    const body = {
      company_type: 'public',
      ticker: 'ACME',
      expected_term_method: 'lattice',
      espp_discount_pct: 0.15,
      espp_lookback_months: 6,
      rsu_performance_conditions: { revenue: 100, ebitda: 20 },
      tsr_peer_basket: [{ name: 'A', volatility: 0.4 }],
    };
    const first = await save(id, body);
    expect(first.statusCode).toBe(200);
    const stamp = first.json().settings.updated_at as string;

    const again = await save(id, body);
    expect(again.statusCode).toBe(200);
    expect(again.json().settings.updated_at).toBe(stamp);
    expect(await events(id)).toHaveLength(1);
  });

  it('a jsonb document resent with its keys in another order is not a change', async () => {
    // The discriminator a raw `JSON.stringify` comparison fails: jsonb does not
    // keep key order, so the stored object and the one the tab re-sends are the
    // same document written two ways. Without the canonical compare, every save
    // would report the basket and the conditions as edits nobody made.
    const id = await seedValuation('ReorderedCo');
    await save(id, {
      company_type: 'private',
      rsu_performance_conditions: { revenue: 100, ebitda: 20 },
    });
    await save(id, {
      company_type: 'private',
      rsu_performance_conditions: { ebitda: 20, revenue: 100 },
    });
    expect(await events(id)).toHaveLength(1);

    // And a real edit to the same column still lands.
    await save(id, {
      company_type: 'private',
      rsu_performance_conditions: { ebitda: 25, revenue: 100 },
    });
    const rows = await events(id);
    expect(rows).toHaveLength(2);
    expect(Object.keys(rows[1]!.payload.changes)).toEqual(['rsu_performance_conditions']);
  });
});
