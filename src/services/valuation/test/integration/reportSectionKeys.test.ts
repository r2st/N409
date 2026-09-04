import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authHeader, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';
import { applyNarrative } from '../../src/domain/narrativeApply.js';
import type { ReportContent } from '../../src/domain/report.js';

const dbUp = await isDbAvailable();

/**
 * One chapter per section key (R419, methodology M19).
 *
 * `key` is the report body's identity for a chapter, and three things
 * downstream are maps keyed by it — `applyNarrative`'s index, the
 * `unwrittenSections` Set that decides whether a draft may write over a
 * chapter, and the `section_key` each review finding is filed under. Nothing
 * refused a body carrying the same key twice, and the PDF renders the array in
 * order, so the duplicate looked like an extra chapter rather than a broken
 * index.
 *
 * The first test is the consequence; the rest are the door being closed.
 */
describe('duplicate report section keys', () => {
  /*
   * The defect, stated against the domain function directly so it does not
   * depend on a database being up.
   *
   * Two chapters share `conclusion`: the first still holds the skeleton's
   * placeholder, the second holds prose an analyst wrote. `unwrittenSections`
   * collects *keys*, so the pristine copy puts `conclusion` in the set; the
   * index resolves `conclusion` to the *last* section. So the guard that
   * `applyNarrative` exists behind — never overwrite written prose — reads
   * "unwritten" and writes into the chapter that was written.
   */
  it('would let a draft overwrite a written chapter, which is why the body is refused', () => {
    const skeleton: ReportContent = {
      title: 'Valuation Report',
      sections: [
        { key: 'conclusion', heading: 'Conclusion', html: '<p>[placeholder]</p>' },
        { key: 'conclusion', heading: 'Conclusion (continued)', html: '<p>[placeholder]</p>' },
      ],
    };
    const written: ReportContent = {
      ...skeleton,
      sections: [
        skeleton.sections[0]!,
        { ...skeleton.sections[1]!, html: '<p>An afternoon of the analyst’s own prose.</p>' },
      ],
    };

    const result = applyNarrative(
      written,
      [
        {
          key: 'conclusion',
          // Over MIN_DRAFT_LENGTH, or the apply stops at 'empty' before it ever
          // reaches the guard this is about.
          body: 'Freshly drafted prose from the model, comfortably longer than the eighty characters a draft must reach before it is applied to a chapter.',
        },
      ],
      { baseline: skeleton },
    );

    expect(result.content.sections[1]!.html).not.toContain('afternoon');
    expect(result.applied[0]!.outcome).toBe('written');
  });

  describe.skipIf(!dbUp)('is refused at the door', () => {
    let ctx: TestApp;
    let admin: Awaited<ReturnType<typeof seedUser>>;
    let valuationId: string;

    const put = (sections: Array<{ key: string; heading: string; html: string }>) =>
      ctx.app.inject({
        method: 'PUT',
        url: `/api/v1/valuations/${valuationId}/report`,
        headers: authHeader(admin.token),
        payload: { content: { title: 'Valuation Report', sections } },
      });

    beforeAll(async () => {
      ctx = await setupTestApp();
      admin = await seedUser(ctx, { roles: ['admin'] });
      const created = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/valuations',
        headers: authHeader(admin.token),
        payload: { kind: '409a', company_name: 'Two Conclusions, Inc.' },
      });
      valuationId = created.json().valuation.id;
    });
    afterAll(async () => ctx?.teardown());

    it('accepts a body whose keys are all distinct', async () => {
      const res = await put([
        { key: 'intro', heading: 'Introduction', html: '<p>One.</p>' },
        { key: 'conclusion', heading: 'Conclusion', html: '<p>Two.</p>' },
      ]);
      expect(res.statusCode, res.body).toBe(200);
    });

    it('refuses a repeated key, naming it and where it is', async () => {
      const res = await put([
        { key: 'intro', heading: 'Introduction', html: '<p>One.</p>' },
        { key: 'conclusion', heading: 'Conclusion', html: '<p>Two.</p>' },
        { key: 'conclusion', heading: 'Conclusion (continued)', html: '<p>Three.</p>' },
      ]);
      expect(res.statusCode, res.body).toBe(422);
      const detail = res.json().detail as string;
      // The key itself, so it can be found in a fifty-section body…
      expect(detail).toContain('conclusion');
      // …and the index of the copy that repeats it, not the first one.
      expect(detail).toContain('content.sections[2].key');
    });

    /*
     * The stored body is unchanged. A refusal that half-applied would be worse
     * than the defect: `saveVersion` appends, so a partial write is a version
     * every later read resolves to.
     */
    it('leaves the report as it was', async () => {
      const before = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/valuations/${valuationId}/report`,
        headers: authHeader(admin.token),
      });
      await put([
        { key: 'dup', heading: 'A', html: '<p>A</p>' },
        { key: 'dup', heading: 'B', html: '<p>B</p>' },
      ]);
      const after = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/valuations/${valuationId}/report`,
        headers: authHeader(admin.token),
      });
      expect(after.json().report.current_version).toBe(before.json().report.current_version);
    });
  });
});
