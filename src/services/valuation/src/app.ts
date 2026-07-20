import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';
import helmet from '@fastify/helmet';
import cookie from '@fastify/cookie';
import type pg from 'pg';
import { createLogger, registerHealth, registerProblemHandler } from '@n409/shared';
import type { Config } from './config.js';
import { GoogleOidc } from './auth/google.js';
import { registerAuth } from './plugins/auth.js';
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
import { registerTransactionRoutes } from './routes/transactions.js';
import { registerSearchRoutes } from './routes/search.js';
import { registerExportRoutes } from './routes/exports.js';
import { registerSensitivityRoutes } from './routes/sensitivity.js';
import { logTransport, type EmailTransport } from './hooks/stateChange.js';
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
import { registerPipelineRoutes } from './routes/pipeline.js';
import type { AutoPipelineDeps } from './pipeline/autoPipeline.js';
import { registerParamsRoutes } from './routes/params.js';
import { registerEngineInputsRoutes } from './routes/engineInputs.js';
import { registerAiRoutes } from './routes/ai.js';
import { registerCalculationRoutes } from './routes/calculations.js';
import { registerBridgeRoutes } from './routes/bridge.js';
import { registerAnalyticsRoutes } from './routes/analytics.js';
import { registerOrganizationRoutes } from './routes/organizations.js';
import { registerAuditorPortalRoutes } from './routes/auditorPortal.js';
import { registerSamlRoutes } from './routes/saml.js';
import { registerScimRoutes } from './routes/scim.js';
import { registerAdminSsoRoutes } from './routes/adminSso.js';
import { registerRetentionRoutes } from './routes/retention.js';
import { registerScenarioRoutes } from './routes/scenarios.js';
import { registerOverwriteRoutes } from './routes/overwrites.js';
import { registerWorkbookRoutes } from './routes/workbook.js';
import { registerReportRoutes } from './routes/reports.js';
import { registerPromptRoutes } from './routes/prompts.js';
import { registerCompanyProfileRoutes } from './routes/companyProfile.js';
import { registerPackageRoutes } from './routes/packageView.js';
import { registerSupportRoutes } from './routes/support.js';
import { registerContactRoutes } from './routes/contact.js';
import { registerAdminEventRoutes } from './routes/adminEvents.js';
import { registerHelpRoutes } from './routes/help.js';
import { registerCommunicationRoutes } from './routes/communications.js';
import { registerAccountingRoutes } from './routes/accounting.js';
import { registerCapTableSyncRoutes } from './routes/capTableSync.js';
import type { CapTableProvider } from './clients/capTableSync.js';
import type { AccountingProvider, FetchFn, ProviderCredentials } from './clients/accounting.js';
import { registerEvidenceRoutes } from './routes/evidence.js';
import { registerQaRoutes } from './routes/qa.js';
import { registerHealthCheckRoutes } from './routes/healthChecks.js';
import { registerAsc718Routes } from './routes/asc718.js';
import { registerDecisionRoutes } from './routes/decisions.js';
import { registerProgressRoutes } from './routes/progress.js';
import { registerStreamRoutes } from './routes/stream.js';
import { ValuationHub } from './realtime/hub.js';
import { registerPartnerApiRoutes } from './routes/partnerApi.js';
import type { FixedWindowRateLimiter } from './plugins/rateLimit.js';

export interface AppDeps {
  config: Config;
  pool: pg.Pool;
  /** injectable for tests */
  google?: GoogleOidc;
  /** injectable for tests — partner API per-key rate limiter */
  partnerApiLimiter?: FixedWindowRateLimiter;
  /** injectable for tests — accounting provider HTTP */
  accountingFetch?: FetchFn;
  /** injectable for tests — cap-table sync provider HTTP */
  capTableSyncFetch?: FetchFn;
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
  const app = Fastify({
    loggerInstance: createLogger({ service: 'valuation', level: config.LOG_LEVEL }),
    requestIdHeader: 'x-request-id',
  }) as unknown as FastifyInstance;

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

  registerProblemHandler(app);
  registerHealth(app, {
    service: 'valuation',
    checks: {
      postgres: async () => {
        await pool.query('SELECT 1');
      },
    },
  });
  // Auto-email transport; delivery status is tracked in email_outbox.
  const { transport, smsTransport } = buildEmailTransports(config, app.log);

  // Runtime-editable system settings (registration switch, maintenance mode,
  // password floor). Cached — `maintenance_mode` is read on every mutating
  // request via app.authenticate.
  const settings = new SystemSettingsStore(pool);

