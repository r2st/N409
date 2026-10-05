import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { registerProblemHandler } from '@n409/shared';
import { registerFmvEstimatorRoutes } from '../../src/routes/fmvEstimator.js';
import { registerValuationSelectorRoutes } from '../../src/routes/valuationSelector.js';
import { FixedWindowRateLimiter } from '../../src/plugins/rateLimit.js';

/**
 * R378: the two public computation endpoints were the only public POST routes
 * with no per-IP rate limiter. Their comments cited "the platform limiter" but
 * that limiter (`applyCostLimiter`) keys on `req.principal.id`, which is absent
 * on unauthenticated requests, so no throttle existed at all.
 */

describe('POST /api/v1/fmv-estimator rate limiting', () => {
  const validPayload = { stage: 'series_a', round_age: 'under_6m', post_money: 25_000_000 };

  it('answers 429 after the per-IP budget is spent', async () => {
    const limiter = new FixedWindowRateLimiter(2, 60_000);
    const app = Fastify({ logger: false });
    registerProblemHandler(app);
    registerFmvEstimatorRoutes(app, { limiter });
    try {
      for (let i = 0; i < 2; i++) {
        const res = await app.inject({ method: 'POST', url: '/api/v1/fmv-estimator', payload: validPayload });
        expect(res.statusCode).toBe(200);
      }
      const refused = await app.inject({
        method: 'POST',
        url: '/api/v1/fmv-estimator',
        payload: validPayload,
      });
      expect(refused.statusCode).toBe(429);
      expect(refused.json().detail).toMatch(/too many/i);
    } finally {
      await app.close();
    }
  });

  it('throttles before validation, so a flood of junk is refused too', async () => {
    const limiter = new FixedWindowRateLimiter(1, 60_000);
    const app = Fastify({ logger: false });
    registerProblemHandler(app);
    registerFmvEstimatorRoutes(app, { limiter });
    try {
      await app.inject({ method: 'POST', url: '/api/v1/fmv-estimator', payload: validPayload });
      const refused = await app.inject({
        method: 'POST',
        url: '/api/v1/fmv-estimator',
        payload: { garbage: true },
      });
      // 429 rather than 422: the throttle runs before the body is parsed.
      expect(refused.statusCode).toBe(429);
    } finally {
      await app.close();
    }
  });
});

describe('POST /api/v1/valuation-selector rate limiting', () => {
  const validPayload = { purpose: 'issue_options', jurisdiction: 'us' };

  it('answers 429 after the per-IP budget is spent', async () => {
    const limiter = new FixedWindowRateLimiter(2, 60_000);
    const app = Fastify({ logger: false });
    registerProblemHandler(app);
    registerValuationSelectorRoutes(app, { limiter });
    try {
      for (let i = 0; i < 2; i++) {
        const res = await app.inject({
          method: 'POST',
          url: '/api/v1/valuation-selector',
          payload: validPayload,
        });
        expect(res.statusCode).toBe(200);
      }
      const refused = await app.inject({
        method: 'POST',
        url: '/api/v1/valuation-selector',
        payload: validPayload,
      });
      expect(refused.statusCode).toBe(429);
      expect(refused.json().detail).toMatch(/too many/i);
    } finally {
      await app.close();
    }
  });

  it('throttles before validation', async () => {
    const limiter = new FixedWindowRateLimiter(1, 60_000);
    const app = Fastify({ logger: false });
    registerProblemHandler(app);
    registerValuationSelectorRoutes(app, { limiter });
    try {
      await app.inject({ method: 'POST', url: '/api/v1/valuation-selector', payload: validPayload });
      const refused = await app.inject({
        method: 'POST',
        url: '/api/v1/valuation-selector',
        payload: { garbage: true },
      });
      expect(refused.statusCode).toBe(429);
    } finally {
      await app.close();
    }
  });
});
