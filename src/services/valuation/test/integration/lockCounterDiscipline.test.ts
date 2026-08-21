import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authHeader, isDbAvailable, seedPartner, seedUser, setupTestApp, type TestApp } from './helpers.js';

const dbUp = await isDbAvailable();

/**
 * Which writes move an optimistic-lock counter, and which deliberately do not.
 *
 * A lost-update guard is only as honest as the counter behind it, and the
 * counter has two ways to lie. It lies by *not* moving, when a writer changes a
 * field the guarded form holds and the form is never told — the guard then
 * reports "nobody touched this" about a row somebody touched, which is worse
 * than having no guard, because the analyst believes it. And it lies by moving
 * when nothing the form cares about happened: opening a valuation and leaving a
 * comment both write to `valuations`, and if either bumped the version, every
 * form in the building would start conflicting with readers.
 *
 * Both directions are pinned here. Neither is visible in the code that would
 * break them — `markValuationRead` has no idea a form exists, and the intake
 * seeder's SQL says nothing about who might be holding the row it writes.
 */
describe.skipIf(!dbUp)('optimistic-lock counter discipline', () => {
  let ctx: TestApp;
  let ops: Awaited<ReturnType<typeof seedUser>>;
  let owner: Awaited<ReturnType<typeof seedUser>>;

  beforeAll(async () => {
    ctx = await setupTestApp();
    ops = await seedUser(ctx, { roles: ['admin'] });
    owner = await seedUser(ctx, { roles: ['valuation_user'] });
  });
  afterAll(async () => ctx?.teardown());

  const newValuation = async (companyName: string): Promise<string> => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/valuations',
      headers: authHeader(owner.token),
      payload: { kind: '409a', company_name: companyName },
    });
    expect(res.statusCode, res.body).toBe(201);
    return res.json().valuation.id as string;
  };

  const versionOf = async (table: string, id: string): Promise<number | undefined> => {
    const column = table === 'valuations' ? 'id' : 'valuation_id';
    const { rows } = await ctx.pool.query<{ version: number }>(
      `SELECT version FROM ${table} WHERE ${column} = $1`,
      [id],
    );
    return rows[0]?.version;
  };

  /**
   * Opening a valuation writes `admin_read_at`/`user_read_at` — a marker for
   * the unread-comment badge, on the busiest table in the schema. Bumping the
   * version here would mean every reader invalidated every open editor: the
   * analyst who leaves the form open while a colleague glances at the
   * engagement would be told somebody edited it, and be sent to reload a page
   * nothing had changed.
   */
  it('does not move the version when somebody merely reads the valuation', async () => {
    const id = await newValuation('Read Marker Co');
    // The read marker only writes once a comment exists to be unread.
    const comment = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${id}/comments`,
      headers: authHeader(owner.token),
      payload: { body: 'A question from the client.', kind: 'chat' },
    });
    expect(comment.statusCode, comment.body).toBe(201);

    const before = await versionOf('valuations', id);
    for (const token of [ops.token, owner.token]) {
      const read = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/valuations/${id}`,
        headers: authHeader(token),
      });
      expect(read.statusCode, read.body).toBe(200);
    }
    expect(await versionOf('valuations', id)).toBe(before);
  });

  /**
   * The other half of the same rule. A comment stamps `last_comment_at`, which
   * is not a field the valuation form posts — so it must not conflict with an
   * editor, however many comments the thread collects.
   */
  it('does not move the version when a comment is left', async () => {
    const id = await newValuation('Chatty Co');
    const before = await versionOf('valuations', id);
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${id}/comments`,
      headers: authHeader(owner.token),
      payload: { body: 'Any update on this?', kind: 'chat' },
    });
    expect(res.statusCode, res.body).toBe(201);
    expect(await versionOf('valuations', id)).toBe(before);
  });

  /** …and an editor holding the version from before all of that still saves. */
  it('lets a form saved after a read and a comment through', async () => {
    const id = await newValuation('Undisturbed Co');
    const held = (await versionOf('valuations', id))!;
    await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${id}/comments`,
      headers: authHeader(owner.token),
      payload: { body: 'Still waiting.', kind: 'chat' },
    });
    await ctx.app.inject({ method: 'GET', url: `/api/v1/valuations/${id}`, headers: authHeader(ops.token) });

    const save = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/valuations/${id}`,
      headers: { ...authHeader(ops.token), 'if-match': `"${held}"` },
      payload: { delivery_days: 10 },
    });
    expect(save.statusCode, save.body).toBe(200);
  });

  /**
   * Every door onto `valuation_params` moves its counter, including the two
   * that never send `If-Match` themselves. That is the property the guard rests
   * on: the methodology form is guarded against the *financial model* editor
   * and the roll-forward and the accounting sync, none of which know it exists.
   */
  it('moves the params version through every door that writes the row', async () => {
    const id = await newValuation('Many Doors Co');
    const start = (await versionOf('valuation_params', id))!;

    const params = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/valuations/${id}/params`,
      headers: authHeader(ops.token),
      payload: { runway_months: 14 },
    });
    expect(params.statusCode, params.body).toBe(200);
    expect(await versionOf('valuation_params', id)).toBe(start + 1);

    const model = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/valuations/${id}/engine-inputs`,
      headers: authHeader(ops.token),
      payload: { income: { discount_rate: 0.22 } },
    });
    expect(model.statusCode, model.body).toBe(200);
    expect(await versionOf('valuation_params', id)).toBe(start + 2);
  });

  /**
   * The intake seeder writes methodology columns straight into
   * `valuation_params` with its own UPDATE, and until round 93 it was the one
   * writer of that table that left the counter alone.
   *
   * It is safe today only by accident of *when* it runs — four statements after
   * the valuation is created, so no client can be holding the row. That is a
   * fact about this call site rather than about the statement, and call sites
   * move. The version is asserted here so the statement keeps the discipline
   * regardless of who ends up calling it.
   */
  it('moves the params version when the intake conversion seeds them', async () => {
    const firmId = await seedPartner(ctx, 'Seeding Advisory');
    const firmAdmin = await seedUser(ctx, { roles: ['partner'], partnerId: firmId });

    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/firm/intake-links',
      headers: authHeader(firmAdmin.token),
      payload: { client_name: 'Seeded Co' },
    });
    expect(created.statusCode, created.body).toBe(201);
    const { token } = created.json();

    await ctx.app.inject({ method: 'POST', url: '/api/v1/intake/portal', payload: { token } });
    await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/intake/portal/answers',
      payload: {
        token,
        answers: {
          legal_name: 'Seeded Robotics, Inc.',
          state_of_incorporation: 'Delaware',
          incorporation_date: '2021-03-04',
          industry: 'Robotics',
          business_description: 'Autonomous warehouse robots.',
          // The answer that becomes a params column.
          revenue_status: 'post_revenue',
          total_shares_outstanding: 10_000_000,
          has_articles: true,
        },
      },
    });
    await ctx.app.inject({ method: 'POST', url: '/api/v1/intake/portal/submit', payload: { token } });

    const link = created.json().link as { id: string };
    const converted = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/firm/intake-links/${link.id}/convert`,
      headers: authHeader(firmAdmin.token),
      payload: {},
    });
    expect(converted.statusCode, converted.body).toBe(201);
    const valuationId = converted.json().valuation.id as string;

    // The seed landed…
    const read = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/valuations/${valuationId}/params`,
      headers: authHeader(firmAdmin.token),
    });
    expect(read.json().params.revenue_status).toBe('post_revenue');
    // …and the counter reports that the row was written, not that it is fresh.
    expect(read.json().params.version).toBeGreaterThan(1);
    expect(read.headers.etag).toBe(`"${read.json().params.version}"`);
  });
});
