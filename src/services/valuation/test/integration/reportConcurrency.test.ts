import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authHeader, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';

const dbUp = await isDbAvailable();

/**
 * Optimistic locking on the report body.
 *
 * `valuationConcurrency.test.ts` closes this loop for the engagement's fields.
 * The report body is the other thing two analysts edit at once, and it is the
 * more expensive of the two to lose: the fields are a dozen inputs that can be
 * retyped from a source document, and the body is the prose the deliverable is
 * made of — the chapters somebody spent an afternoon writing.
 *
 * The lost update here is quiet in a way the valuation's is not. `saveVersion`
 * appends, so both saves succeed, both analysts are told "saved as version N",
 * and nothing errors; it is only `current_version` that moves to whichever
 * request finished last. The other analyst's chapters are still in the history,
 * but the report every subsequent read, render and download resolves to is the
 * one written from the stale copy. Nobody is told, and the way you discover it
 * is a client asking why a section is missing from a PDF.
 */
describe.skipIf(!dbUp)('report optimistic locking', () => {
  let ctx: TestApp;
  let admin: Awaited<ReturnType<typeof seedUser>>;
  let valuationId: string;

  const body = (heading: string) => ({
    content: {
      title: 'Valuation Report',
      sections: [{ key: 'intro', heading, html: `<p>${heading} body</p>` }],
    },
  });

  const get = () =>
    ctx.app.inject({
      method: 'GET',
      url: `/api/v1/valuations/${valuationId}/report`,
      headers: authHeader(admin.token),
    });

  const put = (heading: string, ifMatch?: string) =>
    ctx.app.inject({
      method: 'PUT',
      url: `/api/v1/valuations/${valuationId}/report`,
      headers: { ...authHeader(admin.token), ...(ifMatch ? { 'if-match': ifMatch } : {}) },
      payload: body(heading),
    });

  beforeAll(async () => {
    ctx = await setupTestApp();
    admin = await seedUser(ctx, { roles: ['admin'] });
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/valuations',
      headers: authHeader(admin.token),
      payload: { kind: '409a', company_name: 'Contended Prose Co' },
    });
    valuationId = created.json().valuation.id;
  });
  afterAll(async () => ctx?.teardown());

  /**
   * Opening the tab is a read, and two people doing it together is ordinary.
   *
   * A report is instantiated from the template on first ops access, and that is
   * a read of `reports` followed by an INSERT into it. `valuation_id` is UNIQUE,
   * so when the analyst and the reviewer open the same engagement at the same
   * moment — or one person opens it in a second tab — both see nothing, both
   * instantiate, and the second is refused by the constraint. The loser got a
   * 500 on an engagement where nothing was wrong.
   *
   * Two injects genuinely overlap here: the first `await` in each is a round
   * trip to Postgres on its own pooled connection, so the second request's read
   * runs before the first request's insert. This is the one place in this suite
   * where that is true — see R57 on why a webhook race could not be staged the
   * same way.
   */
  it('serves the report to both of two simultaneous first opens', async () => {
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/valuations',
      headers: authHeader(admin.token),
      payload: { kind: '409a', company_name: 'Two Tabs At Once, Inc.' },
    });
    const raced = created.json().valuation.id as string;
    const open = () =>
      ctx.app.inject({
        method: 'GET',
        url: `/api/v1/valuations/${raced}/report`,
        headers: authHeader(admin.token),
      });

    const [a, b] = await Promise.all([open(), open()]);
    expect([a.statusCode, b.statusCode], `${a.body}\n${b.body}`).toEqual([200, 200]);
    // And one report, not two: the constraint is what decided that, and the
    // loser's job is to read what the winner wrote.
    expect(a.json().report.id).toBe(b.json().report.id);
  });

  it('publishes the current version as an ETag on the read', async () => {
    const res = await get();
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers.etag).toBe(`"${res.json().report.current_version}"`);
  });

  it('returns the new version as the ETag of a save', async () => {
    const before = (await get()).json().report.current_version as number;
    const res = await put('Saved Once');
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().version.version).toBe(before + 1);
    expect(res.headers.etag).toBe(`"${before + 1}"`);
  });

  it('accepts a save whose If-Match is current', async () => {
    const etag = (await get()).headers.etag as string;
    const res = await put('Saved With Etag', etag);
    expect(res.statusCode, res.body).toBe(200);
  });

  /** The whole point: the second of two concurrent editors is refused. */
  it('refuses the loser of a concurrent edit rather than overwriting', async () => {
    // Both analysts open the report tab and hold the same version.
    const stale = (await get()).headers.etag as string;

    const first = await put('First Analyst Wins', stale);
    expect(first.statusCode, first.body).toBe(200);

    // The second saves the editor as *they* loaded it — the whole body, which
    // still carries the chapters as they were before the first analyst wrote.
    const second = await put('Second Analyst Clobbers', stale);
    expect(second.statusCode, second.body).toBe(409);

    // And the report the PDF would be rendered from is still the first one's.
    const now = await get();
    expect(now.json().version.content.sections[0].heading).toBe('First Analyst Wins');
  });

  /**
   * Both versions, and no advice to reload.
   *
   * The valuation's conflict says "reload and reapply", which is right for a
   * form of a dozen typed fields. Here the refused payload *is* the analyst's
   * chapters, so reloading is how you lose them — the message has to name the
   * version that landed and say the draft is still there.
   */
  it('names both versions in the conflict without telling the analyst to reload', async () => {
    const before = (await get()).json().report.current_version as number;
    const stale = `"${before}"`;
    await put('Moved On', stale);
    const conflict = await put('Too Late', stale);
    expect(conflict.statusCode).toBe(409);
    const detail = conflict.json().detail as string;
    expect(detail).toContain(`version ${before}`);
    expect(detail).toContain(`${before + 1}`);
    expect(detail).not.toMatch(/reload/i);
  });

  /** Opt-in, exactly as on the valuation: an old client keeps working. */
  it('falls back to last-write-wins when no If-Match is sent', async () => {
    const stale = (await get()).headers.etag as string;
    await put('Someone Else Saved', stale);
    const res = await put('No Header Here');
    expect(res.statusCode, res.body).toBe(200);
  });

  it('treats If-Match: * as "it exists", not as a version check', async () => {
    const res = await put('Wildcard', '*');
    expect(res.statusCode, res.body).toBe(200);
  });

  it('rejects a malformed If-Match instead of ignoring it', async () => {
    const res = await put('Bad Header', '"not-a-version"');
    expect(res.statusCode, res.body).toBe(422);
    expect(res.json().detail).toContain('If-Match');
  });

  /**
   * A revert is a save of somebody else's version, and the same two analysts
   * can collide on it: one restores v2 while the other is mid-edit. It carries
   * the same header for the same reason.
   */
  it('refuses a revert made against a stale version', async () => {
    const stale = (await get()).headers.etag as string;
    await put('Edited Under The Revert', stale);
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${valuationId}/report/revert`,
      headers: { ...authHeader(admin.token), 'if-match': stale },
      payload: { version: 2 },
    });
    expect(res.statusCode, res.body).toBe(409);
  });
});
