import Fastify, { type FastifyInstance } from 'fastify';
import type pg from 'pg';
import { createLogger, registerHealth, registerProblemHandler } from '@n409/shared';
import type { Config } from './config.js';
import { GoogleOidc } from './auth/google.js';
import { registerAuth } from './plugins/auth.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerValuationRoutes } from './routes/valuations.js';
import { registerWorkflowRoutes } from './routes/workflow.js';
import { registerTemplateRoutes } from './routes/templates.js';
import { registerNotificationRoutes } from './routes/notifications.js';
import { registerTransactionRoutes } from './routes/transactions.js';
import { registerSearchRoutes } from './routes/search.js';
import { registerExportRoutes } from './routes/exports.js';
import { registerSensitivityRoutes } from './routes/sensitivity.js';
import { logTransport, type EmailTransport } from './hooks/stateChange.js';

export interface AppDeps {
  config: Config;
  pool: pg.Pool;
  /** injectable for tests */
  google?: GoogleOidc;
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
  // M4: auto-email transport; delivery status is tracked in email_outbox.
  const transport: EmailTransport | undefined =
    config.EMAIL_MODE === 'log' ? logTransport(app.log) : undefined;

  registerAuth(app, { pool, jwt });
  registerAuthRoutes(app, { pool, jwt, google });
  registerValuationRoutes(app, { pool, transport });
  registerWorkflowRoutes(app, { pool, transport });
  registerTemplateRoutes(app, { pool });
  registerNotificationRoutes(app, { pool });
  registerTransactionRoutes(app, { pool });
  registerSearchRoutes(app, { pool });
  registerExportRoutes(app, { pool });
  registerSensitivityRoutes(app, { pool });

  return app;
}
