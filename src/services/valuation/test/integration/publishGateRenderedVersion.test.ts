import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCalculation } from '../../src/repos/calculations.js';
import { authHeader, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';
import { readable } from './support/pdfText.js';

const dbUp = await isDbAvailable();

/**
 * Rule 6 of the publish gate: the bytes readers will be handed are of the body
 * the gate checked (R448, methodology M3).
 *
 * Rules 2–5 are all asked of `reports.current_version`. R327 pinned every
 * outside door of a published engagement — `report.pdf`, the auditor portal,
 * the evidence bundle, the partner API — to the newest version carrying stored
 * bytes, on the reading that the version somebody rendered is the version that
 * was issued. `POST /report/render` stores bytes in any state and "Render PDF"
 * sits on the report tab throughout drafting, so the two readings part company
 * the ordinary way: render v2 to look at it, correct a chapter (v3), re-run QA
 * against v3, re-sign after v3, publish. Every rule passed, and every reader
 * was then handed v2 — a body the QA review did not grade, rendered before the
 * signature existed, with the certification page as it stood at the time.
 *
 * Not a change to what a render is: the deliberate render stays the way a
 * deliverable is produced, and an engagement that never rendered still issues
 * its current body lazily on first download (`reportPostPublishEdit.test.ts`).
 * What closes is publishing over a render of something else.
 */
describe.skipIf(!dbUp)('publish gate — the version that was rendered', () => {
  let ctx: TestApp;
  let ops: Awaited<ReturnType<typeof seedUser>>;
  let client: Awaited<ReturnType<typeof seedUser>>;

  beforeAll(async () => {
    ctx = await setupTestApp({ AUTO_PIPELINE: 'off', EMAIL_MODE: 'off' });
    ops = await seedUser(ctx, { roles: ['reviewer'] });
    client = await seedUser(ctx, { roles: ['valuation_user'] });
  }, 120_000);
  afterAll(async () => ctx?.teardown());

  const advance = (id: string) =>
    ctx.app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${id}/workflow/advance`,
      headers: authHeader(ops.token),
    });

  const stateOf = async (id: string): Promise<string> => {
    const { rows } = await ctx.pool.query<{ state: string }>('SELECT state FROM valuations WHERE id = $1', [
      id,
    ]);
    return rows[0]!.state;
  };

  const readReport = (id: string) =>
    ctx.app.inject({
      method: 'GET',
      url: `/api/v1/valuations/${id}/report`,
      headers: authHeader(ops.token),
    });

  const runQa = (id: string) =>
    ctx.app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${id}/qa`,
      headers: authHeader(ops.token),
      payload: {},
    });

  const sign = (id: string) =>
    ctx.app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${id}/signatures`,
      headers: authHeader(ops.token),
      payload: { role: 'main', signer_name: 'Alice Analyst', signature_text: 'Alice Analyst' },
    });

  const render = (id: string) =>
    ctx.app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${id}/report/render`,
      headers: authHeader(ops.token),
      payload: {},
    });

  async function editBody(id: string, html: string): Promise<number> {
    const before = await readReport(id);
    expect(before.statusCode).toBe(200);
    const content = before.json().version.content as {
      title: string;
      sections: Array<{ key: string; heading: string; html: string }>;
    };
    content.sections[0]!.html = html;
    const saved = await ctx.app.inject({
      method: 'PUT',
      url: `/api/v1/valuations/${id}/report`,
      headers: { ...authHeader(ops.token), 'if-match': before.headers.etag as string },
      payload: { content },
    });
    expect(saved.statusCode).toBe(200);
    return saved.json().report.current_version as number;
  }

  /** An engagement at draft_accepted whose body has been written, reviewed and rendered once. */
  async function renderedAtDraftAccepted(name: string): Promise<string> {
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/valuations',
      headers: authHeader(client.token),
      payload: { kind: '409a', company_name: name },
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().valuation.id as string;
    await createCalculation(
      ctx.pool,
      {
        valuationId: id,
        engineVersion: 'py-test',
        status: 'succeeded',
        inputs: {},
        results: {},
        equityValue: 20_000_000,
        fmvPerShare: 2,
        createdBy: ops.id,
      },
      { actorType: 'human', actorId: ops.id, source: 'test' },
    );
    // A body the QA grader clears: the sibling fixture in
    // `publishGateReportBody.test.ts`, whose conclusion restates the figure.
    const first = await readReport(id);
    expect(first.statusCode).toBe(200);
    const written = await ctx.app.inject({
      method: 'PUT',
      url: `/api/v1/valuations/${id}/report`,
      headers: { ...authHeader(ops.token), 'if-match': first.headers.etag as string },
      payload: {
        content: {
          title: `IRC 409A Valuation Report — ${name}`,
          sections: [
            {
              key: 'introduction',
              heading: 'Introduction',
              html: '<p>The chapter the analyst rendered to look at.</p>',
            },
            {
              key: 'conclusion',
              heading: 'Conclusion of Value',
              html: '<p>The concluded fair market value is $2.0000 per share.</p>',
            },
          ],
        },
      },
    });
    expect(written.statusCode).toBe(200);
    expect((await render(id)).statusCode).toBe(200);
    for (let i = 0; i < 20 && (await stateOf(id)) !== 'draft_accepted'; i++) {
      expect(await advance(id)).toMatchObject({ statusCode: 200 });
    }
    expect(await stateOf(id)).toBe('draft_accepted');
    return id;
  }

  it('refuses to publish over a render of an earlier body, and names both versions', async () => {
    const id = await renderedAtDraftAccepted('StaleRender, Inc.');
    const current = await editBody(id, '<p>Corrected after the render, and what QA and the signer saw.</p>');
    expect(await runQa(id)).toMatchObject({ statusCode: 201 });
    expect(await sign(id)).toMatchObject({ statusCode: 201 });

    const refused = await advance(id);
    expect(refused.statusCode, 'published over a render QA never graded').toBe(409);
    expect(refused.json().detail).toMatch(/since it was last rendered/);
    expect(refused.json().detail).toContain(`v${current - 1}`);
    expect(refused.json().detail).toContain(`v${current}`);
    expect(await stateOf(id)).toBe('draft_accepted');

    // The remedy the message names, then the same press.
    expect((await render(id)).statusCode).toBe(200);
    expect(await advance(id)).toMatchObject({ statusCode: 200 });
    expect(await stateOf(id)).toBe('published');

    // And what readers are handed is the body the gate checked.
    const pdf = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/valuations/${id}/report.pdf`,
      headers: authHeader(client.token),
    });
    expect(pdf.statusCode).toBe(200);
    expect(pdf.headers['content-disposition']).toContain(`v${current}`);
    expect(readable(pdf.rawPayload)).toContain('Corrected after the render');
  });

  it('publishes a body rendered after its last edit without asking again', async () => {
    const id = await renderedAtDraftAccepted('FreshRender, Inc.');
    expect(await runQa(id)).toMatchObject({ statusCode: 201 });
    expect(await sign(id)).toMatchObject({ statusCode: 201 });
    expect(await advance(id)).toMatchObject({ statusCode: 200 });
    expect(await stateOf(id)).toBe('published');
  });
});
