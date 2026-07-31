import Fastify, { type FastifyInstance } from 'fastify';
import { z } from 'zod';
import { createLogger, problems, registerHealth, registerProblemHandler } from '@n409/shared';
import { renderReportPdf } from './pdf.js';

/**
 * Report service (M2): stateless PDF rendering for valuation reports.
 * Persistence (reports/report_versions) lives with the valuation service,
 * which renders in-process via the `@n409/report/pdf` library; this HTTP
 * surface serves other consumers and keeps rendering independently scalable.
 */

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
      }),
    )
    .min(1)
    .max(100),
  include_toc: z.boolean().optional(),
  confidentiality: z.string().max(120).nullable().optional(),
});

export function buildApp(): FastifyInstance {
  const app = Fastify({
    loggerInstance: createLogger({ service: 'report' }),
    bodyLimit: 8 * 1024 * 1024,
  }) as unknown as FastifyInstance;
  registerProblemHandler(app);
  registerHealth(app, { service: 'report' });

  app.post('/render/v1/pdf', async (req, reply) => {
    const parsed = RenderBody.safeParse(req.body);
    if (!parsed.success) throw problems.unprocessable('Invalid render request', { errors: parsed.error.issues });
    const pdf = await renderReportPdf(parsed.data);
    return reply
      .type('application/pdf')
      .header('content-disposition', 'inline; filename="report.pdf"')
      .send(pdf);
  });

  return app;
}
