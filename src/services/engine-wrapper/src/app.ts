import Fastify, { type FastifyInstance } from 'fastify';
import { createLogger, registerHealth, registerProblemHandler } from '@n409/shared';

/**
 * Engine wrapper skeleton (issue #1). Will front the existing R/Plumber
 * engine behind the versioned /engine/v1 contract in M3 (#16). M0 exposes the
 * contract's health endpoint reporting the pinned engine image digest.
 */
export function buildApp(): FastifyInstance {
  const app = Fastify({
    loggerInstance: createLogger({ service: 'engine-wrapper' }),
  }) as unknown as FastifyInstance;
  registerProblemHandler(app);
  registerHealth(app, { service: 'engine-wrapper' });

  // api-design.md §4 — GET /engine/v1/health (+ version/digest)
  app.get('/engine/v1/health', async () => ({
    status: 'ok',
    engine_version: process.env.ENGINE_IMAGE_DIGEST ?? 'not-yet-wrapped',
    contract: 'engine/v1',
  }));

  return app;
}
