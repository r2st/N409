import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createValuation, findValuationById, invalidateValuation } from '../../src/repos/valuations.js';
import { retireValuations } from '../../src/repos/valuationPurge.js';
import { runRetentionSweep } from '../../src/routes/retention.js';
import { authHeader, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';

const dbUp = await isDbAvailable();
const actor = { actorType: 'human' as const, actorId: 'test', source: 'test' };

/**
 * Putting an archived engagement back.
 *
 * WHAT WAS MISSING. `valuations.archived_at` is the platform's soft delete and
 * nothing ever set it back to NULL. Two things stamp it — the retention sweep
 * and `retireValuations` — and R89 then made all 86 writes under a valuation id
 * refuse a stamped row. That was right, and it turned an untidiness into a real
 * hole: an engagement archived by a mistyped id, or by an admin who set the
 * policy to 90 days meaning 900, was frozen permanently with no way back
 * through the product. `restoreUser` exists for users and partners have their
 * own unarchive; the aggregate holding the client's actual work had neither.
 * `valuationPurge.ts` had even claimed otherwise in a comment since it was
 * written — "It is also reversible, which a delete is not" — which was true of
 * the schema and false of the codebase.
 *
 * THE PART WORTH TESTING HARDEST is not that the flag clears. It is that a
 * restore which tonight's sweep would simply undo has to say so. An admin who
 * sees a 200, watches the engagement come back and finds it gone again by
 * morning has been told something false, and there is nothing in the product
 * that would explain it. So the route asks the sweep's own two questions first
 * — past the cutoff, and frozen by a hold — and the tests below drive the sweep
 * for real afterwards rather than trusting that reasoning.
 */
describe.skipIf(!dbUp)('restoring an archived valuation', () => {
  let ctx: TestApp;
  let admin: Awaited<ReturnType<typeof seedUser>>;
  let plainUser: Awaited<ReturnType<typeof seedUser>>;

  beforeAll(async () => {
    ctx = await setupTestApp();
    admin = await seedUser(ctx, { roles: ['admin'] });
    plainUser = await seedUser(ctx, { roles: ['valuation_user'] });
  }, 60_000);
  afterAll(async () => ctx?.teardown());

  async function makeValuation(company: string, ageDays = 0): Promise<string> {
    const v = await createValuation(
      ctx.pool,
      { kind: '409a', companyName: company, userId: admin.id },
      { ...actor, actorId: admin.id },
    );
    if (ageDays > 0) {
      await ctx.pool.query(
        `UPDATE valuations SET created_at = now() - ($2 || ' days')::interval WHERE id = $1`,
        [v.id, String(ageDays)],
      );
      invalidateValuation(v.id);
    }
    return v.id;
  }

  const restore = (id: string, body: unknown = {}, token = admin.token) =>
    ctx.app.inject({
      method: 'POST',
      url: `/api/v1/admin/retention/valuations/${id}/restore`,
      headers: authHeader(token),
      payload: body,
    });

  async function setPolicy(days: number | null, enabled = true) {
    const res = await ctx.app.inject({
      method: 'PUT',
      url: '/api/v1/admin/retention/policies/valuation',
      headers: authHeader(admin.token),
      payload: { archive_after_days: days, retention_days: null, enabled },
    });
    expect(res.statusCode).toBe(200);
  }

  it('clears the flag and the suffix, and the engagement takes writes again', async () => {
    await setPolicy(null);
    const id = await makeValuation('Withdrawn By Mistake');
    await retireValuations(ctx.pool, [id]);

    // The state it is being rescued from: R89's guard, refusing a write.
    const before = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/valuations/${id}`,
      headers: authHeader(admin.token),
      payload: { company_name: 'Anything' },
    });
    expect(before.statusCode).toBe(409);
    expect(JSON.stringify(before.json())).toMatch(/retired/i);

    const res = await restore(id);
    expect(res.statusCode).toBe(200);
    expect(res.json().restored).toBe(true);
    expect(res.json().valuation.archived_at).toBeNull();
    // The suffix retirement appended to free the name comes off with the flag:
    // an engagement that is live again must not read as retired.
    expect(res.json().valuation.company_name).toBe('Withdrawn By Mistake');

    const after = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/valuations/${id}`,
      headers: authHeader(admin.token),
      payload: { company_name: 'Renamed After Restore' },
    });
    expect(after.statusCode).toBeLessThan(300);
  });

  /**
   * The cache is the failure this would have had in production and nowhere
   * else. `findValuationById` is read-through with a TTL, so a restore that
   * does not drop the entry leaves `archived_at` non-null in memory and every
   * write keeps answering 409 after the row is live — a bug that looks exactly
   * like the restore not working, on a route that just said it did.
   */
  it('drops the cached row, so the restore is visible immediately', async () => {
    await setPolicy(null);
    const id = await makeValuation('Cache Check Co');
    await retireValuations(ctx.pool, [id]);
    // Warm the cache with the archived row, which is what a page load does.
    expect((await findValuationById(ctx.pool, id))!.archived_at).not.toBeNull();

    expect((await restore(id)).statusCode).toBe(200);
    expect((await findValuationById(ctx.pool, id))!.archived_at).toBeNull();
  });

  it('appears in the lists it had left', async () => {
    await setPolicy(null);
    const id = await makeValuation('Back In The List Co');
    await retireValuations(ctx.pool, [id]);

    const listIds = async () => {
      const res = await ctx.app.inject({
        method: 'GET',
        url: '/api/v1/valuations?per_page=100',
        headers: authHeader(admin.token),
      });
      return (res.json().valuations as Array<{ id: string }>).map((v) => v.id);
    };
    expect(await listIds()).not.toContain(id);
    expect((await restore(id)).statusCode).toBe(200);
    expect(await listIds()).toContain(id);
  });

  it('records the restore in the retention action log, beside the archival', async () => {
    await setPolicy(null);
    const id = await makeValuation('Audited Restore Co');
    await retireValuations(ctx.pool, [id]);
    expect((await restore(id)).statusCode).toBe(200);

    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/admin/retention/actions',
      headers: authHeader(admin.token),
    });
    const mine = (res.json().actions as Array<{ action: string; reference_id: string; detail: unknown }>)
      .filter((a) => a.reference_id === id)
      .map((a) => a);
    expect(mine.map((a) => a.action)).toContain('restored');
    expect((mine.find((a) => a.action === 'restored')!.detail as { restored_by: string }).restored_by).toBe(
      admin.id,
    );
  });

  /**
   * The refusal, and then the proof that the refusal was right.
   *
   * The route's reasoning is that the sweep would take the row straight back.
   * That is checked by running the sweep, not by re-reading the condition: if
   * `isDueForArchival` and `findArchivableValuations` ever disagree about what
   * "past the cutoff" means, this is the test that notices.
   */
  it('refuses a restore the next sweep would immediately undo, and is right about it', async () => {
    await setPolicy(30);
    const id = await makeValuation('Aged Out Co', 400);
    await retireValuations(ctx.pool, [id]);

    const refused = await restore(id);
    expect(refused.statusCode).toBe(409);
    expect(refused.json().detail).toMatch(/sweep would archive it again/i);

    // Restore it anyway, which is the escape hatch the message names…
    const forced = await restore(id, { acknowledge_rearchival: true });
    expect(forced.statusCode).toBe(200);
    expect(forced.json().valuation.archived_at).toBeNull();

    // …and the sweep really does take it back, which is what made the refusal
    // worth having rather than merely cautious.
    const swept = await runRetentionSweep(ctx.pool);
    expect(swept.archived).toBeGreaterThanOrEqual(1);
    expect((await findValuationById(ctx.pool, id))!.archived_at).not.toBeNull();
  });

  /**
   * A legal hold is the other thing that would hold it, and the route accepts
   * it as one rather than only understanding "widen the policy". The hold is
   * placed on the valuation; the sweep also honours global and per-user holds,
   * which `findArchivableValuations` already covers.
   */
  it('allows the restore with no acknowledgement once a hold freezes the row', async () => {
    await setPolicy(30);
    const id = await makeValuation('Held Co', 400);
    await retireValuations(ctx.pool, [id]);
    expect((await restore(id)).statusCode).toBe(409);

    const hold = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/admin/retention/holds',
      headers: authHeader(admin.token),
      payload: { scope: 'valuation', reference_id: id, reason: 'restored for an audit' },
    });
    expect(hold.statusCode).toBe(201);

    expect((await restore(id)).statusCode).toBe(200);
    const swept = await runRetentionSweep(ctx.pool);
    expect(swept.skipped_hold).toBeGreaterThanOrEqual(1);
    expect((await findValuationById(ctx.pool, id))!.archived_at).toBeNull();
  });

  it('does not refuse when the policy is disabled or has no cutoff', async () => {
    const id = await makeValuation('No Policy Co', 4000);
    await retireValuations(ctx.pool, [id]);
    await setPolicy(30, false);
    expect((await restore(id)).statusCode).toBe(200);
  });

  it('refuses to restore something that is not archived', async () => {
    await setPolicy(null);
    const id = await makeValuation('Perfectly Fine Co');
    const res = await restore(id);
    // A 409 rather than a 404: the engagement is real and the reason there is
    // nothing to do is its state. `refuseIfRetired` draws the same line facing
    // the other way.
    expect(res.statusCode).toBe(409);
    expect(res.json().detail).toMatch(/not archived/i);
  });

  it('404s an unknown or malformed id', async () => {
    expect((await restore('01ARZ3NDEKTSV4RRFFQ69G5FAV')).statusCode).toBe(404);
    expect((await restore('not-an-id')).statusCode).toBe(404);
  });

  // Admin-only, like every other route on this surface. A restore un-freezes an
  // engagement the firm's own users cannot re-freeze, so it is not something to
  // hand to whoever happens to hold the file.
  it('is refused to a non-admin', async () => {
    await setPolicy(null);
    const id = await makeValuation('Not Yours Co');
    await retireValuations(ctx.pool, [id]);
    const res = await restore(id, {}, plainUser.token);
    expect(res.statusCode).toBe(403);
    // …and it really is still archived, so the 403 was a refusal and not a
    // refusal-shaped response after the write.
    expect((await findValuationById(ctx.pool, id))!.archived_at).not.toBeNull();
  });

  it('reports a second restore as nothing done rather than failing', async () => {
    await setPolicy(null);
    const id = await makeValuation('Twice Restored Co');
    await retireValuations(ctx.pool, [id]);
    expect((await restore(id)).statusCode).toBe(200);
    // The row is live now, so this is the "not archived" refusal — the same
    // answer a stale browser tab clicking restore twice would get.
    expect((await restore(id)).statusCode).toBe(409);
  });
});

