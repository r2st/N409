import Fastify, { type FastifyInstance } from 'fastify';
import { createLogger, registerHealth, registerProblemHandler } from '@n409/shared';

/**
 * Report service skeleton (issue #1). Versioned templates, editor persistence
 * and PDF rendering arrive in M4 (#21).
 */
export function buildApp(): FastifyInstance {
  const app = Fastify({
    loggerInstance: createLogger({ service: 'report' }),
  }) as unknown as FastifyInstance;
  registerProblemHandler(app);
  registerHealth(app, { service: 'report' });
  return app;
}
