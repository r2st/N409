import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';
import helmet from '@fastify/helmet';
import cookie from '@fastify/cookie';
import type pg from 'pg';
import {
  API_PERMISSIONS_POLICY,
  bindRequestId,
  createLogger,
  ErrorRates,
  MetricsRegistry,
  problems,
  registerHealth,
  registerReadinessMetrics,
  registerHttpMetrics,
  registerMetricsEndpoint,
  registerCgroupMemoryMetrics,
  registerDiskMetrics,
  registerProcessMetrics,
  registerNoStoreDefault,
  registerPermissionsPolicy,
  registerProblemHandler,
  registerRequestDrain,
  requestIdFromHeaders,
  StartupGate,
  trustedProxies,
} from '@n409/shared';

declare module 'fastify' {
  interface FastifyInstance {
    /** Holds `/ready` shut until the boot sequence completes (shared/startup.ts). */
    startupGate: StartupGate;
    /** What `GET /metrics` serves (shared/prometheus.ts). Decorated so
     *  `index.ts` can add the gauges only the composition root can see. */
    metrics: MetricsRegistry;
  }
}
import { configureReportPdfLogging, verifyFontAssets } from '@n409/report/pdf';
import { configureZipLogging } from './export/zip.js';
import type { Config } from './config.js';
import { GoogleOidc } from './auth/google.js';
import { registerAuth } from './plugins/auth.js';
import { assertRoutesGuarded, registerRouteAudit } from './plugins/routeAudit.js';
import { registerParamValidation } from './plugins/params.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerAccountRoutes } from './routes/account.js';
import { registerMfaRoutes } from './routes/mfa.js';
import { registerSystemSettingsRoutes } from './routes/systemSettings.js';
import { SystemSettingsStore } from './repos/systemSettings.js';
import { registerValuationRoutes } from './routes/valuations.js';
import { registerCommentRoutes } from './routes/comments.js';
import { registerAdminUserRoutes } from './routes/adminUsers.js';
import { registerApiTokenRoutes } from './routes/apiTokens.js';
import { registerOperationsRoutes } from './routes/operations.js';
import { registerWorkflowRoutes } from './routes/workflow.js';
import { registerReviewRoutes } from './routes/reviews.js';
import { registerTemplateRoutes } from './routes/templates.js';
import { registerNotificationRoutes } from './routes/notifications.js';
import { registerEmailDeliveryRoutes } from './routes/emailDelivery.js';
import { registerUnsubscribeRoutes } from './routes/unsubscribe.js';
import { registerTransactionRoutes } from './routes/transactions.js';
import { registerSearchRoutes } from './routes/search.js';
import { registerSavedViewRoutes } from './routes/savedViews.js';
import { registerExportRoutes } from './routes/exports.js';
import { registerSensitivityRoutes } from './routes/sensitivity.js';
import { logTransport, type EmailTransport } from './hooks/stateChange.js';
import type { SupportEmailSource } from './hooks/autoEmails.js';
import { smtpTransport } from './email/smtp.js';
import { registerPaymentRoutes } from './routes/payments.js';
import { registerBillingRoutes } from './routes/billing.js';
import { registerSignatureRoutes } from './routes/signatures.js';
import { registerBoardApprovalRoutes } from './routes/boardApproval.js';
import { registerGrantRoutes } from './routes/grants.js';
import { registerIntakeRoutes } from './routes/intake.js';
import { registerEngagementRoutes } from './routes/engagements.js';
import { registerCapTableRoutes } from './routes/capTable.js';
import { registerMonitoringRoutes } from './routes/monitoring.js';
import { registerTaskRoutes } from './routes/tasks.js';
import { registerDocumentRoutes, MAX_DOCUMENT_BYTES } from './routes/documents.js';
import { UPLOAD_FIELD_LIMITS } from './routes/uploadLimits.js';
import { registerPipelineRoutes } from './routes/pipeline.js';
import { autoPipelineConcurrency, type AutoPipelineDeps } from './pipeline/autoPipeline.js';
import { registerParamsRoutes } from './routes/params.js';
import { registerEngineInputsRoutes } from './routes/engineInputs.js';
import { registerAiRoutes } from './routes/ai.js';
import { registerCalculationRoutes } from './routes/calculations.js';
import { registerBridgeRoutes } from './routes/bridge.js';
import { registerAnalyticsRoutes } from './routes/analytics.js';
import { registerCompareRoutes } from './routes/compare.js';
import { registerOrganizationRoutes } from './routes/organizations.js';
import { registerBrandingRoutes } from './routes/branding.js';
import { registerFirmRoutes } from './routes/firm.js';
import { registerClientIntakeRoutes } from './routes/clientIntake.js';
import { registerAuditorPortalRoutes } from './routes/auditorPortal.js';
import { registerSamlRoutes } from './routes/saml.js';
import { registerScimRoutes } from './routes/scim.js';
import { registerAdminSsoRoutes } from './routes/adminSso.js';
import { registerRetentionRoutes } from './routes/retention.js';
import { registerHrisRoutes } from './routes/hris.js';
import type { HrisProvider } from './clients/hris.js';
import { registerScenarioRoutes } from './routes/scenarios.js';
import { registerOverwriteRoutes } from './routes/overwrites.js';
import { registerWorkbookRoutes } from './routes/workbook.js';
import { registerReportRoutes } from './routes/reports.js';
import { registerPromptRoutes } from './routes/prompts.js';
import { registerNarrativePromptRoutes } from './routes/narrativePrompts.js';
import { registerCompanyProfileRoutes } from './routes/companyProfile.js';
import { registerValuationTagRoutes } from './routes/valuationTags.js';
import { registerPackageRoutes } from './routes/packageView.js';
import { registerInboxRoutes } from './routes/inbox.js';
import { registerNetworkItemRoutes } from './routes/networkItems.js';
import { registerJobRoutes } from './routes/jobs.js';
import { registerSupportRoutes } from './routes/support.js';
import { registerClientErrorRoutes } from './routes/clientErrors.js';
import { registerContactRoutes } from './routes/contact.js';
import { registerAdminEventRoutes } from './routes/adminEvents.js';
import { registerApiDocsRoutes } from './routes/apiDocs.js';
import { deploymentRateLimits } from './domain/rateLimitPolicy.js';
import { registerHelpRoutes } from './routes/help.js';
import { registerBlogRoutes } from './routes/blog.js';
import { registerCommunicationRoutes } from './routes/communications.js';
import { registerAccountingRoutes } from './routes/accounting.js';
import { registerCapTableSyncRoutes } from './routes/capTableSync.js';
import type { CapTableProvider } from './clients/capTableSync.js';
import type { AccountingProvider, FetchFn, ProviderCredentials } from './clients/accounting.js';
import { registerEvidenceRoutes } from './routes/evidence.js';
import { registerQaRoutes } from './routes/qa.js';
import { registerDataCompletenessRoutes } from './routes/dataCompleteness.js';
import { registerHealthCheckRoutes } from './routes/healthChecks.js';
import { registerAsc718Routes } from './routes/asc718.js';
import { registerFundRoutes } from './routes/funds.js';
import { registerDebtRoutes } from './routes/debt.js';
import { registerDecisionRoutes } from './routes/decisions.js';
import { registerProgressRoutes } from './routes/progress.js';
import { registerOnboardingRoutes } from './routes/onboarding.js';
import { registerAuditTrailRoutes } from './routes/auditTrail.js';
import { registerStreamRoutes } from './routes/stream.js';
import { ValuationHub } from './realtime/hub.js';
import { registerPartnerApiRoutes } from './routes/partnerApi.js';
import { setWebhookTargetPolicy } from './domain/partnerWebhooks.js';
import { silentlyDegraded } from './domain/optionalCapabilities.js';
import { registerSpecialtyRoutes } from './routes/specialty.js';
import { registerResearchRoutes } from './routes/research.js';
import { registerDataRemediationRoutes } from './routes/dataRemediation.js';
import { registerAdminDocumentRoutes } from './routes/adminDocuments.js';
import { registerComparableRoutes } from './routes/comparables.js';
import { registerVolatilityRoutes } from './routes/volatility.js';
import { registerWaccRoutes } from './routes/wacc.js';
import { registerRollforwardRoutes } from './routes/rollforward.js';
import { registerProjectionRoutes } from './routes/projections.js';
import { registerValuationSelectorRoutes } from './routes/valuationSelector.js';
import { registerFmvEstimatorRoutes } from './routes/fmvEstimator.js';
import { registerSampleReportRoutes } from './routes/sampleReport.js';
import { FixedWindowRateLimiter, WeightedWindowRateLimiter } from './plugins/rateLimit.js';
import type { QueryStats } from './db/queryStats.js';
import type { PoolHealth } from './db/poolHealth.js';
import { clamdScanner, type ScanPolicy } from './documents/virusScan.js';
import {
  probeReady,
  registerCircuitMetrics,
  registerUpstreamMetrics,
  setCircuitObserver,
  setNetworkSink,
} from './clients/internal.js';
import { configureReportRenderer, registerReportRenderMetrics } from './clients/reportRender.js';
import { registerMarketFeedMetrics } from './clients/marketFeedMetrics.js';
import { registerInboundWebhookMetrics } from './observability/inboundWebhooks.js';
import { registerSsoMetrics } from './observability/ssoOutcomes.js';
import { registerScimMetrics } from './observability/scimRequests.js';
import { registerSignInMetrics } from './observability/signInOutcomes.js';
import { registerIntegrationCallbackMetrics } from './observability/integrationCallbacks.js';
import { registerApiTokenAuthMetrics } from './observability/apiTokenAuth.js';
import { registerPartnerApiGuardMetrics } from './observability/partnerApiGuard.js';
import { registerRealtimeStreamMetrics } from './observability/realtimeStreams.js';
import { configurePartnerLogoLogging } from './clients/partnerLogoCache.js';
import { KEEP_PER_VALUATION, pruneNetworkItems, recordNetworkItem } from './repos/networkItems.js';
import {
  findUnstorableText,
  overDeepMessage,
  scanRequestValue,
  unstorableTextMessage,
} from './domain/nulBytes.js';

