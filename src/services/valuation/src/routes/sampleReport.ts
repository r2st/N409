import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { renderReportPdf } from '@n409/report/pdf';
import { problems } from '@n409/shared';
import { VALUATION_KINDS } from '../domain/valuation.js';
import { sampleReportOutline } from '../domain/sampleReport.js';
import { SAMPLE_FIGURES, SAMPLE_NOTICE, sampleReportPdfInput } from '../domain/sampleReportPdf.js';

/**
 * "See a sample report" (`/sample-report`). Public: it is the page that shows
 * a prospect what they would receive, and one behind a login shows nothing.
 *
 * Pure computation over the report templates — no database, nothing per-caller,
 * and in particular no client's report. `missingBlurbs` is deliberately part of
 * the response rather than filtered out: the marketing page renders headings
 * whether or not copy exists for them, so a new chapter shows up as an
 * unexplained heading instead of silently vanishing from the outline.
 *
 * The PDF is ungated on purpose. 409.ai puts theirs behind an email form, and
 * the trade is a real one — but the cost of the gate is storing a founder's
 * contact details as the price of looking at a document, and the benefit is a
 * lead who was told the price after arriving. The page already carries two
 * routes to a real conversation (Start my valuation, Contact), so the gate buys
 * addresses rather than intent. What makes ungating safe is that the document
 * cannot be mistaken for an opinion: see SAMPLE_NOTICE, which is on the cover,
 * in the summary and in the footer of every page.
 */

/**
 * Only the 409A has a rendered sample.
 *
 * The specialty kinds instantiate real skeletons but their exhibits are
 * produced by `specialtyExhibits` from an engine run, so a "sample" of one
 * would be a body with no schedules under it — a document that misrepresents
 * the deliverable in the one direction that matters. Refused rather than
 * approximated.
 */
const PDF_KINDS = ['409a'] as const;

export function registerSampleReportRoutes(app: FastifyInstance): void {
  app.get('/api/v1/sample-report', async (req) => {
    const parsed = z.object({ kind: z.enum(VALUATION_KINDS).default('409a') }).safeParse(req.query ?? {});
    if (!parsed.success) {
      throw problems.badRequest('Invalid kind', { errors: parsed.error.issues });
    }
    return {
      outline: sampleReportOutline(parsed.data.kind),
      kinds: VALUATION_KINDS,
      // The worked example the page prints, stated where the PDF states it.
      // Two copies of six numbers is two chances for the summary strip and the
      // downloadable document to disagree about what the sample concludes.
      figures: SAMPLE_FIGURES,
      notice: SAMPLE_NOTICE,
      pdf: { available: PDF_KINDS.includes(parsed.data.kind as (typeof PDF_KINDS)[number]) },
    };
  });

  app.get('/api/v1/sample-report/pdf', async (req, reply) => {
    const parsed = z.object({ kind: z.enum(PDF_KINDS).default('409a') }).safeParse(req.query ?? {});
    if (!parsed.success) {
      throw problems.badRequest('No sample is published for that report kind', {
        errors: parsed.error.issues,
      });
    }
    const pdf = await renderReportPdf(sampleReportPdfInput(parsed.data.kind));
    return (
      reply
        .type('application/pdf')
        // `attachment`, unlike the engagement's own report: a prospect clicking
        // "Download the sample" wants the file, and a PDF that opens in a tab
        // instead is one they have to save by hand.
        .header('content-disposition', 'attachment; filename="n409-sample-409a-report.pdf"')
        // Deterministic bytes (see sampleReportPdfInput), so this is safely
        // cacheable — and it is the one public route that costs a full render,
        // which makes it the one worth keeping off the CPU.
        .header('cache-control', 'public, max-age=3600')
        .send(pdf)
    );
  });
}
