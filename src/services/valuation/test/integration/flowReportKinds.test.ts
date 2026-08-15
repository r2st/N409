import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  authHeader,
  forceState,
  isDbAvailable,
  pdfOutline,
  seedUser,
  setupTestApp,
  type TestApp,
} from './helpers.js';
import { VALUATION_KINDS, type ValuationKind } from '../../src/domain/valuation.js';
import { templateForKind, TEMPLATE_VAR_NAMES } from '../../src/domain/report.js';

/**
 * Every report type this platform sells, drafted and delivered.
 *
 * The 409A has the deep coverage — reportDeliverable.test.ts walks its exhibits,
 * its figures and its publish gate line by line. The other fourteen kinds have
 * engines, intake forms and ops screens of their own, and between them exactly
 * one assertion that the *document* at the end comes out: none. A kind whose
 * skeleton lost a section, whose heading no longer instantiates, or whose body
 * throws in the renderer would ship silently, because nothing has ever asked
 * any of them for a PDF.
 *
 * So this walks the shortest complete path per kind — create, read the skeleton
 * the kind's template produced, render, download — and asserts the things that
 * make the result a deliverable rather than a blank: it is the right template,
 * its title block resolved to this engagement, the certification every report
 * must carry is in it, and the document that comes back names the engagement it
 * was rendered for.
 *
 * The rendered bytes are checked through `pdfOutline` — the document's own
 * metadata and tagged structure, not its prose. Wording is `@n409/report`'s to
 * assert (it renders uncompressed and decodes the font); what a *flow* test can
 * usefully add is that the document exists, is this kind's, and is tagged.
 *
 * Deliberately no engine: an unrun engagement is the state most of these kinds
 * are drafted in, and the figure placeholders are covered where the figures are.
 * What is asserted here is that the document renders at all, for all of them.
 */

const dbUp = await isDbAvailable();

const companyFor = (kind: ValuationKind) => `Kind ${kind.toUpperCase()} Holdings, Inc.`;

