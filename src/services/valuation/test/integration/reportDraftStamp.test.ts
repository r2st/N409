import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  authHeader,
  forceState,
  isDbAvailable,
  SEEDED_PASSWORD,
  seedPartner,
  seedUser,
  setupTestApp,
  type TestApp,
} from './helpers.js';
import { readable } from './support/pdfText.js';

const dbUp = await isDbAvailable();

/**
 * A report says whether it is finished, and stops saying it when it is.
 *
 * The deliverable is readable outside ops from `drafted` — several steps before
 * the QA review closes, the signature lands and the engagement publishes — and
 * until R92 the bytes a client downloaded then were indistinguishable from the
 * signed report. They do not stay with the person who downloaded them: a 409A
 * goes to an auditor, into a board pack, into a data room, and every reader
 * downstream takes an unmarked valuation report as final.
 *
 * The stamp itself is the renderer's, and `@n409/report`'s own suite pins how
 * it is drawn. What is pinned here is the half only this service knows: which
 * engagements get one, and — the part that is easy to get wrong — that the
 * lazy PDF cache stops handing out a stamped document the moment the stamp
 * stops being true.
 */
describe.skipIf(!dbUp)('the draft stamp on a delivered report', () => {
  let ctx: TestApp;
  let ops: { id: string; token: string };
  let client: { id: string; token: string };

  beforeAll(async () => {
    ctx = await setupTestApp({ AUTO_PIPELINE: 'off', EMAIL_MODE: 'off' });
    ops = await seedUser(ctx, { roles: ['reviewer'] });
    client = await seedUser(ctx, { roles: ['valuation_user'] });
  }, 120_000);
  afterAll(async () => ctx?.teardown());

  async function seedReport(name: string): Promise<string> {
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/valuations',
      headers: authHeader(client.token),
      payload: { kind: '409a', company_name: name },
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().valuation.id as string;
    // First read of the report instantiates it from the template.
    const report = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/valuations/${id}/report`,
      headers: authHeader(ops.token),
    });
    expect(report.statusCode).toBe(200);
    return id;
  }

  const download = async (id: string, token: string): Promise<Buffer> => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/valuations/${id}/report.pdf`,
      headers: authHeader(token),
    });
    expect(res.statusCode).toBe(200);
    expect(res.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');
    return res.rawPayload;
  };

  /** Whether each stored version has cached bytes, oldest first. */
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

  it('marks what a client can download before the engagement is published', async () => {
    const id = await seedReport('Marked Draft, Inc.');
    await forceState(ctx, id, 'drafted');
    const text = readable(await download(id, client.token));
    expect(text).toContain('DRAFT');
    expect(text).toContain('subject to revision, not for distribution');
    // And it cached nothing. The store holds the deliverable; a stamped render
    // is a view of it, and caching one is how the stamp would outlive the draft.
    expect(await cached(id)).toEqual([false]);
  });

  it('leaves the published deliverable unmarked', async () => {
    const id = await seedReport('Clean Final, Inc.');
    await forceState(ctx, id, 'published');
    const text = readable(await download(id, client.token));
    expect(text).not.toContain('DRAFT');
    expect(text).not.toContain('subject to revision');
    expect(await cached(id)).toEqual([true]);
  });

  it('does not go on serving the stamped render once the engagement publishes', async () => {
    /*
     * The regression this exists for. `report_versions.pdf` is a lazy cache:
     * the first request renders and every request after serves the stored
     * bytes. Nothing re-renders at publication — deliberately, so a published
     * v3 stays the v3 the client already holds — so a version first downloaded
     * while drafted would keep its DRAFT stamp for the life of the document,
     * which is the exact failure this whole change was meant to prevent.
     */
    const id = await seedReport('Promoted, Inc.');
    // Render the version explicitly first, exactly as an analyst does before
    // sharing a draft: that is what puts bytes in the cache, and those bytes
    // are frozen — nothing re-renders a stored version at publication.
    const rendered = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${id}/report/render`,
      headers: authHeader(ops.token),
      payload: {},
    });
    expect(rendered.statusCode).toBe(200);
    expect(await cached(id)).toEqual([true]);

    await forceState(ctx, id, 'drafted');
    expect(readable(await download(id, client.token))).toContain('DRAFT');

    await forceState(ctx, id, 'published');
    const published = readable(await download(id, client.token));
    expect(published).not.toContain('DRAFT');
    expect(published).not.toContain('subject to revision');
  });

  it('reaches the partner API by the same decision', async () => {
    const partnerId = await seedPartner(ctx, 'Stamp Firm');
    const partnerUser = await seedUser(ctx, { roles: ['partner'], partnerId });
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/valuations',
      headers: authHeader(partnerUser.token),
      payload: { kind: '409a', company_name: 'Partner Channel, Inc.' },
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().valuation.id as string;
    await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/valuations/${id}/report`,
      headers: authHeader(ops.token),
    });

    // The stored render an analyst produces before sharing the draft: the
    // partner API only serves a version that has been rendered, so without
    // this the channel answers 404 and the assertion below would be vacuous.
    await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${id}/report/render`,
      headers: authHeader(ops.token),
      payload: {},
    });

    await forceState(ctx, id, 'drafted');
    // Cached bytes exist and carry no stamp — the channel has to add one.
    const { token: draftKey } = await mintPartnerKey(partnerId);
    const draftPull = await ctx.app.inject({
      method: 'GET',
      url: `/api/partner/v1/valuations/${id}/report.pdf`,
      headers: { authorization: `Bearer ${draftKey}` },
    });
    expect(draftPull.statusCode).toBe(200);
    expect(readable(draftPull.rawPayload)).toContain('DRAFT');

    await forceState(ctx, id, 'published');
    const { token: apiKey } = await mintPartnerKey(partnerId);
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/partner/v1/valuations/${id}/report.pdf`,
      headers: { authorization: `Bearer ${apiKey}` },
    });
    expect(res.statusCode).toBe(200);
    expect(readable(res.rawPayload)).not.toContain('DRAFT');
  });

  /**
   * The download's filename is built from the company name, and the company
   * name is `z.string().min(1).max(300)` — so whatever the client typed reaches
   * a header parameter. A trailing backslash used to escape the closing quote
   * of `filename="…"`, leaving the quoted-string unterminated and the
   * `filename*` parameter after it inside the name.
   */
  it('builds a well-formed filename out of whatever the company is called', async () => {
    const id = await seedReport('Acme\\ / Beta "Holdings"');
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/valuations/${id}/report.pdf`,
      headers: authHeader(ops.token),
    });
    expect(res.statusCode).toBe(200);

    const header = res.headers['content-disposition'] as string;
    expect(header).toBe(
      `inline; filename="Acme_ _ Beta _Holdings__409a_v1.pdf"; ` +
        `filename*=UTF-8''Acme_%20_%20Beta%20_Holdings__409a_v1.pdf`,
    );
    // The three characters that must never reach a quoted-string or a path.
    expect(header).not.toContain('\\');
    expect(header).not.toContain('/Beta');
    expect(header).not.toContain('%2F');
    // Exactly two quotes: the pair that delimits `filename`.
    expect(header.split('"')).toHaveLength(3);
  });

  /** A live partner API key for `partnerId`, minted through the admin route. */
  async function mintPartnerKey(partnerId: string): Promise<{ token: string }> {
    const admin = await seedUser(ctx, { roles: ['partner'], partnerId });
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/partners/${partnerId}/tokens`,
      headers: authHeader(admin.token),
      payload: { current_password: SEEDED_PASSWORD, name: 'stamp-check' },
    });
    expect(res.statusCode).toBe(201);
    return { token: res.json().secret as string };
  }
});