export interface AppDeps {
  config: Config;
  pool: pg.Pool;
  /** injectable for tests */
  google?: GoogleOidc;
  /** injectable for tests — partner API per-key rate limiter */
  partnerApiLimiter?: FixedWindowRateLimiter;
  /**
   * injectable for tests — partner API per-organisation ceiling, charged across
   * every key an organisation holds. `null` turns it off for a test that needs
   * to make more calls than the ceiling allows; undefined takes the configured
   * default.
   */
  partnerApiOrgLimiter?: FixedWindowRateLimiter | null;
  /** injectable for tests — per-IP limiter for the token-only board routes */
  boardPublicLimiter?: FixedWindowRateLimiter;
  /** injectable for tests — per-IP limiter for the auditor portal redeem route */
  auditorPortalLimiter?: FixedWindowRateLimiter;
  /** injectable for tests — per-IP limiter for the public client intake portal */
  clientIntakeLimiter?: FixedWindowRateLimiter;
  /** injectable for tests — per-IP limiter for /scim/v2/* */
  scimLimiter?: FixedWindowRateLimiter;
  /** injectable for tests — per-IP limiter for the public sample-report render */
  sampleReportPdfLimiter?: FixedWindowRateLimiter;
  /** injectable for tests/prod — per-user throttle across the whole authenticated API */
  sessionLimiter?: FixedWindowRateLimiter;
  /** injectable for tests/prod — per-partner throttle alongside sessionLimiter */
  sessionOrgLimiter?: FixedWindowRateLimiter;
  /** injectable for tests/prod — per-user cost budget for expensive routes */
  costLimiter?: WeightedWindowRateLimiter;
  /** injectable for tests — accounting provider HTTP */
  accountingFetch?: FetchFn;
  /** injectable for tests — cap-table sync provider HTTP */
  capTableSyncFetch?: FetchFn;
  /** injectable for tests — HRIS provider HTTP */
  hrisFetch?: FetchFn;
  /** injectable for tests — realtime SSE hub, to exercise its connection caps */
  hub?: ValuationHub;
  /** injectable for tests — how often an open SSE stream re-checks that it is
   *  still allowed to be open (default 60s; see realtime/streamAccess.ts). */
  streamRevalidateMs?: number;
  /** injectable for tests — /ready probes against the AI + engine services */
  readinessFetch?: FetchFn;
  /** Per-statement timing aggregate, surfaced at /api/v1/admin/db/slow-queries.
   *  Wired in index.ts; absent in tests, which the route reports rather than 500s on. */
  queryStats?: QueryStats;
  /** Connection checkout tracker, surfaced at /api/v1/admin/db/pool.
   *  Wired in index.ts; absent in tests, which the route reports rather than 500s on. */
  poolHealth?: PoolHealth;
  /**
   * Hold `/ready` shut until something calls `app.startupGate.markReady()`.
   * Only `index.ts` sets it — see the note at the gate's construction for why
   * the default is open.
   */
  gateStartup?: boolean;
}

/**
 * Email + SMS transports from config. Email: 'smtp' delivers through
 * SMTP_HOST (falling back to 'log' when unset), 'log' records delivery in the
 * service log, 'off' only queues outbox rows. SMS has no real provider yet —
 * 'log' mirrors the email log transport (a Twilio-style adapter slots in
 * here); 'off' only queues. Shared by buildApp and the index.ts drip
 * interval.
 */
export function buildEmailTransports(
  config: Config,
  log: FastifyBaseLogger,
  /**
   * Reads the runtime support address, for `Reply-To`. Optional so the many
   * test call sites need not supply one; without it a reply goes where it went
   * before, to the no-reply mailbox `SMTP_FROM` names.
   */
  settings?: SupportEmailSource,
): { transport?: EmailTransport; smsTransport?: EmailTransport } {
  let transport: EmailTransport | undefined;
  if (config.EMAIL_MODE === 'smtp' && config.SMTP_HOST) {
    transport = smtpTransport(
      {
        host: config.SMTP_HOST,
        port: config.SMTP_PORT,
        user: config.SMTP_USER,
        pass: config.SMTP_PASS,
        from: config.SMTP_FROM,
        // Deliverability extras: the HTML alternative's footer and the
        // one-click unsubscribe link both need an absolute URL, and the token
        // needs a signing key. Reusing JWT_SECRET keeps the deployment to the
        // keys it already rotates; the token's scope is what limits it, not a
        // separate secret.
        publicBaseUrl: config.PUBLIC_BASE_URL,
        unsubscribeSecret: config.JWT_SECRET,
        // Resolved per send rather than captured here: an administrator can
        // change the support address without restarting the service.
        replyTo: settings ? () => settings.get('support_email') : undefined,
      },
      log,
    );
  } else if (config.EMAIL_MODE !== 'off') {
    if (config.EMAIL_MODE === 'smtp') {
      log.warn('EMAIL_MODE=smtp but SMTP_HOST is unset — falling back to log transport');
    }
    transport = logTransport(log);
  }
  const smsTransport = config.SMS_MODE === 'log' ? logTransport(log) : undefined;
  return { transport, smsTransport };
}

