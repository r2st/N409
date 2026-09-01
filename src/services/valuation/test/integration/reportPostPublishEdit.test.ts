import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authHeader, forceState, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';
import { readable } from './support/pdfText.js';

const dbUp = await isDbAvailable();

/**
 * A report body edited after the engagement published.
 *
 * `PUT /report` is guarded by `refuseIfRetired` and by nothing else, on
 * purpose — an analyst may keep working in the editor whatever state the
 * engagement is in. The publish gate is what makes a body a *deliverable*:
 * signed, QA'd against the calculation it states, and rendered without the
 * draft stamp. It runs on the transition into `published`, and `published` has
 * no outgoing edges in `WORKFLOW_TRANSITIONS`, so it never runs again.
 *
 * That left the newest saved body free to become the deliverable on its own.
 * `GET /report.pdf` served `reports.current_version`, found no stored bytes for
 * the version saved after publication, and the lazy render filled them in —
 * unwatermarked, with the certification block resolved from the signature rows
 * on file. The document the board and the auditor download was then the edited
 * prose under the original signer's name and the original signing date, at a
 * version number nobody asked to issue. There is no re-sign to offer either:
 * `upsertSignature` refuses a published engagement.
 *
 * So the delivered version is pinned: the newest version carrying stored bytes,
 * which is the question the evidence bundle and the partner API already asked
 * and this door did not. The deliberate re-render stays open — `POST
 * /report/render` on a published engagement is an analyst choosing to issue a
 * revision, and `reportDeliverable.test.ts` pins that as the escape hatch. What
 * closes is a client's download doing it for them.
 */
describe.skipIf(!dbUp)('a report edited after publication', () => {
  let ctx: TestApp;
  let ops: { id: string; token: string };
  let client: { id: string; token: string };

  beforeAll(async () => {
    ctx = await setupTestApp({ AUTO_PIPELINE: 'off', EMAIL_MODE: 'off' });
    ops = await seedUser(ctx, { roles: ['reviewer'] });
    client = await seedUser(ctx, { roles: ['valuation_user'] });
  }, 120_000);
  afterAll(async () => ctx?.teardown());

  /** Which versions hold bytes, oldest first. */
  const cached = async (valuationId: string): Promise<boolean[]> => {
    const { rows } = await ctx.pool.query<{ has_pdf: boolean }>(
      `SELECT (v.pdf IS NOT NULL) AS has_pdf FROM report_versions v
         JOIN reports r ON r.id = v.report_id
        WHERE r.valuation_id = $1
        ORDER BY v.version`,
      [valuationId],
    );
    return rows.map((r) => r.has_pdf);
  };

  /**
   * A published engagement whose v1 has been rendered and delivered, plus a v2
   * saved afterwards carrying a title no signed document ever said.
   */
  async function publishedThenEdited(name: string): Promise<string> {
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/valuations',
      headers: authHeader(client.token),
      payload: { kind: '409a', company_name: name },
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().valuation.id as string;

    // First ops read instantiates the body from the template.
    const report = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/valuations/${id}/report`,
      headers: authHeader(ops.token),
    });
    expect(report.statusCode).toBe(200);
    const content = report.json().version.content as { title: string; sections: unknown[] };

    // The deliverable: rendered, then published. v1 now holds bytes.
    const rendered = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${id}/report/render`,
      headers: authHeader(ops.token),
      payload: {},
    });
    expect(rendered.statusCode).toBe(200);
    await forceState(ctx, id, 'published');

    const saved = await ctx.app.inject({
      method: 'PUT',
      url: `/api/v1/valuations/${id}/report`,
      headers: authHeader(ops.token),
      payload: { content: { ...content, title: 'Unsigned Revision After Publication' } },
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().version.version).toBe(2);
    return id;
  }

  it('goes on delivering the version that was signed and rendered', async () => {
    const id = await publishedThenEdited('Edited After Publication, Inc.');

    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/valuations/${id}/report.pdf`,
      headers: authHeader(client.token),
    });
    expect(res.statusCode).toBe(200);
    expect(readable(res.rawPayload)).not.toContain('Unsigned Revision After Publication');

    // And the edit never acquired bytes of its own: the lazy render is what
    // used to promote it, so a v2 that stays uncached is the property.
    expect(await cached(id)).toEqual([true, false]);

    // The download is recorded against the version that was actually served.
    const { rows } = await ctx.pool.query<{ version: number }>(
      `SELECT (payload->>'version')::int AS version FROM valuation_events
        WHERE valuation_id = $1 AND type = 'report_downloaded'
        ORDER BY occurred_at DESC, id DESC LIMIT 1`,
      [id],
    );
    expect(rows[0]?.version).toBe(1);
  });

  it('follows the deliberate re-render, which is the escape hatch that stays open', async () => {
    // The narrowing this fix is: what a *download* must not do is issue a new
    // deliverable. What an analyst asks for by pressing Render still happens,
    // and the download then follows it, because the newest version carrying
    // bytes is exactly the one that was rendered.
    const id = await publishedThenEdited('Deliberate Revision, Inc.');

    const rendered = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${id}/report/render`,
      headers: authHeader(ops.token),
      payload: {},
    });
    expect(rendered.statusCode).toBe(200);
    expect(rendered.json().version).toBe(2);
    expect(await cached(id)).toEqual([true, true]);

    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/valuations/${id}/report.pdf`,
      headers: authHeader(client.token),
    });
    expect(res.statusCode).toBe(200);
    expect(readable(res.rawPayload)).toContain('Unsigned Revision After Publication');
  });

  it('still lets an engagement published before any render produce its first deliverable', async () => {
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/valuations',
      headers: authHeader(client.token),
      payload: { kind: '409a', company_name: 'Published Unrendered, Inc.' },
    });
    const id = created.json().valuation.id as string;
    await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/valuations/${id}/report`,
      headers: authHeader(ops.token),
    });
    await forceState(ctx, id, 'published');

    const rendered = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${id}/report/render`,
      headers: authHeader(ops.token),
      payload: {},
    });
    expect(rendered.statusCode).toBe(200);
    expect(await cached(id)).toEqual([true]);
  });
});