/**
 * Withdrawing an engagement, which had no implementation at all.
 *
 * Four rounds of comments say `archived_at` is stamped "by the retention sweep
 * when a policy period runs out, and by `retireValuations` when a firm
 * withdraws a piece of work". The first half was true. The second described a
 * function whose only caller was the sample seeder — so the 86 guarded writes,
 * the partner API's three, the auditor portal's refusal to re-share and the
 * board flow's refusal to re-mint were all reachable only by waiting out a
 * retention policy, and an admin who needed to withdraw a live engagement today
 * could not.
 */
describe.skipIf(!dbUp)('retiring an engagement on purpose', () => {
  let ctx: TestApp;
  let admin: Awaited<ReturnType<typeof seedUser>>;
  let plainUser: Awaited<ReturnType<typeof seedUser>>;

  beforeAll(async () => {
    ctx = await setupTestApp();
    admin = await seedUser(ctx, { roles: ['admin'] });
    plainUser = await seedUser(ctx, { roles: ['valuation_user'] });
  }, 60_000);
  afterAll(async () => ctx?.teardown());

  const make = async (company: string) =>
    (
      await createValuation(
        ctx.pool,
        { kind: '409a', companyName: company, userId: admin.id },
        { ...actor, actorId: admin.id },
      )
    ).id;

  const retire = (id: string, body: unknown = {}, token = admin.token) =>
    ctx.app.inject({
      method: 'POST',
      url: `/api/v1/admin/retention/valuations/${id}/retire`,
      headers: authHeader(token),
      payload: body,
    });

  it('stamps the flag, renames the company, and closes the writes', async () => {
    const id = await make('Walked Away Co');
    // The live half of the pair: this same request succeeds before the retire.
    const before = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/valuations/${id}`,
      headers: authHeader(admin.token),
      payload: { company_name: 'Walked Away Co' },
    });
    expect(before.statusCode).toBeLessThan(300);

    const res = await retire(id, { reason: 'client withdrew the engagement' });
    expect(res.statusCode).toBe(200);
    expect(res.json().retired).toBe(true);
    expect(res.json().valuation.archived_at).not.toBeNull();
    // Named in the response because an admin who did not expect the company
    // name to change should learn it from the answer, not a support ticket.
    expect(res.json().valuation.company_name).toBe('Walked Away Co [retired]');

    const after = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/valuations/${id}`,
      headers: authHeader(admin.token),
      payload: { company_name: 'Anything' },
    });
    expect(after.statusCode).toBe(409);
    expect(JSON.stringify(after.json())).toMatch(/retired/i);
  });

  /**
   * The round trip, which is the point of the pair existing.
   *
   * `retireValuations` was written for the seeder and its rename was never
   * meant to survive; `restoreValuations` takes the suffix back off. A retire
   * followed by a restore has to leave the row exactly as it was found, or the
   * undo is not one.
   */
  it('round-trips through restore, name and all', async () => {
    const id = await make('There And Back Co');
    expect((await retire(id)).statusCode).toBe(200);
    const restored = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/admin/retention/valuations/${id}/restore`,
      headers: authHeader(admin.token),
      payload: {},
    });
    expect(restored.statusCode).toBe(200);
    expect(restored.json().valuation.company_name).toBe('There And Back Co');
    expect(restored.json().valuation.archived_at).toBeNull();
  });

  /**
   * Logged as `archived` rather than under a name of its own, so the restore
   * control offers itself against a manual retirement without knowing there is
   * such a thing. `manual` and `reason` are what separate the two for a reader.
   */
  it('records an archival the log and the restore control both understand', async () => {
    const id = await make('Logged Withdrawal Co');
    expect((await retire(id, { reason: 'duplicate engagement' })).statusCode).toBe(200);

    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/admin/retention/actions',
      headers: authHeader(admin.token),
    });
    const entry = (
      res.json().actions as Array<{ action: string; reference_id: string; detail: Record<string, unknown> }>
    ).find((a) => a.reference_id === id)!;
    expect(entry.action).toBe('archived');
    expect(entry.detail).toMatchObject({
      manual: true,
      retired_by: admin.id,
      reason: 'duplicate engagement',
    });
  });

  it('drops it out of the lists it was in', async () => {
    const id = await make('Gone From The List Co');
    const listIds = async () => {
      const res = await ctx.app.inject({
        method: 'GET',
        url: '/api/v1/valuations?per_page=100',
        headers: authHeader(admin.token),
      });
      return (res.json().valuations as Array<{ id: string }>).map((v) => v.id);
    };
    expect(await listIds()).toContain(id);
    expect((await retire(id)).statusCode).toBe(200);
    expect(await listIds()).not.toContain(id);
  });

  it('refuses a second retirement instead of double-suffixing the name', async () => {
    const id = await make('Only Once Co');
    expect((await retire(id)).statusCode).toBe(200);
    const again = await retire(id);
    expect(again.statusCode).toBe(409);
    expect(again.json().detail).toMatch(/already retired/i);
    const row = (await findValuationById(ctx.pool, id))!;
    expect(row.company_name).toBe('Only Once Co [retired]');
  });

  it('takes a reason or no reason, and refuses an empty one', async () => {
    const id = await make('Blank Reason Co');
    // An empty string is a client that built the body wrong, not an omission —
    // omitting the field is how you say "no reason given".
    const blank = await retire(id, { reason: '   ' });
    expect(blank.statusCode).toBe(422);
    expect((await findValuationById(ctx.pool, id))!.archived_at).toBeNull();
    expect((await retire(id)).statusCode).toBe(200);
  });

  it('404s an unknown or malformed id', async () => {
    expect((await retire('01ARZ3NDEKTSV4RRFFQ69G5FAV')).statusCode).toBe(404);
    expect((await retire('not-an-id')).statusCode).toBe(404);
  });

  it('is refused to a non-admin, and really does nothing', async () => {
    const id = await make('Not Your Call Co');
    expect((await retire(id, {}, plainUser.token)).statusCode).toBe(403);
    expect((await findValuationById(ctx.pool, id))!.archived_at).toBeNull();
  });
});