  void app.register(multipart, { limits: { fileSize: MAX_DOCUMENT_BYTES, files: 1 } });
  // Parses Cookie headers into req.cookies so the auth plugin can read the
  // httpOnly session cookie (audit F-2).
  void app.register(cookie);
  // Secure cookies over HTTPS in production; plain http in dev/test.
  const sessionCookie = { secure: config.NODE_ENV === 'production', ttlSeconds: config.JWT_TTL_SECONDS };
  registerAuth(app, { pool, jwt, settings });
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
  });
  registerMfaRoutes(app, { pool, settings });
  registerSystemSettingsRoutes(app, { pool, settings });
  registerValuationRoutes(app, { pool, transport });
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
  registerDocumentRoutes(app, { pool, documentsDir: config.DOCUMENTS_DIR, autoPipeline });
  registerPipelineRoutes(app, { pool, autoPipeline });
  registerParamsRoutes(app, { pool });
  registerEngineInputsRoutes(app, { pool });
  registerAiRoutes(app, { pool, aiUrl: config.AI_URL, documentsDir: config.DOCUMENTS_DIR });
  // IMPROVEMENTS_RESEARCH Phase 1 — QA gate before publish, audit-defense
  // decision log, client-portal progress tracker
  registerQaRoutes(app, { pool, aiUrl: config.AI_URL, documentsDir: config.DOCUMENTS_DIR });
  registerHealthCheckRoutes(app, { pool });
  registerDecisionRoutes(app, { pool });
  registerProgressRoutes(app, { pool });
  registerCalculationRoutes(app, { pool, engineUrl: config.ENGINE_URL });
  registerBridgeRoutes(app, { pool });
  registerAnalyticsRoutes(app, { pool });
  registerOrganizationRoutes(app, { pool });
  registerAuditorPortalRoutes(app, { pool, publicBaseUrl: config.PUBLIC_BASE_URL });
  // Feature 9 — enterprise SSO: SAML 2.0 SP + SCIM 2.0 provisioning
  registerSamlRoutes(app, { pool, jwt, publicBaseUrl: config.PUBLIC_BASE_URL, cookie: sessionCookie });
  registerScimRoutes(app, { pool });
  registerAdminSsoRoutes(app, { pool });
  // Feature 10 — data retention + legal hold administration
  registerRetentionRoutes(app, { pool });
  // Improvement 3 — client-facing what-if scenario sandbox (read-only)
  registerScenarioRoutes(app, { pool, engineUrl: config.ENGINE_URL });
  // M2 — output & delivery
  registerOverwriteRoutes(app, { pool });
  registerWorkbookRoutes(app, { pool });
  registerReportRoutes(app, { pool });
  // Improvement 4 — realtime collaboration: presence + live comment pushes
  const hub = new ValuationHub();
  registerStreamRoutes(app, { pool, hub });
  // M3 — operations (comments/chat/email, admin console, tokens, analytics, clone)
  registerCommentRoutes(app, { pool, hub });
  registerAdminUserRoutes(app, { pool, transport, publicBaseUrl: config.PUBLIC_BASE_URL });
  registerApiTokenRoutes(app, { pool });
  registerOperationsRoutes(app, { pool });
  // M4 — operations polish
  registerWorkflowRoutes(app, { pool, transport });
  // P1 #6 — review queue + approve/request-changes decisions
  registerReviewRoutes(app, { pool, transport });
  registerTemplateRoutes(app, { pool });
  registerNotificationRoutes(app, { pool });
  registerTransactionRoutes(app, { pool });
  registerSearchRoutes(app, { pool });
  registerExportRoutes(app, { pool });
  registerSensitivityRoutes(app, { pool, engineUrl: config.ENGINE_URL });
  registerAsc718Routes(app, { pool });
  // P1/P2 remaining features — prompt registry, company profile, package
  // explorer, in-app support (docs/remaining-gaps.md)
  registerPromptRoutes(app, { pool, aiUrl: config.AI_URL });
  registerCompanyProfileRoutes(app, { pool });
  registerPackageRoutes(app, { pool });
  registerSupportRoutes(app, { pool });
  // P3 gap #28 — public marketing contact form + ops triage queue
  registerContactRoutes(app, { pool });
  // P2 #12 — global activity audit viewer
  registerAdminEventRoutes(app, { pool });
  // P2 #10 — help / knowledge base
  registerHelpRoutes(app, { pool });
  // §15.5/§15.6 — communication templates + auto email/SMS drip campaigns
  registerCommunicationRoutes(app, { pool, transport, smsTransport });
  // Beyond-parity #1 — audit-defense evidence bundle (final-status §4.4)
  registerEvidenceRoutes(app, { pool });
  // Improvement 6 — programmatic partner API (API-key auth + per-key rate limit)
  registerPartnerApiRoutes(app, {
    pool,
    documentsDir: config.DOCUMENTS_DIR,
    limiter: deps.partnerApiLimiter,
  });
  // P0 — outside-world integrations (remaining-gaps §6): Stripe + signatures
  registerPaymentRoutes(app, {
    pool,
    stripeSecretKey: config.STRIPE_SECRET_KEY,
    stripeWebhookSecret: config.STRIPE_WEBHOOK_SECRET,
    publicBaseUrl: config.PUBLIC_BASE_URL,
  });
  // Feature 7 — subscription / retainer billing + invoicing
  registerBillingRoutes(app, {
    pool,
    stripeSecretKey: config.STRIPE_SECRET_KEY,
    stripeWebhookSecret: config.STRIPE_WEBHOOK_SECRET,
    publicBaseUrl: config.PUBLIC_BASE_URL,
  });
  registerSignatureRoutes(app, { pool });
  // Feature 5 — board approval workflow (resolution + e-signature collection)
  registerBoardApprovalRoutes(app, {
    pool,
    transport,
    publicBaseUrl: config.PUBLIC_BASE_URL,
  });
  // Feature 6 — grant management (option grants at the adopted 409A FMV)
  registerGrantRoutes(app, { pool });
  // Feature 7 — client self-service portal (intake questionnaire + reminders)
  registerIntakeRoutes(app, { pool, transport });
  // Feature 8 — engagement lifecycle (stages, SLA, pipeline dashboard)
  registerEngagementRoutes(app, { pool, transport });
  // Feature 9 — cap-table import + validation + waterfall feed
  registerCapTableRoutes(app, { pool });
  // Feature 10 — real-time valuation monitoring (revaluation triggers)
  registerMonitoringRoutes(app, { pool, transport });
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

  return app;
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
