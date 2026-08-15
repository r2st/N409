import Fastify, { type FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  createLogger,
  problems,
  registerHealth,
  registerInternalAuth,
  registerProblemHandler,
  registerRequestDrain,
} from '@n409/shared';
import { renderReportPdf, verifyFontAssets } from './pdf.js';

/**
 * Report service (M2): stateless PDF rendering for valuation reports.
 * Persistence (reports/report_versions) lives with the valuation service,
 * which renders in-process via the `@n409/report/pdf` library; this HTTP
 * surface serves other consumers and keeps rendering independently scalable.
 */

const ChartPoint = z.object({
  label: z.string().min(1).max(120),
  value: z.number().finite(),
  display: z.string().max(60).optional(),
});

const ChartSpec = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('bar'),
    title: z.string().min(1).max(200),
    points: z.array(ChartPoint).max(20),
    note: z.string().max(400).optional(),
  }),
  z.object({
    type: z.literal('waterfall'),
    title: z.string().min(1).max(200),
    start: ChartPoint,
    steps: z.array(ChartPoint).max(10),
    end_label: z.string().min(1).max(120),
    end_value: z.number().finite().optional(),
    end_display: z.string().max(60).optional(),
    note: z.string().max(400).optional(),
  }),
  z.object({
    type: z.literal('donut'),
    title: z.string().min(1).max(200),
    slices: z.array(ChartPoint).max(12),
    center: z.string().max(40).optional(),
    center_note: z.string().max(60).optional(),
    note: z.string().max(400).optional(),
  }),
  z.object({
    type: z.literal('line'),
    title: z.string().min(1).max(200),
    points: z.array(ChartPoint).max(40),
    note: z.string().max(400).optional(),
  }),
]);

const SummaryFigure = z.object({
  label: z.string().min(1).max(120),
  value: z.string().max(120),
  note: z.string().max(300).optional(),
});

const RenderBody = z.object({
  title: z.string().min(1).max(300),
  company_name: z.string().min(1).max(300),
  meta: z
    .array(z.object({ label: z.string().min(1).max(100), value: z.string().max(300) }))
    .max(20)
    .default([]),
  sections: z
    .array(
      z.object({
        heading: z.string().min(1).max(300),
        html: z.string().max(200_000),
        charts: z.array(ChartSpec).max(6).optional(),
      }),
    )
    .min(1)
    .max(100),
  summary: z
    .object({
      headline: SummaryFigure,
      figures: z.array(SummaryFigure).max(9).optional(),
      statement: z.string().max(4000).optional(),
      charts: z.array(ChartSpec).max(6).optional(),
    })
    .optional(),
  include_toc: z.boolean().optional(),
  confidentiality: z.string().max(120).nullable().optional(),
  // Written to the PDF's CreationDate, so a report re-downloaded months later
  // still says when it was produced rather than when the bytes were.
  generated_at: z.coerce.date().optional(),
  keywords: z.array(z.string().min(1).max(80)).max(20).optional(),
});

export function buildApp(): FastifyInstance {
  const app = Fastify({
    loggerInstance: createLogger({ service: 'report' }),
    bodyLimit: 8 * 1024 * 1024,
    // Adopt the caller's request id rather than minting a new one, so a render
    // logs under the same id as the valuation request that asked for it. The
    // other two Fastify services already do this and the Python pair read the
    // header into a contextvar; this was the one hop where the chain broke.
    requestIdHeader: 'x-request-id',
  }) as unknown as FastifyInstance;
  registerProblemHandler(app);
  // Shared secret, same contract as the AI and engine services. Registered
  // before the render route so an unauthenticated caller is refused before the
  // 8 MB body is read, let alone rendered.
  registerInternalAuth(app, { service: 'report' });
  // This service registered no checks at all, which made /ready a 200 it was
  // structurally incapable of ever withholding — the same lie the web service's
  // /ready used to tell, and deploy.sh probes this unit too. It renders PDFs and
  // holds no connections, so the whole of "can it do its job" is whether the
  // four embedded faces are readable; see verifyFontAssets for why that is a
  // real deploy failure rather than a hypothetical one.
  registerHealth(app, { service: 'report', checks: { fonts: async () => verifyFontAssets() } });
  // Let a render that is already running finish before `close()` takes its
  // socket away — Fastify 5 does not, see drain.ts. A render in flight is the
  // realistic reason this service is slow to close, and until the drain existed
  // it was not slow at all: the caller got a connection reset instead of a PDF
  // it had already waited seconds for.
  registerRequestDrain(app);

  app.post('/render/v1/pdf', async (req, reply) => {
    const parsed = RenderBody.safeParse(req.body);
    if (!parsed.success)
      throw problems.unprocessable('Invalid render request', { errors: parsed.error.issues });
    const pdf = await renderReportPdf(parsed.data);
    return reply
      .type('application/pdf')
      .header('content-disposition', 'inline; filename="report.pdf"')
      .send(pdf);
  });

  return app;
}
