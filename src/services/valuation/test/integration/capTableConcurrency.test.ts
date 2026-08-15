import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authHeader, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';

const dbUp = await isDbAvailable();

/**
 * Optimistic locking on the cap table (migration 0162).
 *
 * The shape is `valuationConcurrency.test.ts`'s, one table over, but the stakes
 * differ: a lost cap-table write is not one field, it is the whole
 * capitalization. Every figure the platform concludes — the allocation, the
 * fully-diluted denominator, the FMV, Exhibit A — is derived from these rows,
 * so an import that lands on top of a hand-correction moves the conclusion
 * without moving anything a reader would think to check.
 *
 * Two writers share this row and neither used to bump anything: the import
 * route (which `canEdit` opens to the client *and* ops) and the provider sync,
 * which runs on a schedule with no human in the request at all.
 */
const CSV_A = [
  'class,shares,price,invested',
  'Common Stock,8000000,0.10,',
  '"Series A Preferred",2000000,1.00,2000000',
].join('\n');

const CSV_B = [
  'class,shares,price,invested',
  'Common Stock,9000000,0.10,',
  '"Series A Preferred",2000000,1.00,2000000',
].join('\n');

describe.skipIf(!dbUp)('cap table optimistic locking', () => {
  let ctx: TestApp;
  let ops: Awaited<ReturnType<typeof seedUser>>;
  let valuationId: string;

  const get = () =>
    ctx.app.inject({
      method: 'GET',
      url: `/api/v1/valuations/${valuationId}/cap-table`,
      headers: authHeader(ops.token),
    });

  const put = (csv: string, ifMatch?: string) =>
    ctx.app.inject({
      method: 'PUT',
      url: `/api/v1/valuations/${valuationId}/cap-table`,
      headers: { ...authHeader(ops.token), ...(ifMatch ? { 'if-match': ifMatch } : {}) },
      payload: { format: 'generic', csv },
    });

  /** Shares on the named class, as the table currently stands. */
  const sharesOf = async (securityClass: string): Promise<number> => {
    const table = (await get()).json().cap_table as {
      entries: Array<{ security_class: string; shares: number }>;
    };
    const entry = table.entries.find((e) => e.security_class === securityClass);
    if (!entry) throw new Error(`no entry for ${securityClass} in ${JSON.stringify(table.entries)}`);
    return entry.shares;
  };

  beforeAll(async () => {
    ctx = await setupTestApp();
    ops = await seedUser(ctx, { roles: ['admin'] });
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/valuations',
      headers: authHeader(ops.token),
      payload: { kind: '409a', company_name: 'Contended Cap Co' },
    });
    valuationId = created.json().valuation.id;
    // The first import creates the row; everything below contends over it.
    const seeded = await put(CSV_A);
    expect(seeded.statusCode, seeded.body).toBe(200);
  });
  afterAll(async () => ctx?.teardown());

  it('publishes the version as an ETag on the read', async () => {
    const res = await get();
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers.etag).toBe(`"${res.json().cap_table.version}"`);
  });

  it('bumps the version on every import and reports the new one', async () => {
    const before = (await get()).json().cap_table.version as number;
    const res = await put(CSV_B);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().cap_table.version).toBe(before + 1);
    expect(res.headers.etag).toBe(`"${before + 1}"`);
  });

  it('accepts an import whose If-Match is current', async () => {
    const etag = (await get()).headers.etag as string;
    const res = await put(CSV_A, etag);
    expect(res.statusCode, res.body).toBe(200);
  });

  /**
   * The whole point. Both editors hold the same version; the first commits and
   * the second is refused rather than replacing the table underneath them.
   */
  it('refuses the loser of a concurrent import rather than overwriting', async () => {
    const stale = (await get()).headers.etag as string;

    const first = await put(CSV_B, stale);
    expect(first.statusCode, first.body).toBe(200);

    const second = await put(CSV_A, stale);
    expect(second.statusCode, second.body).toBe(409);

    // The first importer's table survived: 9,000,000 common, not 8,000,000.
    expect(await sharesOf('Common Stock')).toBe(9_000_000);
  });

  it('names both versions in the conflict so the client can explain itself', async () => {
    const stale = (await get()).headers.etag as string;
    await put(CSV_A, stale);
    const conflict = await put(CSV_B, stale);
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
    await put(CSV_A, stale);
    const res = await put(CSV_B);
    expect(res.statusCode, res.body).toBe(200);
  });

  it('treats If-Match: * as "it exists", not as a version check', async () => {
    const res = await put(CSV_A, '*');
    expect(res.statusCode, res.body).toBe(200);
  });

  /**
   * A malformed header is refused rather than ignored — dropping it silently
   * would turn a request the client believed was guarded back into the lost
   * update the header exists to prevent.
   */
  it('rejects a malformed If-Match instead of ignoring it', async () => {
    const res = await put(CSV_A, '"not-a-version"');
    expect(res.statusCode, res.body).toBe(422);
    expect(res.json().detail).toContain('If-Match');
  });

  /**
   * Staging the real race, per the rule in the testing notes: two overlapping
   * `inject`s contend for real when the handler's first await is a query on its
   * own pooled connection. Both PUTs here read the valuation before they write,
   * so the second genuinely enters `saveCapTable` on the version the first has
   * not yet bumped — and the `FOR UPDATE` in the repo is what turns that into a
   * 409 rather than a coin flip.
   */
  it('serialises two truly concurrent guarded imports', async () => {
    const stale = (await get()).headers.etag as string;
    const [a, b] = await Promise.all([put(CSV_A, stale), put(CSV_B, stale)]);
    const codes = [a.statusCode, b.statusCode].sort();
    expect(codes, `${a.body}\n${b.body}`).toEqual([200, 409]);
  });

  /**
   * A version that names no row is a conflict, not an insert. The caller is
   * asserting "I read this table at version N"; inserting one anyway would be
   * the silent overwrite in reverse — it would report success for a write built
   * on a table that was never there.
   */
  it('refuses a guarded import against a valuation with no cap table', async () => {
    const fresh = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/valuations',
      headers: authHeader(ops.token),
      payload: { kind: '409a', company_name: 'No Table Yet Co' },
    });
    const freshId = fresh.json().valuation.id as string;

    const read = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/valuations/${freshId}/cap-table`,
      headers: authHeader(ops.token),
    });
    // Nothing stored, so nothing to be stale against — and no ETag offered.
    expect(read.json().cap_table).toBeNull();
    expect(read.headers.etag).toBeUndefined();

    const res = await ctx.app.inject({
      method: 'PUT',
      url: `/api/v1/valuations/${freshId}/cap-table`,
      headers: { ...authHeader(ops.token), 'if-match': '"1"' },
      payload: { format: 'generic', csv: CSV_A },
    });
    expect(res.statusCode, res.body).toBe(409);
  });
});