describe.skipIf(!dbUp)('a deliverable for every report type', () => {
  let ctx: TestApp;
  let ops: Awaited<ReturnType<typeof seedUser>>;
  let client: Awaited<ReturnType<typeof seedUser>>;

  beforeAll(async () => {
    ctx = await setupTestApp();
    ops = await seedUser(ctx, { roles: ['admin'] });
    client = await seedUser(ctx, { roles: ['valuation_user'] });
  });
  afterAll(async () => ctx?.teardown());

  const asOps = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) =>
    ctx.app.inject({ method, url, headers: authHeader(ops.token), ...(payload ? { payload } : {}) });

  const createOfKind = async (kind: ValuationKind): Promise<string> => {
    const res = await asOps('POST', '/api/v1/valuations', {
      kind,
      company_name: companyFor(kind),
      currency: 'USD',
    });
    expect(res.statusCode).toBe(201);
    return res.json().valuation.id as string;
  };

  // ── Every kind, the same four steps ───────────────────────────────────────

  describe.each(VALUATION_KINDS)('%s', (kind) => {
    let valuationId: string;

    it('opens a draft from its own kind’s skeleton', async () => {
      valuationId = await createOfKind(kind);

      const draft = await asOps('GET', `/api/v1/valuations/${valuationId}/report`);
      expect(draft.statusCode).toBe(200);
      // Not "a" template — the one this kind declares. A kind falling through to
      // the generic skeleton is the failure this catches, and it is invisible on
      // screen because a generic report still looks like a report.
      expect(draft.json().report.template_version).toBe(templateForKind(kind).version);
      expect(draft.json().version.version).toBe(1);
    });

    it('instantiates the title block against this engagement', async () => {
      const draft = await asOps('GET', `/api/v1/valuations/${valuationId}/report`);
      const content = draft.json().version.content as {
        title: string;
        sections: Array<{ key: string; heading: string; html: string }>;
      };

      expect(content.title).toContain(companyFor(kind));
      expect(content.sections.length).toBeGreaterThan(0);

      // The five instantiation-time markers are filled once, at draft time, and
      // must be gone. Render-time figure markers ({{fmv_per_share}} and friends)
      // are supposed to still be here — they are what lets a recalculation
      // restate the prose — so only the template vars are checked.
      const body = JSON.stringify(content);
      for (const name of TEMPLATE_VAR_NAMES) {
        expect(body).not.toContain(`{{${name}}}`);
      }
    });

    it('carries the closing sections no report type may ship without', async () => {
      const draft = await asOps('GET', `/api/v1/valuations/${valuationId}/report`);
      const keys = (draft.json().version.content.sections as Array<{ key: string }>).map((s) => s.key);
      // withClosingSections() appends these to every skeleton; a template that
      // declared its own sections and lost the append would ship a report with
      // no certification page, which is not a defensible valuation report.
      expect(keys).toContain('limiting_conditions');
      expect(keys).toContain('certification');
    });

    it('renders and serves a PDF that names this engagement and its kind', async () => {
      const rendered = await asOps('POST', `/api/v1/valuations/${valuationId}/report/render`);
      expect(rendered.statusCode).toBe(200);
      expect(rendered.json().size_bytes).toBeGreaterThan(1000);

      const pdf = await asOps('GET', `/api/v1/valuations/${valuationId}/report.pdf`);
      expect(pdf.statusCode).toBe(200);
      expect(pdf.headers['content-type']).toContain('application/pdf');
      expect(pdf.rawPayload.subarray(0, 4).toString()).toBe('%PDF');

      const outline = pdfOutline(pdf.rawPayload);
      expect(outline.title).toContain(companyFor(kind));
      expect(outline.keywords).toContain(companyFor(kind));
      // A report filed under the wrong kind is a report an auditor cannot find.
      expect(outline.keywords).toContain(kind);
      // The cover fact block, as a screen reader is given it: this engagement,
      // this kind, and the template it was drafted from.
      expect(outline.actualText).toContain(`Kind: ${kind}`);
      expect(outline.actualText).toContain(`Template: ${templateForKind(kind).version}`);
      expect(outline.actualText).toContain(`Engagement: ${valuationId}`);
      // The chapters, tagged — including the certification no kind may omit.
      expect(outline.headings).toContain('Appraiser Certification');
      expect(outline.headings).toContain('Assumptions & Limiting Conditions');
    });

    it('renders the analyst’s revision rather than re-serving the delivered one', async () => {
      const heading = `Scope of the ${kind} Engagement`;
      const saved = await asOps('PUT', `/api/v1/valuations/${valuationId}/report`, {
        content: {
          title: `Valuation of ${companyFor(kind)}`,
          sections: [{ key: 'scope', heading, html: `<p>Prepared for the ${kind} engagement above.</p>` }],
        },
      });
      expect(saved.statusCode).toBe(200);
      expect(saved.json().version.version).toBe(2);

      // A save is a new version, and rendering it is what publishes revised
      // wording — the stored v1 PDF must not be what comes back.
      expect((await asOps('POST', `/api/v1/valuations/${valuationId}/report/render`)).statusCode).toBe(200);
      const outline = pdfOutline(
        (await asOps('GET', `/api/v1/valuations/${valuationId}/report.pdf`)).rawPayload,
      );
      expect(outline.headings).toContain(heading);
      expect(outline.actualText).toContain('Version: v2');
      // The skeleton's chapters are gone: this is the analyst's body, not v1's.
      expect(outline.headings).not.toContain('Appraiser Certification');
    });
  });

  // ── The things that must not happen, on any kind ──────────────────────────

  describe('who may draft and render', () => {
    let valuationId: string;

    beforeAll(async () => {
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/valuations',
        headers: authHeader(client.token),
        payload: { kind: 'goodwill', company_name: 'Client Owned Co' },
      });
      expect(res.statusCode).toBe(201);
      valuationId = res.json().valuation.id as string;
    });

    it('refuses an unauthenticated render', async () => {
      const res = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/valuations/${valuationId}/report/render`,
      });
      expect(res.statusCode).toBe(401);
    });

    it('refuses the owner a render of their own engagement — drafting is analyst work', async () => {
      const res = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/valuations/${valuationId}/report/render`,
        headers: authHeader(client.token),
      });
      expect(res.statusCode).toBe(403);
    });

    it('withholds the deliverable from the owner until a draft has been shared', async () => {
      // Rendered, but the engagement is still 'pending' — the client sees nothing.
      expect((await asOps('POST', `/api/v1/valuations/${valuationId}/report/render`)).statusCode).toBe(200);
      const early = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/valuations/${valuationId}/report.pdf`,
        headers: authHeader(client.token),
      });
      expect(early.statusCode).toBe(404);

      // `drafted` is reached from `reviewed`, and it is sharing the draft that
      // this asserts on rather than the road to it.
      await forceState(ctx, valuationId, 'reviewed');
      const shared = await ctx.app.inject({
        method: 'PATCH',
        url: `/api/v1/valuations/${valuationId}`,
        headers: authHeader(ops.token),
        payload: { state: 'drafted' },
      });
      expect(shared.statusCode).toBe(200);

      const late = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/valuations/${valuationId}/report.pdf`,
        headers: authHeader(client.token),
      });
      expect(late.statusCode).toBe(200);
    });

    it('404s a report for an engagement that does not exist', async () => {
      const res = await asOps('GET', '/api/v1/valuations/01ARZ3NDEKTSV4RRFFQ69G5FAV/report');
      expect(res.statusCode).toBe(404);
    });

    it('422s a report body that is not a report', async () => {
      const res = await asOps('PUT', `/api/v1/valuations/${valuationId}/report`, {
        content: { sections: 'not an array' },
      });
      expect(res.statusCode).toBe(422);
    });
  });
});
