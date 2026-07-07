import Fastify, { type FastifyInstance } from 'fastify';
import type pg from 'pg';
import { createLogger, registerHealth, registerProblemHandler } from '@n409/shared';
import type { Config } from './config.js';
import { GoogleOidc } from './auth/google.js';
import { registerAuth } from './plugins/auth.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerValuationRoutes } from './routes/valuations.js';

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
  registerAuth(app, { pool, jwt });
  registerAuthRoutes(app, { pool, jwt, google });
  registerValuationRoutes(app, { pool });

  return app;
}
