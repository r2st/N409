import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCalculation } from '../../src/repos/calculations.js';
import { lockPublishGate } from '../../src/repos/publishLock.js';
import { authHeader, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';

const dbUp = await isDbAvailable();

/**
 * The half of the QA review the publish gate could not see.
 *
 * `runQa` grades two independent things and files one row. It grades the
 * *calculation* — the arithmetic, the params, the discount chain — and since
 * R93 it also grades the *report body*: dead exhibit references, a weighted
 * approach no chapter explains, a chapter that stopped restating its own
 * conclusion, and a chapter still carrying the skeleton's instructions to the
 * analyst.
 *
 * `assertPublishGate` then looks the review up by `calculation_id`, which is
 * the only thing `qa_reviews` records about what was examined. The comment on
 * that gate states its own reasoning exactly: "A recalculation invalidates the
 * previous review by construction — the review is keyed to the calculation it
 * examined."
 *
 * The body has no such construction. `PUT /valuations/:id/report` writes a new
 * `report_versions` row and bumps `reports.current_version`, and touches
 * nothing the gate reads. So the sequence below — draft, calculate, QA, sign,
 * *then edit the body*, then publish — puts out a 409A whose prose no review
 * ever saw, over a review that passed on prose that is no longer in the
 * document. Every check the coherence grader exists to enforce is optional to
 * anyone willing to edit after QA, and nothing about doing so looks unusual: an
 * analyst reading a QA report and fixing what it found lands in exactly this
 * state.
 *
 * The fix records the report version each review graded and refuses a publish
 * whose body has moved since. Not a re-grade at publish time: the gate is a
 * cheap consistency check under a lock, re-running the coherence checks there
 * would put an exhibit build inside the publish transaction, and — the point
 * that matters — a report edited after review needs a *reviewer*, not a second
 * opinion from the machine that already passed the old one.
 */
describe.skipIf(!dbUp)('publish gate — the report body the review graded', () => {
  let ctx: TestApp;
  let ops: Awaited<ReturnType<typeof seedUser>>;
  let client: Awaited<ReturnType<typeof seedUser>>;

  beforeAll(async () => {
    ctx = await setupTestApp();
    ops = await seedUser(ctx, { roles: ['reviewer'] });
    client = await seedUser(ctx, { roles: ['valuation_user'] });
  });
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

  /**
   * A signed, calculated, drafted and QA'd engagement one step below
   * `published` — the state an analyst is in when the review comes back clean.
   */
  async function reviewedAtDraftAccepted(name: string): Promise<string> {
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

    /*
     * A body that passes the review, written rather than drafted.
     *
     * `POST /report/draft` instantiates the real skeleton, and a pristine
     * skeleton *fails* QA by design — it carries the fill-me markers and the
     * chapters of instructions the coherence grader exists to refuse. That is
     * the correct behaviour and it is the wrong fixture: a test whose baseline
     * is unpublishable proves nothing about what a later edit does to it.
     *
     * So this is the analyst's finished prose. No exhibit references and no
     * `{{markers}}`, against a calculation with no approaches, so every check
     * has something to say and says pass.
     */
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
              html: '<p>The finished chapter, as the reviewer read it.</p>',
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

    const qa = await runQa(id);
    expect(qa.statusCode).toBe(201);
    expect(qa.json().review.status, 'the baseline body must be publishable').not.toBe('fail');

    for (let i = 0; i < 20 && (await stateOf(id)) !== 'draft_accepted'; i++) {
      expect(await advance(id)).toMatchObject({ statusCode: 200 });
    }
    expect(await stateOf(id)).toBe('draft_accepted');

    const sign = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${id}/signatures`,
      headers: authHeader(ops.token),
      payload: { role: 'main', signer_name: 'Alice Analyst', signature_text: 'Alice Analyst' },
    });
    expect(sign.statusCode).toBe(201);
    return id;
  }

  /** Rewrites one chapter, exactly as the editor does. */
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

  it('refuses to publish a body edited after the review that cleared it', async () => {
    const id = await reviewedAtDraftAccepted('AfterReviewEdit, Inc.');

    // The engagement is publishable at this instant — without this the test
    // would only prove that a broken fixture stays unpublished.
    const graded = await readReport(id);
    expect(graded.json().report.current_version).toBeGreaterThan(0);

    await editBody(id, '<p>Rewritten after the reviewer signed off.</p>');

    const published = await advance(id);
    expect(published.statusCode, 'published a body no review has seen').toBe(409);
    expect(published.json().detail).toMatch(/QA review/i);
    expect(await stateOf(id)).toBe('draft_accepted');
  });

  it('publishes once the edited body has been reviewed again', async () => {
    // The other direction, and the reason the refusal is a 409 rather than a
    // dead end: re-running QA over the new body clears it.
    const id = await reviewedAtDraftAccepted('ReReviewed, Inc.');
    await editBody(id, '<p>Rewritten, then reviewed again.</p>');

    expect(await runQa(id)).toMatchObject({ statusCode: 201 });
    expect(await advance(id)).toMatchObject({ statusCode: 200 });
    expect(await stateOf(id)).toBe('published');
  });

  it('makes a report save wait for a publish that is deciding', async () => {
    /*
     * The rule above closes the ordinary case and would leave the interleaved
     * one exactly as it was: the gate reads version 3 against a review of
     * version 3, a save commits version 4, and the publish lands on a body no
     * review has seen. Same shape as the signature deleted mid-publish, so the
     * same answer — `saveVersion` now takes the publish-gate lock the gate's
     * own write transaction holds.
     *
     * Driven by holding that lock directly rather than by racing two `inject`s.
     * A race here has no post-hoc invariant to assert on: editing the body of
     * an *already published* engagement is legitimate and changes nothing that
     * was delivered (`report_versions.pdf` is frozen at publication), so
     * "published, and the body is newer than the review" is a perfectly correct
     * end state when the save simply arrived second. What can be observed is
     * the mechanism — that a save cannot commit while a publish holds the lock.
     */
    const id = await reviewedAtDraftAccepted('SaveWaits, Inc.');
    const before = await readReport(id);
    const content = before.json().version.content as {
      title: string;
      sections: Array<{ key: string; heading: string; html: string }>;
    };
    content.sections[0]!.html = '<p>Saved while the gate held the lock.</p>';

    const holder = await ctx.pool.connect();
    let settled = false;
    try {
      await holder.query('BEGIN');
      // The real helper, so this cannot drift from the lock class the gate uses.
      await lockPublishGate(holder, id);

      const saving = ctx.app
        .inject({
          method: 'PUT',
          url: `/api/v1/valuations/${id}/report`,
          headers: { ...authHeader(ops.token), 'if-match': before.headers.etag as string },
          payload: { content },
        })
        .then((res) => {
          settled = true;
          return res;
        });

      // Long enough that an unlocked save would have finished several times
      // over — the same request takes single-digit milliseconds above.
      await new Promise((r) => setTimeout(r, 300));
      expect(settled, 'the save did not wait for the publish-gate lock').toBe(false);

      await holder.query('ROLLBACK');
      const saved = await saving;
      expect(saved.statusCode).toBe(200);
    } finally {
      holder.release();
    }
  });

  it('publishes an untouched body without a second review', async () => {
    // The vacuity guard. A gate that refused every publish would pass the first
    // case above for the wrong reason.
    const id = await reviewedAtDraftAccepted('UntouchedBody, Inc.');
    expect(await advance(id)).toMatchObject({ statusCode: 200 });
    expect(await stateOf(id)).toBe('published');
  });
});
