import Fastify, { type FastifyInstance } from 'fastify';
import { createLogger, registerHealth, registerProblemHandler } from '@n409/shared';

/**
 * Web/BFF skeleton (issue #1). M0 scope is the service split + health; the
 * client/partner/admin UI orchestration arrives with M1+ surfaces.
 */
export function buildApp(): FastifyInstance {
  const app = Fastify({
    loggerInstance: createLogger({ service: 'web' }),
  }) as unknown as FastifyInstance;
  registerProblemHandler(app);
  registerHealth(app, { service: 'web' });
  return app;
}