export function buildApp(deps: AppDeps): FastifyInstance {
  const { config, pool } = deps;
  // Where partner webhooks are allowed to point. Process-wide, set before any
  // route can register one — see domain/partnerWebhooks.ts for why an SSRF
  // guard is needed on a URL the partner chooses and this service fetches.
  setWebhookTargetPolicy(config.WEBHOOK_ALLOW_PRIVATE_TARGETS);
  const app = Fastify({
    loggerInstance: createLogger({ service: 'valuation', level: config.LOG_LEVEL }),
    // Validated rather than adopted verbatim — see `acceptableRequestId`. The
    // BFF in front of this has already refused an implausible one, but this
    // service is also reached by the partner API and by SCIM, and a rule that
    // holds only where somebody remembered to put a proxy is not a rule.
    requestIdHeader: false,
    genReqId: (req) => requestIdFromHeaders(req.headers),
    // Nothing reaches this service directly: the web BFF proxies /api to it over
    // loopback. Without this the socket peer is 127.0.0.1 on every request, so
    // the fourteen throttles keyed on `req.ip` — contact, the three public
    // portals, SCIM, and eight in the auth routes — all shared one bucket, and
    // one client could spend the whole platform's budget. See clientIp.ts for
    // why the hops are named rather than trusted wholesale.
    trustProxy: trustedProxies(),
  }) as unknown as FastifyInstance;

  /**
   * Gates `/ready` until `index.ts` has proved the dependencies and run the
   * migrations (shared/startup.ts).
   *
   * Opened immediately when nothing is going to close it. `buildApp` is called
   * directly by ~200 integration tests and by the e2e harness, none of which
   * have a boot sequence to call `markReady` — leaving it shut there would make
   * every `/ready` assertion in the suite fail for a reason that has nothing to
   * do with what it is testing. `index.ts` passes `gateStartup: true` and is
   * the only caller that does, so the deployed path is the gated one.
   */
  const startupGate = new StartupGate('valuation');
  if (!deps.gateStartup) startupGate.markReady();
  app.decorate('startupGate', startupGate);

  // Bind the request id before anything else runs, so the engine/AI calls this
  // request makes downstream carry it (clients/internal.ts) and their log lines
  // join to ours. Fastify has already resolved `req.id` from the inbound
  // x-request-id — or minted one — by the time onRequest fires.
  app.addHook('onRequest', (req, _reply, done) => {
    bindRequestId(String(req.id));
    done();
  });

  /**
   * Refuse a request carrying text Postgres will not store, before any handler
   * can hand it to the driver.
   *
   * Global rather than per-schema because the exposure is per-*column*, not per
   * route: neither `U+0000` nor an unpaired surrogate has a UTF-8 encoding
   * Postgres will store, so every string that reaches a `text`, `jsonb` or
   * array parameter is a candidate and there are several hundred of them. A
   * guard on the boundary is one place to be right; the alternative is a
   * `.refine` on every `z.string()` in the service and a census to keep them
   * there. See domain/nulBytes.ts for what each character does below.
   *
   * `preValidation` is the first hook with a parsed body, and the character
   * only exists once the body is parsed — a JSON client sends the escape
   * sequence, not the code unit. Query strings arrive decoded, so `%00` and a
   * percent-encoded `%ED%A0%80` are caught here too.
   *
   * **Path parameters are scanned for the same reason**, and were not. They are
   * decoded exactly as a query string is, so `GET /help/articles/a%00b` put a
   * NUL in `req.params.slug`, which `findArticleBySlug` handed to the driver as
   * a `text` parameter — Postgres answers `22021 invalid byte sequence for
   * encoding "UTF8": 0x00`, and a request that should have been a 404 for a
   * page that does not exist became a 500 for a database that does. Most
   * params never get that far because they are ULIDs, or names looked up in a
   * registry, or shape-checked before the query (`/blog/posts/:slug`,
   * `/public/branding/:key` both do) — but that is a property of each route
   * rather than of the boundary, which is exactly the argument above for
   * putting the guard here. An unpaired surrogate cannot arrive this way:
   * `decodeURIComponent('%ED%A0%80')` throws and Fastify answers 400 on its
   * own. The NUL is the half that gets through.
   *
   * This runs ahead of route-level authentication, so an unauthenticated caller
   * sending one gets 400 rather than 401. That is the same ordering Fastify's
   * own schema validation has, and the refusal discloses nothing: it names a
   * field of the caller's own request.
   */
  app.addHook('preValidation', (req, _reply, done) => {
    // One walk of the body, answering both refusals — the unstorable string and
    // the value nested past what the walk reads. They were two traversals of the
    // same value until R314, on a hook every request goes through.
    //
    // The depth answer only concerns the body: a query string and a path
    // parameter are flat by construction, so there is nothing below the bound
    // for them to hide anything in.
    const body = scanRequestValue(req.body);
    const at = body.unstorable ?? findUnstorableText(req.query) ?? findUnstorableText(req.params);
    if (at) {
      done(problems.badRequest(unstorableTextMessage(at)));
      return;
    }
    // The walk stops at MAX_SCAN_DEPTH and answers "nothing here" for everything
    // below it, so a NUL nested past that depth used to pass this hook and reach
    // the jsonb column a free-form record is stored in. A body the guard cannot
    // finish reading is refused instead. See `findOverDeepValue`.
    if (body.overDeep) {
      done(problems.badRequest(overDeepMessage(body.overDeep)));
      return;
    }
    done();
  });

  // In-process RED, for the question `createHttpMetrics` cannot answer without
  // a collector wired: is this build throwing 500s right now. Registered here
  // rather than in index.ts alongside the OTel hook so the endpoint that serves
  // it has something to read under test. `routeOptions.url` is the templated
  // path when something matched; the raw url is what a 404 leaves behind, which
  // is why ErrorRates caps its route map.
  const errorRates = new ErrorRates();
  app.addHook('onResponse', (req, reply, done) => {
    errorRates.record({
      route: req.routeOptions?.url ?? req.url,
      statusCode: reply.statusCode,
    });
    done();
  });

  // Point the PDF renderer at the report unit, if there is one configured.
  // Set here for the same reason `setNetworkSink` below is: the four routes
  // that produce a PDF reach the renderer through helpers that are themselves
  // called from three more files, and widening all of those signatures to carry
  // a URL and a logger would be a lot of plumbing for a call that is made once.
  //
  // `config.REPORT_URL` defaults to loopback, so this is on after a redeploy
  // with nothing to remember; `REPORT_URL=` in the environment file takes it
  // back out of the path without a build. See clients/reportRender.ts.
  configureReportRenderer(config.REPORT_URL, app.log);

  // Say why a white-labelled report came out without the firm's mark on it.
  // Set here for the same reason the line above is — the only caller is five
  // frames below a route handler — and the nine ways that fetch can fail were
  // one silent `return null` until R155. See clients/partnerLogo.ts.
  configurePartnerLogoLogging(app.log);

  // And the tenth way, which is the renderer's rather than the fetch's: bytes
  // that sniffed as a PNG and that pdfkit cannot decode. This process renders
  // reports itself whenever the report unit is unreachable, so the library
  // needs a logger here as well as in that service.
  configureReportPdfLogging(app.log);

  // And the eleventh, which belongs to neither: a zip entry zlib refused to
  // compress. `export/zip.ts` ships it stored instead — the archive is larger
  // and entirely correct — but a box refusing to deflate a 2.7 MB document is
  // worth one line, and the alternative is the silent swallow this estate
  // keeps finding. Every .xlsx download goes through that writer.
  configureZipLogging(app.log);

  // Persist every engagement-scoped engine/AI call (409.ai §11, migration
  // 0127). Set here rather than passed through the twelve route modules that
  // make such calls: the client is a JSON HTTP client, and giving it a database
  // handle to log its own traffic would make it untestable without one.
  //
  // Deliberately not awaited. The write is diagnostic, it is one indexed insert,
  // and holding a calculation open on it would let a slow log make a slow
  // valuation. `recordNetworkItem` cannot throw, so nothing here is unhandled.
  setNetworkSink((call) => {
    const onError = (err: unknown) => app.log.warn({ err, name: call.name }, 'network item not recorded');
    void recordNetworkItem(
      pool,
      {
        valuationId: call.valuationId,
        service: call.service,
        name: call.name,
        request: call.request,
        response: call.response,
        status: call.status,
        error: call.error,
        durationMs: call.durationMs,
        requestId: call.requestId,
      },
      onError,
    ).then((id) => {
      // Prune only after a row was actually added — on the failure path there
      // is nothing new to push the count over the bound.
      if (id) void pruneNetworkItems(pool, call.valuationId, KEEP_PER_VALUATION, onError);
    });
  });

  // Say out loud when we stop calling a dependency, and when we start again.
  //
  // The breaker has had an `onStateChange` hook since it was written and
  // nothing ever passed one, so "the AI service has been cut off for the last
  // eleven minutes" existed only as a field on a page nobody was looking at.
  // Every other symptom is indirect: the users see a feature reporting itself
  // unavailable, and the calls that were refused locally are recorded against
  // whichever engagement happened to trigger them.
  //
  // `alert: true` is hand-written rather than coming through `logFailure`,
  // which classifies a thrown error — there is no error here, the breaker has
  // simply changed its mind about a dependency. Only the open transition
  // carries it: half-open and closed are the recovery, and an alert on the good
  // news is how a channel gets muted.
  setCircuitObserver(({ name, from, to, reason }) => {
    const fields = { service: name, from, to, reason };
    if (to === 'open') {
      app.log.error({ ...fields, alert: true }, `circuit opened — no longer calling ${name}`);
    } else {
      app.log.warn(fields, `circuit ${to} — ${name}`);
    }
  });

  const jwt = { secret: config.JWT_SECRET, issuer: config.JWT_ISSUER, ttlSeconds: config.JWT_TTL_SECONDS };
  const google =
    deps.google ??
    (config.GOOGLE_CLIENT_ID && config.GOOGLE_CLIENT_SECRET && config.GOOGLE_REDIRECT_URI
      ? new GoogleOidc({
          clientId: config.GOOGLE_CLIENT_ID,
          clientSecret: config.GOOGLE_CLIENT_SECRET,
          redirectUri: config.GOOGLE_REDIRECT_URI,
        })
      : undefined);

  // Security headers (audit B-1 P1). This is a JSON API behind the web BFF, so
  // lock the CSP right down (no resources are ever loaded from these responses)
  // and deny framing outright. HSTS/nosniff/referrer-policy are defence-in-depth
  // for any response that reaches a browser directly.
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
  // The one header helmet does not set (round 74). Nothing granted: a JSON API
  // response has no business being a document that can open a camera.
  registerPermissionsPolicy(app, API_PERMISSIONS_POLICY);
  // The other one it does not set. Every response this service produces is
  // either a private JSON payload or somebody's valuation deliverable, and the
  // browser disk cache and the Cloudflare edge both decide from headers this
  // API was not sending. See `registerNoStoreDefault` — routes that want to be
  // cached (the sample report, the blog, anything through `conditionalJson`)
  // set their own header and are left alone.
  registerNoStoreDefault(app);

  registerProblemHandler(app);
  // Records every route as it registers so the assertion at the end of this
  // function can refuse to boot with an endpoint that has neither
  // `app.authenticate` nor a documented exemption. Must precede the first
  // route registration, health checks included.
  const routeAudit = registerRouteAudit(app);
  // Every route below reads its ids via `req.params as …`, a cast Fastify never
  // checks. Validated here, once, so a malformed id is turned away before any
  // handler, repo or SQL sees it — including on the public token-authenticated
  // routes, where a 500 from the `ulid` domain would otherwise be an oracle.
  registerParamValidation(app);
  // Readiness means "this service can actually do its job", and its job is to
  // orchestrate the AI and engine services — a valuation cannot be calculated
  // without the engine, and no pipeline runs without the AI service. Probing
  // only Postgres reported ready while every calculation route was 502-ing.
  // Each probe is short-timeout and unretried so /ready itself stays fast.
  const readiness = registerHealth(app, {
    service: 'valuation',
    checks: {
      // Red until `index.ts` says the boot finished. Everything between the
      // port binding and that call — the dependency probes and the migrations
      // — happens with readiness failing, so nothing routes a request into a
      // process that is still starting. In tests, where nothing calls
      // `markReady`, the gate is opened at construction (see `startupGate`).
      startup: startupGate.check,
      postgres: async () => {
        await pool.query('SELECT 1');
      },
      // The 409A PDF is rendered on the report unit when `REPORT_URL` is set,
      // and in this process whenever that hop fails — so the font assets are
      // still this service's dependency, checked here for the same reason the
      // AI and engine probes are: readiness that covers only the connections
      // misses the deliverable.
      //
      // Note what is deliberately *not* here: a probe of the report service.
      // Every gating dependency in this list is one this service cannot do
      // without, which is what makes an unready upstream worth refusing traffic
      // over. The report unit is not: `clients/reportRender.ts` falls back to
      // rendering here, so a report unit that is down costs latency and nothing
      // else. Probing it would take a service that is merely slower out of the
      // load balancer entirely — a readiness check that manufactures the outage
      // it is reporting.
      fonts: async () => verifyFontAssets(),
    },
    /*
     * The two this service was already designed to serve without (round 361,
     * methodology M11).
     *
     * `index.ts` refuses to boot without Postgres and deliberately does not
     * refuse without these two: "With either down this service still lists
     * valuations, renders reports, takes payments and serves every page that
     * never needed a model — refusing to boot would convert a degraded feature
     * into a total outage, which is the exact failure this round is against."
     *
     * They then gated `/ready`, which makes exactly that conversion one step
     * later and with more reach. The AI service returns 503 from its own
     * `/ready` whenever `OPENROUTER_API_KEY` fails to verify — an expired key,
     * an exhausted free-tier quota, a provider outage — and that 503 became
     * this service's 503, and then the web tier's, which is the origin Caddy
     * proxies every public path to. It also fails the deploy: `deploy.sh`
     * ends on `/ready is not passing after the restart`.
     *
     * So the argument written three lines up for not probing the report unit
     * applied to these two the whole time, and they were the ones probed.
     * Reported rather than removed — a failing entry names itself in the body,
     * reads `failed` in the public form, moves `status` to `degraded` and logs
     * — and since R361 both units are scrape targets of their own, so `up` is
     * the direct signal rather than this cascade.
     */
    optional: {
      ai: () => probeReady('ai', config.AI_URL, { fetchFn: deps.readinessFetch }),
      engine: () => probeReady('engine', config.ENGINE_URL, { fetchFn: deps.readinessFetch }),
    },
  });
  // Runtime-editable system settings (registration switch, maintenance mode,
  // password floor). Cached — `maintenance_mode` is read on every mutating
  // request via app.authenticate. Built before the transports because they read
  // the support address off it for `Reply-To`.
  const settings = new SystemSettingsStore(pool, undefined, undefined, app.log);

  // Auto-email transport; delivery status is tracked in email_outbox.
  const { transport, smsTransport } = buildEmailTransports(config, app.log, settings);

  // `fileSize`/`files` bound the file half; UPLOAD_FIELD_LIMITS bounds the text
  // half, which nothing bounded before — see uploadLimits.ts for the size of
  // the request that was reaching the routes (round 74).
  void app.register(multipart, {
    limits: { fileSize: MAX_DOCUMENT_BYTES, files: 1, ...UPLOAD_FIELD_LIMITS },
  });
  // Parses Cookie headers into req.cookies so the auth plugin can read the
  // httpOnly session cookie (audit F-2).
  void app.register(cookie);
  // Secure cookies over HTTPS in production; plain http in dev/test.
  const sessionCookie = { secure: config.NODE_ENV === 'production', ttlSeconds: config.JWT_TTL_SECONDS };
  // Per-user/-org throttling only defaults on in production: integration
  // suites replay hundreds of sequential requests against one seeded user
  // within seconds, which a per-minute window would misfire on, the same
  // reasoning that keeps sessionCookie.secure off outside production. A test
  // that wants to exercise the throttle passes its own limiter via deps.
  const sessionLimiter =
    deps.sessionLimiter ??
    (config.NODE_ENV === 'production' && config.SESSION_RATE_LIMIT_PER_MIN > 0
      ? new FixedWindowRateLimiter(config.SESSION_RATE_LIMIT_PER_MIN, 60_000)
      : undefined);
  const sessionOrgLimiter =
    deps.sessionOrgLimiter ??
    (config.NODE_ENV === 'production' && config.SESSION_RATE_LIMIT_ORG_PER_MIN > 0
      ? new FixedWindowRateLimiter(config.SESSION_RATE_LIMIT_ORG_PER_MIN, 60_000)
      : undefined);
  // Cost budget for renders/exports/engine runs/AI jobs — see
  // domain/requestCost.ts. Same production-only default as the counters above.
  const costLimiter =
    deps.costLimiter ??
    (config.NODE_ENV === 'production' && config.HEAVY_RATE_LIMIT_PER_MIN > 0
      ? new WeightedWindowRateLimiter(config.HEAVY_RATE_LIMIT_PER_MIN, 60_000)
      : undefined);
  registerAuth(app, { pool, jwt, settings, sessionLimiter, sessionOrgLimiter, costLimiter });
  registerAuthRoutes(app, {
    pool,
    jwt,
    google,
    transport,
    publicBaseUrl: config.PUBLIC_BASE_URL,
    settings,
    cookie: sessionCookie,
  });
  registerAccountRoutes(app, {
    pool,
    jwt,
    transport,
    publicBaseUrl: config.PUBLIC_BASE_URL,
    cookie: sessionCookie,
    settings,
  });
  registerMfaRoutes(app, { pool, settings });
  registerSystemSettingsRoutes(app, { pool, settings });
  registerValuationRoutes(app, { pool, transport, publicBaseUrl: config.PUBLIC_BASE_URL, settings });
  // M1 — core pipeline
  registerTaskRoutes(app, { pool });
  // Improvement 2 — auto-pipeline on upload (extract → param fill → draft calc)
  const autoPipeline: AutoPipelineDeps = {
    pool,
    aiUrl: config.AI_URL,
    engineUrl: config.ENGINE_URL,
    documentsDir: config.DOCUMENTS_DIR,
    enabled: config.AUTO_PIPELINE === 'on',
    log: app.log,
  };
  // Antivirus policy for both upload paths (documents/virusScan.ts). Built
  // once here so the session route and the partner API cannot end up scanning
  // to different policies.
  const scan = resolveScanPolicy(config, app.log);
  // One line for everything that is deliberately off and says nothing about it
  // downstream — see domain/optionalCapabilities.ts. `warn` deployed and `info`
  // otherwise: a local checkout has all of these off by design and a warning
  // that is always there is a warning nobody reads, while on a deployed box
  // each of these is a decision somebody should be able to point at.
  const quiet = silentlyDegraded(config);
  if (quiet.length > 0) {
    const line = `running without ${quiet.map((c) => c.label.toLowerCase()).join(', ')} — see GET /api/v1/admin/system/metrics`;
    if (config.NODE_ENV === 'production') app.log.warn({ capabilities: quiet.map((c) => c.key) }, line);
    else app.log.info({ capabilities: quiet.map((c) => c.key) }, line);
  }
  registerDocumentRoutes(app, { pool, documentsDir: config.DOCUMENTS_DIR, autoPipeline, scan });
  registerPipelineRoutes(app, { pool, autoPipeline });
  registerParamsRoutes(app, { pool });
  registerEngineInputsRoutes(app, { pool });
  registerAiRoutes(app, { pool, aiUrl: config.AI_URL, documentsDir: config.DOCUMENTS_DIR, log: app.log });
  // IMPROVEMENTS_RESEARCH Phase 1 — QA gate before publish, audit-defense
  // decision log, client-portal progress tracker
  registerQaRoutes(app, { pool, aiUrl: config.AI_URL, documentsDir: config.DOCUMENTS_DIR, log: app.log });
  registerHealthCheckRoutes(app, { pool });
  registerDataCompletenessRoutes(app, { pool });
  registerDecisionRoutes(app, { pool });
  registerProgressRoutes(app, { pool });
  registerOnboardingRoutes(app, { pool });
  registerAuditTrailRoutes(app, { pool });
  registerCalculationRoutes(app, { pool, engineUrl: config.ENGINE_URL });
  // Specialty report-type pipeline — kind-specific engine orchestration
  registerSpecialtyRoutes(app, { pool, engineUrl: config.ENGINE_URL });
  // Design §7.4 — the stale-backsolve and stale-QA-review queues, one surface.
  registerDataRemediationRoutes(app, { pool, engineUrl: config.ENGINE_URL });
  // Design §9.2 — the legacy `uploads` re-filing queue 0112 deliberately left.
  registerAdminDocumentRoutes(app, { pool });
  // Design §4.5 — Network Items: the persisted guideline-company peer set.
  registerComparableRoutes(app, { pool, engineUrl: config.ENGINE_URL });
  registerVolatilityRoutes(app, { pool, engineUrl: config.ENGINE_URL });
  registerWaccRoutes(app, { pool, engineUrl: config.ENGINE_URL });
  // The bridge from the prior 409A's concluded equity value to this one's
  // (migration 0150) — what `valuation_params.rolling_forward` has always
  // claimed the engagement was doing.
  registerRollforwardRoutes(app, { pool, engineUrl: config.ENGINE_URL });
  registerProjectionRoutes(app, { pool, engineUrl: config.ENGINE_URL });
  registerBridgeRoutes(app, { pool });
  registerAnalyticsRoutes(app, { pool });
  registerCompareRoutes(app, { pool });
  registerOrganizationRoutes(app, { pool });
  registerBrandingRoutes(app, { pool, baseDomain: config.APP_BASE_DOMAIN });
  registerFirmRoutes(app, { pool });
  registerClientIntakeRoutes(app, {
    pool,
    publicBaseUrl: config.PUBLIC_BASE_URL,
    limiter: deps.clientIntakeLimiter,
  });
  // Improvement 4 — realtime collaboration: presence + live comment pushes.
  // Declared here rather than beside `registerStreamRoutes` because the auditor
  // portal below also broadcasts into it, and it registers first.
  const hub = deps.hub ?? new ValuationHub();
  registerAuditorPortalRoutes(app, {
    pool,
    publicBaseUrl: config.PUBLIC_BASE_URL,
    limiter: deps.auditorPortalLimiter,
    // The portal writes into the engagement's comment thread, so an open
    // workspace sees an auditor's note arrive the same way it sees a client's.
    hub,
  });
  // Feature 9 — enterprise SSO: SAML 2.0 SP + SCIM 2.0 provisioning
  registerSamlRoutes(app, { pool, jwt, publicBaseUrl: config.PUBLIC_BASE_URL, cookie: sessionCookie });
  registerScimRoutes(app, { pool, limiter: deps.scimLimiter });
  registerAdminSsoRoutes(app, { pool });
  // Feature 10 — data retention + legal hold administration
  registerRetentionRoutes(app, { pool });
  // Feature 11 — HRIS/payroll integration for ASC 718 (Rippling/Gusto/Deel)
  registerHrisRoutes(app, {
    pool,
    jwt,
    publicBaseUrl: config.PUBLIC_BASE_URL,
    credentials: hrisCredentials(config),
    fetchFn: deps.hrisFetch,
  });
  // Improvement 3 — client-facing what-if scenario sandbox (read-only)
  registerScenarioRoutes(app, { pool, engineUrl: config.ENGINE_URL });
  // M2 — output & delivery
  registerOverwriteRoutes(app, { pool });
  registerWorkbookRoutes(app, { pool });
  registerReportRoutes(app, {
    pool,
    // The narrative route drafts through the AI service before writing the
    // report body; the same deps registerAiRoutes runs on.
    ai: { pool, aiUrl: config.AI_URL, documentsDir: config.DOCUMENTS_DIR, log: app.log },
  });
  registerStreamRoutes(app, { pool, hub, revalidateMs: deps.streamRevalidateMs });
  // Let a request that is already being served finish before `close()` takes
  // its socket away — Fastify 5 does not, see drain.ts. Registered here rather
  // than in the composition root so it is a property of the app: every instance
  // has it, and the tests that close one exercise it.
  //
  // `onDrainStart` ends the SSE streams first, because each is a request in
  // flight for as long as its tab stays open. Without it the drain would
  // measure the browser tabs rather than the work, spend its whole deadline on
  // every restart, and then report abandoned requests that were only
  // heartbeats. Placed after `registerStreamRoutes` so `app.realtimeHub` — the
  // decoration it reads — already exists.
  const requestDrain = registerRequestDrain(app, {
    onDrainStart: () => {
      const closed = hub.closeAll();
      if (closed > 0) app.log.info({ streams: closed }, 'closed realtime streams for shutdown');
    },
  });

  /**
   * `GET /metrics`, in the Prometheus text format (shared/prometheus.ts).
   *
   * Registered here rather than in `index.ts` for the same reason the drain is:
   * it is a property of the app, so the integration suite exercises the real
   * endpoint rather than a second wiring of it. The gauges that need the
   * composition root — the pg pool's own counters, which `buildApp` is handed
   * but which only `index.ts` knows the tuning of — are added there, onto the
   * registry decorated below.
   *
   * Everything sampled here is an in-memory read. Nothing on a scrape path
   * queries the database: a monitoring poll that costs a query adds load to the
   * thing being monitored, hardest exactly when the database is the problem.
   */
  const metricsRegistry = new MetricsRegistry();
  app.decorate('metrics', metricsRegistry);
  registerHttpMetrics(app, metricsRegistry);
  registerProcessMetrics(metricsRegistry, 'valuation');
  // The ceiling this process is running under, beside what it is holding.
  // Round 99 gave every unit a MemoryMax, which means a service can now be
  // SIGKILLed by the cgroup limiter and restarted by systemd inside a few
  // seconds, leaving nothing in this process's own output to say it happened.
  // No-op off Linux and on a cgroup v1 host — see cgroupMemory.ts.
  registerCgroupMemoryMetrics(metricsRegistry);
  /*
   * And the other finite resource on the same box, which had no gauge at all.
   *
   * Memory has had one since R337 and two rules since. A full disk is the
   * failure with the wider blast radius and it arrived with no lead time
   * whatsoever: PostgreSQL stops accepting writes and every write answers
   * `503 database-unavailable`, uploads fail at `open` with ENOSPC, the nightly
   * dump has nowhere to land on exactly the day somebody needs it, and the
   * journal that would describe all three is the first thing dropped. Every one
   * of those is a symptom after the fact, and none of them names the disk.
   *
   * One role, because this host has one volume: `DOCUMENTS_DIR` is on the same
   * filesystem as the cluster and the journal, so a single reading answers for
   * the box — and it is named for what stops working rather than for the
   * device, so a second volume later is a second entry here rather than a
   * rewrite. One `statfs` per scrape, which is what makes it honest to take
   * inside one; see `diskSpace.ts` for why the read is deliberately allowed to
   * throw rather than report a zero.
   */
  registerDiskMetrics(metricsRegistry, { documents: config.DOCUMENTS_DIR });
  metricsRegistry.gauge(
    'http_requests_in_flight',
    'Requests currently being served',
    () => requestDrain.inFlight,
  );
  // The settings fail-open, as something a rule can match.
  //
  // `SystemSettingsStore.read` degrades rather than throws, and the cold-cache
  // branch degrades to `SYSTEM_SETTINGS_DEFAULTS`, every one of whose three
  // operational flags is the permissive value: registration open, not in
  // maintenance, 2FA not mandatory. It says so in the log, and the log is not
  // what alerts here — this endpoint is. So the one state where a replica is
  // actively contradicting an operator's configuration was reachable only by
  // somebody already reading the journal of the right unit at the right time.
  //
  // A state gauge and a cumulative pair, for the reason the sweep metrics keep
  // both: `_serving_defaults` is the incident, and the failure counts are what
  // separate a blip that healed on the next read from a table nothing can read.
  metricsRegistry.gauge(
    'system_settings_serving_defaults',
    '1 while this process is answering system settings from the permissive built-in defaults because it has never completed a read',
    () => (settings.diagnostics().servingDefaults ? 1 : 0),
  );
  metricsRegistry.gauge(
    'system_settings_read_failures_total',
    'Failed system-settings reads, cumulative, by what was served instead',
    () => {
      const d = settings.diagnostics();
      return [
        { value: d.failedToCache, labels: { served: 'cache' } },
        { value: d.failedToDefaults, labels: { served: 'defaults' } },
      ];
    },
    ['served'],
  );
  // Queue depth, as this process sees it: orchestrations running and waiting on
  // the auto-pipeline semaphore. The DB-backed backlogs (outbox, webhook
  // deliveries, jobs) are deliberately absent — they are a count query each,
  // and the job-alert sweep already watches them on its own schedule.
  metricsRegistry.gauge(
    'auto_pipeline_runs_active',
    'In-flight auto-pipeline orchestrations',
    () => autoPipelineConcurrency().active,
  );
  metricsRegistry.gauge(
    'auto_pipeline_runs_pending',
    'Auto-pipeline orchestrations queued behind the concurrency limit',
    () => autoPipelineConcurrency().pending,
  );
  // Realtime streams are capped per-user/per-room/per-process (realtime/hub.ts);
  // this is the number those ceilings are measured against.
  metricsRegistry.gauge(
    'realtime_streams_open',
    'Open per-valuation SSE connections',
    () => hub.stats().total,
  );
  // And what the hub is *refusing*, which the gauge above cannot say: the
  // per-user ceiling is met at twelve, so the ordinary refusal happens with
  // that gauge reading 1% of `maxTotal`. See `observability/realtimeStreams.ts`.
  // The readiness verdict, which until now was a claim made to nobody: `/ready`
  // is polled once per restart by `deploy.sh` and by nothing afterwards — there
  // is no load balancer on this box — while `/metrics` is served out of process
  // memory and touches no dependency. So a valuation tier whose Postgres has
  // gone answers every scrape in full, with a complete set of healthy-looking
  // numbers, and `ServiceDown` (which fires on a *missed* scrape) never moves.
  // See `registerReadinessMetrics`.
  registerReadinessMetrics(metricsRegistry, readiness);
  registerRealtimeStreamMetrics(metricsRegistry, () => hub.ceilings());
  // Where PDF renders actually happen. `mode="local"` with a failure reason is
  // the signal that the offload has stopped working and this process is back to
  // blocking its event loop for half a second per report — a regression with no
  // other symptom, because the fallback keeps producing correct bytes.
  registerReportRenderMetrics(metricsRegistry);
  // The live market feed, by outcome. Same shape and same reason as the render
  // counter above: the engine turns every market-data failure into a 200 with
  // `source: "fallback"`, so a dead source produces correct-looking answers on
  // substituted figures and has no other symptom on this side of the wire.
  registerMarketFeedMetrics(metricsRegistry);
  // What arrives at the three unauthenticated webhook doors, by outcome. The
  // signature on each is a secret held on two machines, neither of which tells
  // the other when it changes — and a rotation that misses this side refuses
  // every delivery with a 4xx, which `registerProblemHandler` leaves silent by
  // design. Payments stop being fulfilled and bounces stop being recorded with
  // nothing on this box saying so.
  registerInboundWebhookMetrics(metricsRegistry);
  // And how the two identity-provider flows are going. Every SSO refusal is
  // answered as a 302 — R273 said so when it gave them a log line — so an
  // expired signing certificate or a narrowed domain rule refuses every
  // sign-in at a firm while `http_requests_total` counts each one beside the
  // ordinary redirects. There is no other symptom on this box at all.
  registerSsoMetrics(metricsRegistry);
  // And the third door onto this platform whose authority is a shared secret
  // held on two machines: the directory connector. A rotated SCIM token refuses
  // every provision and every deprovision as a 401 that nothing logs and no
  // rule watches, so the automated path that takes a departing employee's
  // access away stops and the platform's own instruments read green.
  registerScimMetrics(metricsRegistry);
  // And the three OAuth connect doors, whose refusals are 302s for exactly the
  // reason SSO's are. Three of the five outcomes a callback can reach — the
  // provider saying no, the engagement withdrawn mid-hop, the actor no longer
  // allowed to finish — wrote nothing anywhere at all, so a rotated client
  // secret or a redirect URI that no longer matches refuses every connection
  // attempt with every instrument on this box reading green.
  registerIntegrationCallbackMetrics(metricsRegistry);
  // And the last machine door, which is the one the estate itself calls "the
  // door with no person behind it to notice". A refused API key is one 401 with
  // no log line and no event row, so a firm's integration stops dead: it cannot
  // see why — for two of the five refusals the console it would look in is
  // behind the same key — and this side could not see that it had happened.
  // Three of those five are conditions this platform caused, by archiving a
  // firm, moving the member who minted the key, or closing their account.
  registerApiTokenAuthMetrics(metricsRegistry);
  // And the gate one layer above that door, which R345 and R346 both left open.
  // Everything `apiKeyGuard` refuses is a key this platform issued and still
  // honours — pointed at a surface it may not use, or over its ceiling — and the
  // sharpest of them is a key stopped by a suspension applied to the *account*
  // it acts as: an administrative act here ends a running integration
  // elsewhere, answered with a 403 that nothing logs.
  registerPartnerApiGuardMetrics(metricsRegistry);
  // And the door people use, which is the one every round above left for last.
  // A sign-in refusal is a 401 and a lockout is a 429, and this deployment has
  // no rule on either class — `scimRequests.ts` says so in as many words — so a
  // password verifier that stopped verifying, a second factor that rejects
  // every correct code, and a credential-stuffing run walking the address list
  // are all invisible to every instrument on this box. The audit spine has had
  // the rows since R215; what it has never had is a channel anybody is woken by.
  registerSignInMetrics(metricsRegistry);
  // Whether we are still dialling the engine, the AI service and the report
  // unit at all. The breaker's own view was reachable only from the ops
  // incident endpoint, which is a page somebody visits once they already
  // suspect something — so a dependency going away and coming back was, to
  // everything that polls, indistinguishable from it never having happened.
  registerCircuitMetrics(metricsRegistry);
  // And how those calls are going while the breaker is still closed. Everything
  // this service knew about the engine and the AI gateway was per-engagement
  // (`network_items`) or per-request (the problem the caller got); nothing
  // aggregated, so "the engine's error rate doubled an hour ago" was not a
  // question anything on this box could answer.
  registerUpstreamMetrics(metricsRegistry);
  registerMetricsEndpoint(app, { registry: metricsRegistry, service: 'valuation' });
  // M3 — operations (comments/chat/email, admin console, tokens, analytics, clone)
  registerCommentRoutes(app, { pool, hub });
  registerInboxRoutes(app, { pool });
  registerNetworkItemRoutes(app, { pool });
  registerAdminUserRoutes(app, { pool, transport, publicBaseUrl: config.PUBLIC_BASE_URL, settings });
  registerApiTokenRoutes(app, { pool });
  registerOperationsRoutes(app, {
    pool,
    queryStats: deps.queryStats,
    poolHealth: deps.poolHealth,
    errorRates,
    capabilityConfig: config,
  });
  // M4 — operations polish
  registerWorkflowRoutes(app, { pool, transport, publicBaseUrl: config.PUBLIC_BASE_URL, settings });
  // P1 #6 — review queue + approve/request-changes decisions
  registerReviewRoutes(app, { pool, transport, publicBaseUrl: config.PUBLIC_BASE_URL, settings });
  registerTemplateRoutes(app, { pool });
  registerNotificationRoutes(app, { pool });
  registerEmailDeliveryRoutes(app, { pool, webhookSecret: config.EMAIL_WEBHOOK_SECRET });
  registerUnsubscribeRoutes(app, { pool, secret: config.JWT_SECRET });
  registerTransactionRoutes(app, { pool });
  registerSearchRoutes(app, { pool });
  registerSavedViewRoutes(app, { pool });
  registerExportRoutes(app, { pool });
  registerSensitivityRoutes(app, { pool, engineUrl: config.ENGINE_URL });
  registerAsc718Routes(app, { pool, engineUrl: config.ENGINE_URL });
  registerFundRoutes(app, { pool, engineUrl: config.ENGINE_URL });
  registerDebtRoutes(app, { pool, engineUrl: config.ENGINE_URL });
  // P1/P2 remaining features — prompt registry, company profile, package
  // explorer, in-app support (docs/remaining-gaps.md)
  registerPromptRoutes(app, { pool, aiUrl: config.AI_URL });
  // Migration 0114 — the per-section guidance behind report_narrative, edited
  // per report type rather than per pipeline.
  registerNarrativePromptRoutes(app, { pool });
  // Design §12.3 — web-grounded market research (search provider + synthesis).
  // The caller the adapter never had.
  registerResearchRoutes(app, { pool, aiUrl: config.AI_URL });
  registerCompanyProfileRoutes(app, { pool });
  // 409.ai parity gap #23 — the engagement tag vocabulary and its decisions.
  registerValuationTagRoutes(app, { pool });
  registerPackageRoutes(app, { pool });
  registerJobRoutes(app, { pool });
  registerSupportRoutes(app, { pool });
  // P3 gap #28 — public marketing contact form + ops triage queue
  registerContactRoutes(app, { pool });
  registerClientErrorRoutes(app);
  // Remaining-gaps §selector — public "which valuation do I need?" quiz
  registerValuationSelectorRoutes(app);
  // Public, no-signup common-stock FMV estimator behind the marketing calculator
  registerFmvEstimatorRoutes(app);
  // Public "see a sample report" outline, read off the real report templates
  registerSampleReportRoutes(app, { pdfLimiter: deps.sampleReportPdfLimiter });
  // P2 #12 — global activity audit viewer
  registerAdminEventRoutes(app, { pool });
  // R163 — the client API's own OpenAPI document and the error catalog behind
  // every problem+json body. Registered late so `routeAudit.all()` is complete
  // by the time either is served; both are pure reads of in-memory state.
  registerApiDocsRoutes(app, {
    // Read off the limiter objects this build installed, so the published
    // ceilings are the ones this process enforces rather than the ones its
    // config would enforce somewhere else.
    rateLimits: deploymentRateLimits({
      session: sessionLimiter,
      organisation: sessionOrgLimiter,
      cost: costLimiter,
    }),
  });
  // P2 #10 — help / knowledge base
  registerHelpRoutes(app, { pool });
  // Design §16.2 — the public marketing blog, shaped on the help centre.
  registerBlogRoutes(app, { pool });
  // §15.5/§15.6 — communication templates + auto email/SMS drip campaigns
  registerCommunicationRoutes(app, {
    pool,
    transport,
    smsTransport,
    publicBaseUrl: config.PUBLIC_BASE_URL,
    settings,
  });
  // Beyond-parity #1 — audit-defense evidence bundle (final-status §4.4)
  registerEvidenceRoutes(app, { pool });
  // Improvement 6 — programmatic partner API (API-key auth + per-key rate limit)
  registerPartnerApiRoutes(app, {
    pool,
    documentsDir: config.DOCUMENTS_DIR,
    transport,
    limiter: deps.partnerApiLimiter,
    orgLimiter:
      deps.partnerApiOrgLimiter !== undefined
        ? deps.partnerApiOrgLimiter
        : config.PARTNER_API_RATE_LIMIT_ORG_PER_MIN > 0
          ? new FixedWindowRateLimiter(config.PARTNER_API_RATE_LIMIT_ORG_PER_MIN, 60_000)
          : null,
    scan,
  });
  // P0 — outside-world integrations (remaining-gaps §6): Stripe + signatures
  registerPaymentRoutes(app, {
    pool,
    stripeSecretKey: config.STRIPE_SECRET_KEY,
    stripeWebhookSecret: config.STRIPE_WEBHOOK_SECRET,
    publicBaseUrl: config.PUBLIC_BASE_URL,
    transport,
    settings,
  });
  // Feature 7 — subscription / retainer billing + invoicing
  registerBillingRoutes(app, {
    pool,
    stripeSecretKey: config.STRIPE_SECRET_KEY,
    // Its own signing secret when the billing webhook is registered as a
    // separate Stripe endpoint (it has a different path, so it is one), falling
    // back to the payment secret for a single-endpoint deployment. See the
    // note on STRIPE_BILLING_WEBHOOK_SECRET in config.ts.
    stripeWebhookSecret: config.STRIPE_BILLING_WEBHOOK_SECRET ?? config.STRIPE_WEBHOOK_SECRET,
    publicBaseUrl: config.PUBLIC_BASE_URL,
    transport,
    settings,
  });
  registerSignatureRoutes(app, { pool });
  // Feature 5 — board approval workflow (resolution + e-signature collection)
  registerBoardApprovalRoutes(app, {
    pool,
    transport,
    publicBaseUrl: config.PUBLIC_BASE_URL,
    limiter: deps.boardPublicLimiter,
    settings,
  });
  // Feature 6 — grant management (option grants at the adopted 409A FMV)
  registerGrantRoutes(app, { pool });
  // Feature 7 — client self-service portal (intake questionnaire + reminders)
  registerIntakeRoutes(app, { pool, transport, settings });
  // Feature 8 — engagement lifecycle (stages, SLA, pipeline dashboard)
  registerEngagementRoutes(app, { pool, transport, settings });
  // Feature 9 — cap-table import + validation + waterfall feed
  registerCapTableRoutes(app, { pool });
  // Feature 10 — real-time valuation monitoring (revaluation triggers)
  registerMonitoringRoutes(app, { pool, transport, settings });
  // §23 — accounting software integrations (OAuth connect + P&L import)
  registerAccountingRoutes(app, {
    pool,
    jwt,
    publicBaseUrl: config.PUBLIC_BASE_URL,
    credentials: accountingCredentials(config),
    fetchFn: deps.accountingFetch,
  });
  // Feature 4 — live cap-table sync (Carta / Pulley OAuth connect + pull)
  registerCapTableSyncRoutes(app, {
    pool,
    jwt,
    publicBaseUrl: config.PUBLIC_BASE_URL,
    credentials: capTableSyncCredentials(config),
    fetchFn: deps.capTableSyncFetch,
  });

  // Refuse to finish booting with an endpoint nobody decided to make public.
  // Deferred to onReady so it also covers the encapsulated webhook/ACS scopes.
  assertRoutesGuarded(app, routeAudit);

  return app;
}

