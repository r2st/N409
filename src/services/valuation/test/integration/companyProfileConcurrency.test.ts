import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authHeader, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';

const dbUp = await isDbAvailable();

/**
 * Optimistic locking on the company profile (migration 0166).
 *
 * The Company tab loads the profile once when it mounts and posts back all
 * sixteen columns on every save, touched or not — so a save is not "set the
 * website", it is "make this row look like it looked when I opened this tab".
 *
 * Three writers reach the row: ops in the workspace, the requesting client from
 * their own portal, and the `company_profile` agent, whose apply writes
 * business_description, sic_code and naics_code through the same repo. The
 * agent is what turns the race from a possibility into a routine: an analyst
 * asks for a description, the apply lands, and any form that was open before it
 * ran now holds the row as it was *without* the description. Pressing Save
 * writes that back. Both requests return 200, and `company_profile_updated`
 * records the fields the writer sent — which is all of them.
 */
describe.skipIf(!dbUp)('company profile optimistic locking', () => {
  let ctx: TestApp;
  let ops: Awaited<ReturnType<typeof seedUser>>;
  let valuationId: string;

  const newValuation = async (companyName: string): Promise<string> => {
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/valuations',
      headers: authHeader(ops.token),
      payload: { kind: '409a', company_name: companyName },
    });
    expect(created.statusCode, created.body).toBe(201);
    return created.json().valuation.id as string;
  };

  const get = (id = valuationId) =>
    ctx.app.inject({
      method: 'GET',
      url: `/api/v1/valuations/${id}/company-profile`,
      headers: authHeader(ops.token),
    });

  const patch = (body: Record<string, unknown>, ifMatch?: string, id = valuationId) =>
    ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/valuations/${id}/company-profile`,
      headers: { ...authHeader(ops.token), ...(ifMatch ? { 'if-match': ifMatch } : {}) },
      payload: body,
    });

  const etag = async () => (await get()).headers.etag as string;
  const websiteOf = async () => (await get()).json().profile.website as string | null;

  beforeAll(async () => {
    ctx = await setupTestApp();
    ops = await seedUser(ctx, { roles: ['admin'] });
    valuationId = await newValuation('Contended Profile Co');
    // The first save creates the row; everything below contends over it.
    const seeded = await patch({ legal_name: 'Contended Profile, Inc.' });
    expect(seeded.statusCode, seeded.body).toBe(200);
  });
  afterAll(async () => ctx?.teardown());

  it('publishes the version as an ETag on the read', async () => {
    const res = await get();
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers.etag).toBe(`"${res.json().profile.version}"`);
  });

  /**
   * Nothing stored means nothing to be stale against, so no ETag is offered —
   * an ETag on "null" would invite an If-Match that could only ever conflict.
   */
  it('offers no ETag for a profile that has never been saved', async () => {
    const fresh = await newValuation('No Profile Yet Co');
    const res = await get(fresh);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().profile).toBeNull();
    expect(res.headers.etag).toBeUndefined();
  });

  it('bumps the version on every save and reports the new one', async () => {
    const before = (await get()).json().profile.version as number;
    const res = await patch({ website: 'https://one.example' });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().profile.version).toBe(before + 1);
    expect(res.headers.etag).toBe(`"${before + 1}"`);
  });

  it('accepts a save whose If-Match is current', async () => {
    const res = await patch({ website: 'https://two.example' }, await etag());
    expect(res.statusCode, res.body).toBe(200);
  });

  it('refuses the loser of a concurrent save rather than overwriting', async () => {
    const stale = await etag();

    const first = await patch({ website: 'https://saved-first.example' }, stale);
    expect(first.statusCode, first.body).toBe(200);

    const second = await patch({ website: 'https://stale-form.example' }, stale);
    expect(second.statusCode, second.body).toBe(409);

    expect(await websiteOf()).toBe('https://saved-first.example');
  });

  /**
   * The agent's half of the story. Its apply calls the same repo function with
   * no version — it is writing what it just derived, not a form somebody has
   * been looking at — so it bumps the counter like any other writer, and the
   * form that was open before it ran is refused instead of reverting it.
   */
  it('is made stale by an unguarded write, which is what the agent apply is', async () => {
    const openForm = await etag();

    const agentShaped = await patch({
      business_description: 'A drafted description the agent produced.',
      sic_code: '7372',
      naics_code: '541511',
    });
    expect(agentShaped.statusCode, agentShaped.body).toBe(200);

    const humanSave = await patch(
      { business_description: null, sic_code: null, naics_code: null, website: 'https://late.example' },
      openForm,
    );
    expect(humanSave.statusCode, humanSave.body).toBe(409);

    // The description survived, which it would not have on a form that posts
    // all sixteen columns as they stood before the apply.
    expect((await get()).json().profile.business_description).toBe(
      'A drafted description the agent produced.',
    );
  });

  it('names both versions in the conflict so the client can explain itself', async () => {
    const stale = await etag();
    await patch({ city: 'Palo Alto' }, stale);
    const conflict = await patch({ city: 'Menlo Park' }, stale);
    expect(conflict.statusCode).toBe(409);
    const detail = conflict.json().detail as string;
    expect(detail).toContain(stale.replaceAll('"', ''));
    expect(detail).toMatch(/reload/i);
  });

  it('falls back to last-write-wins when no If-Match is sent', async () => {
    const stale = await etag();
    await patch({ city: 'Redwood City' }, stale);
    const res = await patch({ city: 'San Mateo' });
    expect(res.statusCode, res.body).toBe(200);
  });

  it('treats If-Match: * as "it exists", not as a version check', async () => {
    const res = await patch({ city: 'Belmont' }, '*');
    expect(res.statusCode, res.body).toBe(200);
  });

  it('rejects a malformed If-Match instead of ignoring it', async () => {
    const res = await patch({ city: 'San Carlos' }, '"not-a-version"');
    expect(res.statusCode, res.body).toBe(422);
    expect(res.json().detail).toContain('If-Match');
  });

  it('serialises two truly concurrent guarded saves', async () => {
    const stale = await etag();
    const [a, b] = await Promise.all([
      patch({ website: 'https://racer-a.example' }, stale),
      patch({ website: 'https://racer-b.example' }, stale),
    ]);
    const codes = [a.statusCode, b.statusCode].sort();
    expect(codes, `${a.body}\n${b.body}`).toEqual([200, 409]);
    expect(['https://racer-a.example', 'https://racer-b.example']).toContain(await websiteOf());
  });

  /**
   * A version naming no row is a conflict, not an insert. The caller says "I
   * read this profile at version 1"; creating one anyway would report success
   * for a write built on a row that was never there — the silent overwrite in
   * reverse.
   */
  it('refuses a guarded save against a profile that does not exist', async () => {
    const fresh = await newValuation('Still No Profile Co');
    const res = await patch({ legal_name: 'Invented' }, '"1"', fresh);
    expect(res.statusCode, res.body).toBe(409);
    expect((await get(fresh)).json().profile).toBeNull();
  });
});
