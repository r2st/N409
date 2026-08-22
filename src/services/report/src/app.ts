import Fastify, { type FastifyInstance } from 'fastify';
import helmet from '@fastify/helmet';
import { z } from 'zod';
import {
  API_PERMISSIONS_POLICY,
  createLogger,
  problems,
  MetricsRegistry,
  registerHealth,
  registerHttpMetrics,
  registerInternalAuth,
  registerMetricsEndpoint,
  registerProcessMetrics,
  registerPermissionsPolicy,
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

/**
 * The wire contract for `POST /render/v1/pdf`.
 *
 * Exported so `renderContract.test.ts` can hold it against `ReportPdfInput`.
 * The two had drifted by two fields — `branding` and `watermark` — because
 * nothing in this repository crosses the boundary: the valuation service
 * renders through the library, so a field added to the library and not to this
 * schema breaks no test and no caller, and is discovered by whoever first uses
 * the service as documented.
 */
export const RenderBody = z.object({
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
  /**
   * White-label branding. `logo` is a Buffer in the library and does not
   * survive JSON, so the wire carries base64 and it is decoded below — the one
   * field on this contract whose name differs from the library's, which is why
   * it is spelled out rather than left to be inferred.
   */
  branding: z
    .object({
      partner_name: z.string().min(1).max(200),
      brand_color: z
        .string()
        .regex(/^#[0-9a-fA-F]{6}$/, 'brand_color must be #rrggbb')
        .nullable()
        .optional(),
      logo_base64: z
        .string()
        .max(4 * 1024 * 1024)
        .nullable()
        .optional(),
    })
    .optional(),
  /**
   * Draft marker: every page carries a diagonal stamp of this word and the
   * cover a notice naming it.
   *
   * Absent from this schema until round 97, while the library it wraps has had
   * it since R92. Zod strips what it is not told about, so an HTTP caller
   * asking for a watermarked draft would have been handed back bytes
   * indistinguishable from the signed deliverable — the exact failure the
   * watermark exists to prevent, arriving as a silent success.
   */
  watermark: z.string().min(1).max(60).nullable().optional(),
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
  // Security headers (round 74). This was the one Fastify service with none:
  // valuation and web have carried helmet since the B-1 audit and this unit was
  // simply missed, on the reasoning that it is internal.
  //
  // Being internal is what makes it worth doing rather than what excuses it.
  // The single route here answers `application/pdf` with
  // `content-disposition: inline`, which is a rendering instruction — a browser
  // that reaches this port is being *asked* to open the bytes as a document,
  // and the bytes are assembled from caller-supplied `sections[].html`. nosniff
  // and a `default-src 'none'` policy are precisely the two headers that decide
  // what such a document may then do, and the response was going out with
  // neither. Same configuration as the valuation service, so a response does
  // not change its posture depending on which unit produced it.
  void app.register(helmet, {
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        'default-src': ["'none'"],
        'frame-ancestors': ["'none'"],
        'base-uri': ["'none'"],
        'form-action': ["'none'"],
      },
    },
    frameguard: { action: 'deny' },
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    hsts: { maxAge: 15552000, includeSubDomains: true }, // 180 days
    crossOriginResourcePolicy: { policy: 'same-site' },
  });
  registerPermissionsPolicy(app, API_PERMISSIONS_POLICY);
  registerProblemHandler(app);
  // Shared secret, same contract as the AI and engine services. Registered
  // before the render route so an unauthenticated caller is refused before the
  // 8 MB body is read, let alone rendered.
  // `/metrics` is exempted because `registerMetricsEndpoint` gates it on its own
  // secret — see `gatedElsewhere`. Without that, this one service would demand
  // INTERNAL_SERVICE_TOKEN for a scrape while the other two accept METRICS_TOKEN.
  registerInternalAuth(app, { service: 'report', gatedElsewhere: ['/metrics'] });
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
  const requestDrain = registerRequestDrain(app);

  // Scrape endpoint (shared/prometheus.ts). This service's latency is the
  // number worth watching here — a 409A PDF render is the slowest thing the
  // platform does, and `/health` cannot say it got slower.
  const metricsRegistry = new MetricsRegistry();
  registerHttpMetrics(app, metricsRegistry);
  registerProcessMetrics(metricsRegistry, 'report');
  metricsRegistry.gauge(
    'http_requests_in_flight',
    'Requests currently being served — concurrent PDF renders, in practice',
    () => requestDrain.inFlight,
  );
  registerMetricsEndpoint(app, { registry: metricsRegistry, service: 'report' });

  app.post('/render/v1/pdf', async (req, reply) => {
    const parsed = RenderBody.safeParse(req.body);
    if (!parsed.success)
      throw problems.unprocessable('Invalid render request', { errors: parsed.error.issues });
    const { branding, ...rest } = parsed.data;
    const pdf = await renderReportPdf({
      ...rest,
      ...(branding
        ? {
            branding: {
              partner_name: branding.partner_name,
              brand_color: branding.brand_color ?? null,
              logo: branding.logo_base64 ? Buffer.from(branding.logo_base64, 'base64') : null,
            },
          }
        : {}),
    });
    return reply
      .type('application/pdf')
      .header('content-disposition', 'inline; filename="report.pdf"')
      .send(pdf);
  });

  return app;
}
