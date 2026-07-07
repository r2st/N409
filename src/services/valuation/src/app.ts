import Fastify, { type FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';
import type pg from 'pg';
import { createLogger, registerHealth, registerProblemHandler } from '@n409/shared';
import type { Config } from './config.js';
import { GoogleOidc } from './auth/google.js';
import { registerAuth } from './plugins/auth.js';
import { registerAuthRoutes } from './routes/auth.js';
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
import { registerSignatureRoutes } from './routes/signatures.js';
import { registerTaskRoutes } from './routes/tasks.js';
import { registerDocumentRoutes, MAX_DOCUMENT_BYTES } from './routes/documents.js';
import { registerPipelineRoutes } from './routes/pipeline.js';
import type { AutoPipelineDeps } from './pipeline/autoPipeline.js';
import { registerParamsRoutes } from './routes/params.js';
import { registerAiRoutes } from './routes/ai.js';
import { registerCalculationRoutes } from './routes/calculations.js';
import { registerScenarioRoutes } from './routes/scenarios.js';
import { registerOverwriteRoutes } from './routes/overwrites.js';
import { registerWorkbookRoutes } from './routes/workbook.js';
import { registerReportRoutes } from './routes/reports.js';
import { registerPromptRoutes } from './routes/prompts.js';
import { registerCompanyProfileRoutes } from './routes/companyProfile.js';
import { registerPackageRoutes } from './routes/packageView.js';
import { registerSupportRoutes } from './routes/support.js';
import { registerAdminEventRoutes } from './routes/adminEvents.js';
import { registerHelpRoutes } from './routes/help.js';
import { registerEvidenceRoutes } from './routes/evidence.js';
import { registerPartnerApiRoutes } from './routes/partnerApi.js';
import type { FixedWindowRateLimiter } from './plugins/rateLimit.js';

export interface AppDeps {
  config: Config;
  pool: pg.Pool;
  /** injectable for tests */
  google?: GoogleOidc;
  /** injectable for tests — partner API per-key rate limiter */
  partnerApiLimiter?: FixedWindowRateLimiter;
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
  // 'smtp' needs SMTP_HOST — otherwise fall back to 'log' so a misconfigured
  // box degrades to logging instead of silently dropping mail.
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
      app.log,
    );
  } else if (config.EMAIL_MODE !== 'off') {
    if (config.EMAIL_MODE === 'smtp') {
      app.log.warn('EMAIL_MODE=smtp but SMTP_HOST is unset — falling back to log transport');
    }
    transport = logTransport(app.log);
  }

  void app.register(multipart, { limits: { fileSize: MAX_DOCUMENT_BYTES, files: 1 } });
  registerAuth(app, { pool, jwt });
  registerAuthRoutes(app, { pool, jwt, google, transport, publicBaseUrl: config.PUBLIC_BASE_URL });
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
  registerAiRoutes(app, { pool, aiUrl: config.AI_URL, documentsDir: config.DOCUMENTS_DIR });
  registerCalculationRoutes(app, { pool, engineUrl: config.ENGINE_URL });
  // Improvement 3 — client-facing what-if scenario sandbox (read-only)
  registerScenarioRoutes(app, { pool, engineUrl: config.ENGINE_URL });
  // M2 — output & delivery
  registerOverwriteRoutes(app, { pool });
  registerWorkbookRoutes(app, { pool });
  registerReportRoutes(app, { pool });
  // M3 — operations (comments/chat/email, admin console, tokens, analytics, clone)
  registerCommentRoutes(app, { pool });
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
  registerSensitivityRoutes(app, { pool });
  // P1/P2 remaining features — prompt registry, company profile, package
  // explorer, in-app support (docs/remaining-gaps.md)
  registerPromptRoutes(app, { pool, aiUrl: config.AI_URL });
  registerCompanyProfileRoutes(app, { pool });
  registerPackageRoutes(app, { pool });
  registerSupportRoutes(app, { pool });
  // P2 #12 — global activity audit viewer
  registerAdminEventRoutes(app, { pool });
  // P2 #10 — help / knowledge base
  registerHelpRoutes(app, { pool });
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
  registerSignatureRoutes(app, { pool });

  return app;
}
