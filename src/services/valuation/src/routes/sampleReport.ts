import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { problems } from '@n409/shared';
import { VALUATION_KINDS } from '../domain/valuation.js';
import { sampleReportOutline } from '../domain/sampleReport.js';
import { SAMPLE_FIGURES, SAMPLE_NOTICE, sampleReportPdfInput } from '../domain/sampleReportPdf.js';
import { FixedWindowRateLimiter } from '../plugins/rateLimit.js';
import { renderReportPdf } from '../clients/reportRender.js';
import { invalidQuery } from '../domain/validationProblem.js';

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

/**
 * Renders per IP per window on `/sample-report/pdf`.
 *
 * The render is the only unauthenticated route on this service that costs real
 * CPU, and until now the only thing standing in front of it was the
 * `cache-control` header below. That header is a request to a cache, not a
 * limit: a caller who sends `Cache-Control: no-cache`, or who simply reaches
 * the origin directly, renders the document every time and nothing counts it.
 *
 * The per-user cost budget does not cover it either, twice over.
 * `domain/requestCost` charges `/\.pdf$/` — a literal dot — and this path ends
 * `/pdf`, so `costOfRequest` returns 0 for it while the engagement's own
 * `report.pdf` is charged 10. And `applyCostLimiter` keys on
 * `req.principal.id`, so it never runs for a caller who never authenticated.
 * The budget was written for the authenticated API; the one public render sat
 * outside both halves of it.
 *
 * Ten in ten minutes is set against the human the page is for: a prospect
 * downloads the sample once, maybe twice, and an office behind one NAT a
 * handful of times. It bounds a single address to roughly one render a minute
 * sustained, which is the point — this cannot stop a distributed flood, and is
 * not trying to. It stops one caller from holding the render loop open.
 */
const PDF_RENDERS_PER_IP = 10;
const PDF_RENDER_WINDOW_MS = 10 * 60 * 1000;

export function registerSampleReportRoutes(
  app: FastifyInstance,
  deps: { pdfLimiter?: FixedWindowRateLimiter } = {},
): void {
  const pdfLimiter = deps.pdfLimiter ?? new FixedWindowRateLimiter(PDF_RENDERS_PER_IP, PDF_RENDER_WINDOW_MS);

  app.get('/api/v1/sample-report', async (req) => {
    const parsed = z.object({ kind: z.enum(VALUATION_KINDS).default('409a') }).safeParse(req.query ?? {});
    if (!parsed.success) {
      throw invalidQuery(parsed.error, 'Invalid kind');
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
    // Checked before the kind is parsed, as on every other public route here:
    // the budget exists to keep work off the CPU, and deciding whether to spend
    // it after having already decided the request is worth serving is the wrong
    // order. It also means a flood of malformed requests is throttled too.
    const { allowed, resetAt } = pdfLimiter.check(req.ip);
    if (!allowed) {
      throw problems.tooManyRequests(
        'The sample report has been downloaded too many times from this address — please try again shortly',
        Math.max(1, Math.ceil((resetAt - Date.now()) / 1000)),
      );
    }
    const parsed = z.object({ kind: z.enum(PDF_KINDS).default('409a') }).safeParse(req.query ?? {});
    if (!parsed.success) {
      throw invalidQuery(parsed.error, 'No sample is published for that report kind');
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
