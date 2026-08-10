import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authHeader, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';

const dbUp = await isDbAvailable();

/**
 * Optimistic locking on valuations (migration 0137).
 *
 * The unit tests prove `patchValuation` refuses a stale version. This proves
 * the version is *reachable over HTTP* — that the GET publishes an ETag worth
 * echoing, that PATCH honours `If-Match`, and that the whole loop closes: read
 * a version, have somebody else save, try to save yourself, get a 409 instead
 * of overwriting them.
 *
 * The lost update this closes is the one nothing else would have caught: both
 * requests succeed, both users see their own change, and only one of the two
 * edits is still there afterwards.
 */
describe.skipIf(!dbUp)('valuation optimistic locking', () => {
  let ctx: TestApp;
  let admin: Awaited<ReturnType<typeof seedUser>>;
  let valuationId: string;

  const get = () =>
    ctx.app.inject({
      method: 'GET',
      url: `/api/v1/valuations/${valuationId}`,
      headers: authHeader(admin.token),
    });

  const patch = (body: Record<string, unknown>, ifMatch?: string) =>
    ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/valuations/${valuationId}`,
      headers: { ...authHeader(admin.token), ...(ifMatch ? { 'if-match': ifMatch } : {}) },
      payload: body,
    });

  beforeAll(async () => {
    ctx = await setupTestApp();
    admin = await seedUser(ctx, { roles: ['admin'] });
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/valuations',
      headers: authHeader(admin.token),
      payload: { kind: '409a', company_name: 'Contended Co' },
    });
    valuationId = created.json().valuation.id;
  });
  afterAll(async () => ctx?.teardown());

  it('publishes the version as an ETag on the read', async () => {
    const res = await get();
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers.etag).toBe(`"${res.json().valuation.version}"`);
  });

  it('bumps the version on every write and reports the new one', async () => {
    const before = (await get()).json().valuation.version as number;
    const res = await patch({ company_name: 'Renamed Once' });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().valuation.version).toBe(before + 1);
    expect(res.headers.etag).toBe(`"${before + 1}"`);
  });

  it('accepts a write whose If-Match is current', async () => {
    const etag = (await get()).headers.etag as string;
    const res = await patch({ company_name: 'Renamed With Etag' }, etag);
    expect(res.statusCode, res.body).toBe(200);
  });

  /** The whole point: the second of two concurrent editors is refused. */
  it('refuses the loser of a concurrent edit rather than overwriting', async () => {
    // Both editors load the page and hold the same version.
    const stale = (await get()).headers.etag as string;

    // The first saves.
    const first = await patch({ company_name: 'First Editor Wins' }, stale);
    expect(first.statusCode, first.body).toBe(200);

    // The second saves the form as *they* loaded it — which still carries the
    // old company_name alongside their own edit.
    const second = await patch({ company_name: 'Second Editor Clobbers' }, stale);
    expect(second.statusCode, second.body).toBe(409);

    // The first editor's change survived.
    const now = await get();
    expect(now.json().valuation.company_name).toBe('First Editor Wins');
  });

  it('names both versions in the conflict so the client can explain itself', async () => {
    const stale = (await get()).headers.etag as string;
    await patch({ company_name: 'Moved On' }, stale);
    const conflict = await patch({ company_name: 'Too Late' }, stale);
    expect(conflict.statusCode).toBe(409);
    const detail = conflict.json().detail as string;
    expect(detail).toContain(stale.replaceAll('"', ''));
    expect(detail).toMatch(/reload/i);
  });

  /**
   * Backwards compatibility, and the reason the check is opt-in: every existing
   * client sends no If-Match and must keep working exactly as before.
   */
  it('falls back to last-write-wins when no If-Match is sent', async () => {
    const stale = (await get()).headers.etag as string;
    await patch({ company_name: 'Someone Else Saved' }, stale);
    const res = await patch({ company_name: 'No Header Here' });
    expect(res.statusCode, res.body).toBe(200);
  });

  it('treats If-Match: * as "it exists", not as a version check', async () => {
    const res = await patch({ company_name: 'Wildcard' }, '*');
    expect(res.statusCode, res.body).toBe(200);
  });

  /**
   * A malformed header is refused rather than ignored. Silently dropping it
   * would turn a request the client believed was protected back into the lost
   * update the header was added to prevent.
   */
  it('rejects a malformed If-Match instead of ignoring it', async () => {
    const res = await patch({ company_name: 'Bad Header' }, '"not-a-version"');
    expect(res.statusCode, res.body).toBe(422);
    expect(res.json().detail).toContain('If-Match');
  });

  /** A no-op patch must not burn a version and start conflicting with real editors. */
  it('does not move the version when the patch changes nothing', async () => {
    const current = (await get()).json().valuation as { version: number; company_name: string };
    const res = await patch({ company_name: current.company_name }, `"${current.version}"`);
    expect(res.statusCode, res.body).toBe(200);
    expect((await get()).json().valuation.version).toBe(current.version);
  });
});
