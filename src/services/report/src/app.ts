import Fastify, { type FastifyInstance } from 'fastify';
import helmet from '@fastify/helmet';
import { z } from 'zod';
import {
  API_PERMISSIONS_POLICY,
  bindRequestId,
  createLogger,
  problems,
  MetricsRegistry,
  registerHealth,
  registerReadinessMetrics,
  registerHttpMetrics,
  registerInternalAuth,
  registerMetricsEndpoint,
  registerCgroupMemoryMetrics,
  registerNoStoreDefault,
  registerProcessMetrics,
  registerPermissionsPolicy,
  registerProblemHandler,
  registerRequestDrain,
  requestIdFromHeaders,
  validationDetail,
} from '@n409/shared';
import { CHART_SERIES_LIMITS, configureReportPdfLogging, renderReportPdf, verifyFontAssets } from './pdf.js';

/**
 * Report service (M2): stateless PDF rendering for valuation reports.
 * Persistence (reports/report_versions) lives with the valuation service; this
 * is where its renders happen.
 *
 * Round 98 gave this surface its first caller. Until then the valuation service
 * imported `@n409/report/pdf` and laid out every 409A on its own event loop —
 * 436–661ms on the deployed box during which the API served nobody — while this
 * unit sat deployed and idle, answering health probes. The library import remains, and
 * is the caller's fallback: a render that cannot happen here still happens
 * there, so this service is a latency dependency and never an availability one.
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
    points: z.array(ChartPoint).max(CHART_SERIES_LIMITS.bar),
    note: z.string().max(400).optional(),
  }),
  z.object({
    type: z.literal('waterfall'),
    title: z.string().min(1).max(200),
    start: ChartPoint,
    steps: z.array(ChartPoint).max(CHART_SERIES_LIMITS.waterfall),
    end_label: z.string().min(1).max(120),
    end_value: z.number().finite().optional(),
    end_display: z.string().max(60).optional(),
    note: z.string().max(400).optional(),
  }),
  z.object({
    type: z.literal('donut'),
    title: z.string().min(1).max(200),
    slices: z.array(ChartPoint).max(CHART_SERIES_LIMITS.donut),
    center: z.string().max(40).optional(),
    center_note: z.string().max(60).optional(),
    note: z.string().max(400).optional(),
  }),
  z.object({
    type: z.literal('line'),
    title: z.string().min(1).max(200),
    points: z.array(ChartPoint).max(CHART_SERIES_LIMITS.line),
    note: z.string().max(400).optional(),
  }),
]);

/**
 * The years `generated_at` may hold — see the field's own note.
 *
 * `Date.UTC` maps years 0–99 onto 1900–1999, so the floor is set with
 * `setUTCFullYear`, the documented way back out.
 */
const MIN_GENERATED_AT = new Date(Date.UTC(1, 0, 1));
MIN_GENERATED_AT.setUTCFullYear(1);
const MAX_GENERATED_AT = new Date(Date.UTC(9999, 11, 31, 23, 59, 59, 999));

const SummaryFigure = z.object({
  label: z.string().min(1).max(120),
  value: z.string().max(120),
  note: z.string().max(300).optional(),
});

/**
 * The wire contract for `POST /render/v1/pdf`.
 *
 * Exported so `renderContract.test.ts` can hold it against `ReportPdfInput`.
 * The two had drifted by two fields — `branding` and `watermark` — over the
 * years when nothing in this repository crossed the boundary and a field added
 * to the library but not to this schema therefore broke no test and no caller.
 *
 * The valuation service crosses it now, which changes what a drift costs but
 * not how quiet it is. The caps here are the half worth watching: they are
 * tighter than the library's (which has none), so a report that outgrows one is
 * a 422, and the caller answers a 422 by rendering in-process — correct bytes,
 * and the offload silently stops happening. Before tightening any number below,
 * see `reportOffload.test.ts`, which puts a real report through this schema.
 */
export const RenderBody = z.object({
  /**
   * 500, because that is what the door on the other side of this wire accepts.
   *
   * `PUT /valuations/:id/report` bounds the authored title with
   * `nonBlankText(1, REPORT_TITLE_MAX)`, and REPORT_TITLE_MAX is 500; a managed
   * template composes one unasked, as `${template.name} — ${company_name}`,
   * which is up to 403 characters for a template name at its own `.max(100)`.
   * Both were over the 300 this used to carry, and the way that failed is the
   * way every mismatch on this contract fails: `renderVia` answers a 422 by
   * rendering the identical bytes in-process, so the report is correct, nothing
   * is reported broken, and the offload is simply gone for that engagement for
   * as long as its title is what it is.
   *
   * Widened here rather than clamped there. The fallback exists to produce the
   * *same* deliverable, so a payload trimmed to fit the wire would give the two
   * renderers different documents to draw — and 200 characters of cover title
   * is not the cost this schema's caps are here to bound.
   */
  title: z.string().min(1).max(500),
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
  /**
   * Written to the PDF's CreationDate, so a report re-downloaded months later
   * still says when it was produced rather than when the bytes were.
   *
   * Coerced through a string or a number and then range-checked, because bare
   * `z.coerce.date()` is `new Date(input)` and "is it an Invalid Date", and
   * neither half stops a date this document cannot carry:
   *
   * * PDFKit formats the year by slicing four digits off it, so a JavaScript
   *   date outside years 1–9999 does not fail — it comes out *plausible and
   *   wrong*. Measured against the real library: `-005000-01-01` writes
   *   `D:50000101000000Z` (year 5000 AD) and `+275760-09-13` writes
   *   `D:57600913000000Z` (year 5760 AD). Both are well-formed extended-ISO
   *   instants that satisfy the bare schema, and the deliverable is a signed
   *   §409A opinion whose metadata a data room indexes and a reviewer reads.
   * * `new Date(null)` and `new Date(false)` are the epoch, not an Invalid
   *   Date, so a caller sending `generated_at: null` to mean "I have no
   *   timestamp" got a report stamped 1970-01-01 rather than the library's own
   *   default of now. Absent is how you say that; `.optional()` above is the
   *   field for it.
   *
   * The 1–9999 range is the one `domain/calendarRange.ts` commits to on the
   * valuation side, and the one `z.string().datetime()` enforces by accident of
   * its regex — so the two services agree about what a year is. That census
   * bans the bare spelling, but it walks its own package and could not see this
   * one.
   */
  generated_at: z
    .union([z.string(), z.number()])
    .pipe(z.coerce.date())
    .refine(
      (d) => d.getTime() >= MIN_GENERATED_AT.getTime() && d.getTime() <= MAX_GENERATED_AT.getTime(),
      'generated_at must be a date between year 1 and year 9999',
    )
    .optional(),
  /**
   * One keyword is the subject company's name, which its own door bounds at 300
   * — see `title` above for what a cap tighter than the producing door costs.
   * The count stays at 20: `routes/reports.ts` writes five.
   */
  keywords: z.array(z.string().min(1).max(300)).max(20).optional(),
});

