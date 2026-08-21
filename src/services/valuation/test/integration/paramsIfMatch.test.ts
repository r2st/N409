import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authHeader, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';

const dbUp = await isDbAvailable();

/**
 * Optimistic locking on the methodology form (migration 0158, round 93).
 *
 * The row has carried a `version` since 0158 and every writer has been moving
 * it, but only one of its two editors was reading it. `PATCH /engine-inputs`
 * has been guarded since the migration landed; `PATCH /params` — the larger
 * form by a wide margin, forty-odd fields covering both discounts, all four
 * weights, every study selection and the market and asset blocks — was not.
 * Half a guard on a shared row looks from the outside exactly like none: the
 * panel the analyst spends the most time in was the unprotected one.
 *
 * What made it silent is that the Params panel posts the *whole* methodology
 * from a form it filled in when the tab was opened. The request does not say
 * "set the DLOM"; it says "make this row look like it looked to me". So the
 * loser of the race does not lose — it wins, and reverts everything the other
 * editor changed, with a 200 and an audit event listing only the fields it sent.
 */
describe.skipIf(!dbUp)('valuation params optimistic locking', () => {
  let ctx: TestApp;
  let ops: Awaited<ReturnType<typeof seedUser>>;
  let valuationId: string;

  const get = () =>
    ctx.app.inject({
      method: 'GET',
      url: `/api/v1/valuations/${valuationId}/params`,
      headers: authHeader(ops.token),
    });

  const patch = (body: Record<string, unknown>, ifMatch?: string) =>
    ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/valuations/${valuationId}/params`,
      headers: { ...authHeader(ops.token), ...(ifMatch ? { 'if-match': ifMatch } : {}) },
      payload: body,
    });

  const etag = async () => (await get()).headers.etag as string;
  const overview = async () => (await get()).json().params.business_overview as string | null;

  beforeAll(async () => {
    ctx = await setupTestApp();
    ops = await seedUser(ctx, { roles: ['admin'] });
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/valuations',
      headers: authHeader(ops.token),
      payload: { kind: '409a', company_name: 'Contended Params Co' },
    });
    valuationId = created.json().valuation.id;
  });
  afterAll(async () => ctx?.teardown());

  it('publishes the version as an ETag on the read', async () => {
    const res = await get();
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers.etag).toBe(`"${res.json().params.version}"`);
  });

  it('bumps the version on every save and reports the new one', async () => {
    const before = (await get()).json().params.version as number;
    const res = await patch({ runway_months: 18 });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().params.version).toBe(before + 1);
    expect(res.headers.etag).toBe(`"${before + 1}"`);
  });

  it('accepts a save whose If-Match is current', async () => {
    const res = await patch({ runway_months: 19 }, await etag());
    expect(res.statusCode, res.body).toBe(200);
  });

  /**
   * The whole point. Both analysts hold the same version, both post the whole
   * form; the first commits and the second is refused rather than reverting it.
   */
  it('refuses the loser of a concurrent save rather than overwriting', async () => {
    const stale = await etag();

    const first = await patch({ business_overview: 'Written by the analyst who saved first' }, stale);
    expect(first.statusCode, first.body).toBe(200);

    const second = await patch({ business_overview: 'Written by the stale form' }, stale);
    expect(second.statusCode, second.body).toBe(409);

    expect(await overview()).toBe('Written by the analyst who saved first');
  });

  it('names both versions in the conflict so the client can explain itself', async () => {
    const stale = await etag();
    await patch({ runway_months: 20 }, stale);
    const conflict = await patch({ runway_months: 21 }, stale);
    expect(conflict.statusCode).toBe(409);
    const detail = conflict.json().detail as string;
    expect(detail).toContain(stale.replaceAll('"', ''));
    expect(detail).toMatch(/reload/i);
  });

  /**
   * The reason the version is on the row and not on the form: the other editor
   * of `valuation_params` writes through a different URL entirely. An analyst
   * with the Params tab open while somebody saves the financial model is
   * holding a stale row, and their next save would post the methodology as it
   * stood before that save landed.
   */
  it('is made stale by a write through the engine-inputs door', async () => {
    const stale = await etag();
    const model = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/valuations/${valuationId}/engine-inputs`,
      headers: authHeader(ops.token),
      payload: { income: { discount_rate: 0.25 } },
    });
    expect(model.statusCode, model.body).toBe(200);

    const res = await patch({ runway_months: 22 }, stale);
    expect(res.statusCode, res.body).toBe(409);
  });

  /**
   * A patch that changes nothing still answers the question the caller asked.
   * Reporting success on a row that has moved is the lost-update report one
   * request early: the client takes it as confirmation that its snapshot is
   * current, and the *next* save — the one that does carry changes — is built
   * on the same stale form.
   */
  it('refuses a stale no-op save instead of reporting success', async () => {
    const stale = await etag();
    await patch({ runway_months: 23 }, stale);
    const current = (await get()).json().params.runway_months as number;
    // Same value as the row already holds, so the diff is empty either way.
    const res = await patch({ runway_months: current }, stale);
    expect(res.statusCode, res.body).toBe(409);
  });

  /**
   * Backwards compatibility, and the reason the check is opt-in: every client
   * that sends no If-Match must keep working exactly as before.
   */
  it('falls back to last-write-wins when no If-Match is sent', async () => {
    const stale = await etag();
    await patch({ runway_months: 24 }, stale);
    const res = await patch({ runway_months: 25 });
    expect(res.statusCode, res.body).toBe(200);
  });

  it('treats If-Match: * as "it exists", not as a version check', async () => {
    const res = await patch({ runway_months: 26 }, '*');
    expect(res.statusCode, res.body).toBe(200);
  });

  it('rejects a malformed If-Match instead of ignoring it', async () => {
    const res = await patch({ runway_months: 27 }, '"not-a-version"');
    expect(res.statusCode, res.body).toBe(422);
    expect(res.json().detail).toContain('If-Match');
  });

  /**
   * Staging the real race. Both handlers load the valuation and the params row
   * before they write, so the second genuinely enters `patchParams` on a
   * version the first has not committed yet — and the `FOR UPDATE` the repo
   * already takes is what turns that into a 409 rather than a coin flip.
   */
  it('serialises two truly concurrent guarded saves', async () => {
    const stale = await etag();
    const [a, b] = await Promise.all([
      patch({ business_overview: 'racer A' }, stale),
      patch({ business_overview: 'racer B' }, stale),
    ]);
    const codes = [a.statusCode, b.statusCode].sort();
    expect(codes, `${a.body}\n${b.body}`).toEqual([200, 409]);
    // Exactly one of them is on the row — not a blend, and not the loser.
    expect(['racer A', 'racer B']).toContain(await overview());
  });

  /**
   * The guard has to leave the unguarded callers alone. The accounting sync,
   * the roll-forward and the intake mapper all patch this row without a
   * version, because each is applying values it just derived rather than a form
   * somebody has been looking at.
   */
  it('still bumps the version for a writer that sends no version', async () => {
    const before = (await get()).json().params.version as number;
    const res = await patch({ runway_months: 28 });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().params.version).toBe(before + 1);
  });
});