/**
 * Upload antivirus policy from env (documents/virusScan.ts).
 *
 * No `CLAMAV_HOST` means no scanner, which is the pre-existing behaviour and
 * the default: standing up clamd is a deployment decision, and a service that
 * refused to boot without one would make this change a breaking one. The
 * absence is logged at info so "did the scan run?" has an answer in the log
 * rather than only in the environment.
 */
export function resolveScanPolicy(config: Config, log: FastifyBaseLogger): ScanPolicy {
  if (!config.CLAMAV_HOST) {
    log.info('CLAMAV_HOST unset — uploaded documents are not virus scanned');
    return { failClosed: false };
  }
  log.info(
    { host: config.CLAMAV_HOST, port: config.CLAMAV_PORT, failClosed: config.VIRUS_SCAN_FAIL_CLOSED },
    'upload virus scanning enabled',
  );
  return {
    scanner: clamdScanner({
      host: config.CLAMAV_HOST,
      port: config.CLAMAV_PORT,
      timeoutMs: config.CLAMAV_TIMEOUT_MS,
    }),
    failClosed: config.VIRUS_SCAN_FAIL_CLOSED,
    log,
  };
}

/** Cap-table sync provider OAuth credentials from env (feature 4). */
export function capTableSyncCredentials(
  config: Config,
): Partial<Record<CapTableProvider, ProviderCredentials>> {
  const out: Partial<Record<CapTableProvider, ProviderCredentials>> = {};
  if (config.CARTA_CLIENT_ID && config.CARTA_CLIENT_SECRET)
    out.carta = { clientId: config.CARTA_CLIENT_ID, clientSecret: config.CARTA_CLIENT_SECRET };
  if (config.PULLEY_CLIENT_ID && config.PULLEY_CLIENT_SECRET)
    out.pulley = { clientId: config.PULLEY_CLIENT_ID, clientSecret: config.PULLEY_CLIENT_SECRET };
  return out;
}