export function buildApp(): FastifyInstance {
  const app = Fastify({
    loggerInstance: createLogger({ service: 'report' }),
    bodyLimit: 8 * 1024 * 1024,
    // Adopt the caller's request id rather than minting a new one, so a render
    // logs under the same id as the valuation request that asked for it. The
    // other two Fastify services already do this and the Python pair read the
    // header into a contextvar; this was the one hop where the chain broke.
    //
    // Adopted only if it is an id — see `acceptableRequestId`. The caller here
    // is the valuation service, which has already applied the same rule, so
    // this is the belt to its braces: the three services agree on what an id
    // is, in one place, rather than each trusting the hop before it.
    requestIdHeader: false,
    genReqId: (req) => requestIdFromHeaders(req.headers),
  }) as unknown as FastifyInstance;

  // Bind the request id to the async context, so a line written through
  // anything other than `req.log` still carries it — `app.log` in a route, a
  // module-level logger, a hook, or work that outlives the response. Fastify
  // has already resolved `req.id` from the inbound x-request-id (or minted
  // one) by the time this fires.
  //
  // The mixin that reads it has been on every service's logger since it was
  // written; only the valuation service ever fed it. In the other two
  // `currentRequestId()` answered undefined, so the field was quietly absent
  // from exactly the lines it exists for — the ones with no `req` in scope.
  app.addHook('onRequest', (req, _reply, done) => {
    bindRequestId(String(req.id));
    done();
  });
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
  registerNoStoreDefault(app);
  registerProblemHandler(app);
  // Say why a white-labelled report came out without the firm's mark on it.
  // The renderer is a library with no logger of its own; this is the one door
  // it reports a degraded render through. Same reason the valuation service
  // calls `configurePartnerLogoLogging` for the fetch half of the question.
  configureReportPdfLogging(app.log);
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
  const readiness = registerHealth(app, {
    service: 'report',
    checks: { fonts: async () => verifyFontAssets() },
  });
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
  // The ceiling this process is running under, beside what it is holding.
  // Round 99 gave every unit a MemoryMax, which means a service can now be
  // SIGKILLed by the cgroup limiter and restarted by systemd inside a few
  // seconds, leaving nothing in this process's own output to say it happened.
  // No-op off Linux and on a cgroup v1 host — see cgroupMemory.ts.
  registerCgroupMemoryMetrics(metricsRegistry);
  // The readiness verdict, on the endpoint the scraper reads. `fonts` is this
  // unit's only gating check and it is the one that decides whether a 409A PDF
  // renders at all — a partial rsync that drops the font assets leaves a
  // process answering `/metrics` perfectly while `/ready` says it cannot serve,
  // and nothing polls `/ready` between deploys.
  registerReadinessMetrics(metricsRegistry, readiness);
  metricsRegistry.gauge(
    'http_requests_in_flight',
    'Requests currently being served — concurrent PDF renders, in practice',
    () => requestDrain.inFlight,
  );
  registerMetricsEndpoint(app, { registry: metricsRegistry, service: 'report' });

  app.post('/render/v1/pdf', async (req, reply) => {
    const parsed = RenderBody.safeParse(req.body);
    if (!parsed.success)
      /*
       * The field names go in `detail`, not only in the extension.
       *
       * This is the shape R180 took out of the valuation service's 203 route
       * rejections, still standing in the one service that service delegates
       * to. The audience is different and the argument is the same. A 422 here
       * never reaches an analyst — `clients/reportRender.ts` renders the same
       * bytes in-process and answers 200 — so the *only* reader is the
       * operator holding the `report offload failed; rendering in-process`
       * warn line, whose `detail` is this string. `Invalid render request`
       * tells them the offload has gone permanently local for that engagement
       * and nothing about which of `RenderBody`'s caps the payload outgrew:
       * `sections` at 100, a section's `html` at 200,000 characters, one of
       * the four `CHART_SERIES_LIMITS`. Those are exactly the questions a
       * report-scale change has to answer, and the answer was a category noun.
       *
       * The `errors` extension is unchanged — a machine reading `path` should
       * not have to parse prose — and `validationDetail` is the same renderer
       * the valuation service's `invalidBody` uses, so both sides of the wire
       * say `sections: Array must contain at most 100 element(s)` the same way.
       */
      throw problems.unprocessable(validationDetail('Invalid render request', parsed.error.issues), {
        errors: parsed.error.issues,
      });
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