/** HRIS provider OAuth credentials from env (feature 11). */
export function hrisCredentials(config: Config): Partial<Record<HrisProvider, ProviderCredentials>> {
  const out: Partial<Record<HrisProvider, ProviderCredentials>> = {};
  if (config.RIPPLING_CLIENT_ID && config.RIPPLING_CLIENT_SECRET)
    out.rippling = { clientId: config.RIPPLING_CLIENT_ID, clientSecret: config.RIPPLING_CLIENT_SECRET };
  if (config.GUSTO_CLIENT_ID && config.GUSTO_CLIENT_SECRET)
    out.gusto = { clientId: config.GUSTO_CLIENT_ID, clientSecret: config.GUSTO_CLIENT_SECRET };
  if (config.DEEL_CLIENT_ID && config.DEEL_CLIENT_SECRET)
    out.deel = { clientId: config.DEEL_CLIENT_ID, clientSecret: config.DEEL_CLIENT_SECRET };
  return out;
}

/** Provider OAuth credentials from env; a provider is active only when both halves are set. */
export function accountingCredentials(
  config: Config,
): Partial<Record<AccountingProvider, ProviderCredentials>> {
  const pairs: Array<[AccountingProvider, string | undefined, string | undefined]> = [
    ['xero', config.XERO_CLIENT_ID, config.XERO_CLIENT_SECRET],
    ['quickbooks', config.QUICKBOOKS_CLIENT_ID, config.QUICKBOOKS_CLIENT_SECRET],
    ['freshbooks', config.FRESHBOOKS_CLIENT_ID, config.FRESHBOOKS_CLIENT_SECRET],
    ['netsuite', config.NETSUITE_CLIENT_ID, config.NETSUITE_CLIENT_SECRET],
    ['sage', config.SAGE_CLIENT_ID, config.SAGE_CLIENT_SECRET],
    ['wave', config.WAVE_CLIENT_ID, config.WAVE_CLIENT_SECRET],
  ];
  const out: Partial<Record<AccountingProvider, ProviderCredentials>> = {};
  for (const [provider, clientId, clientSecret] of pairs) {
    if (clientId && clientSecret) out[provider] = { clientId, clientSecret };
  }
  return out;
}
