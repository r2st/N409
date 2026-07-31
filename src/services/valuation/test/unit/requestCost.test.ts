import { describe, expect, it } from 'vitest';
import {
  COST_RULES,
  DEFAULT_COST,
  costOfRequest,
  isHeavyRequest,
  normalizePath,
} from '../../src/domain/requestCost.js';
import { WeightedWindowRateLimiter } from '../../src/plugins/rateLimit.js';

const VAL = '/api/v1/valuations/01JZZZZZZZZZZZZZZZZZZZZZZZ';

describe('normalizePath', () => {
  it('drops the query string', () => {
    expect(normalizePath('/api/v1/search?q=acme&page=2')).toBe('/api/v1/search');
  });

  it('drops a trailing slash', () => {
    expect(normalizePath('/api/v1/search/')).toBe('/api/v1/search');
  });

  it('leaves the root path alone', () => {
    expect(normalizePath('/')).toBe('/');
  });

  it('handles a path with no query string', () => {
    expect(normalizePath('/api/v1/valuations')).toBe('/api/v1/valuations');
  });
});

describe('COST_RULES', () => {
  it('assigns every rule a positive cost', () => {
    for (const rule of COST_RULES) {
      expect(rule.cost, String(rule.pattern)).toBeGreaterThan(0);
    }
  });

  it('uses upper-case method names so matching is unambiguous', () => {
    for (const rule of COST_RULES) {
      for (const method of rule.methods ?? []) {
        expect(method).toBe(method.toUpperCase());
      }
    }
  });
});

describe('costOfRequest', () => {
  it('charges ordinary reads nothing', () => {
    expect(costOfRequest('GET', '/api/v1/valuations')).toBe(DEFAULT_COST);
    expect(costOfRequest('GET', `${VAL}`)).toBe(DEFAULT_COST);
    expect(costOfRequest('PATCH', `${VAL}/params`)).toBe(DEFAULT_COST);
    expect(costOfRequest('GET', '/health')).toBe(DEFAULT_COST);
  });

  it('charges document renders and bundles', () => {
    expect(costOfRequest('GET', `${VAL}/report.pdf`)).toBeGreaterThan(0);
    expect(costOfRequest('GET', `${VAL}/workbook.xlsx`)).toBeGreaterThan(0);
    expect(costOfRequest('GET', `${VAL}/evidence.zip`)).toBeGreaterThan(0);
    expect(costOfRequest('GET', `${VAL}/cap-table.csv`)).toBeGreaterThan(0);
  });

  it('charges engine round-trips only on the methods that run them', () => {
    expect(costOfRequest('POST', `${VAL}/calculations`)).toBeGreaterThan(0);
    expect(costOfRequest('GET', `${VAL}/calculations`)).toBe(DEFAULT_COST);
  });

  it('charges AI pipelines the most of any single request', () => {
    const ai = costOfRequest('POST', `${VAL}/ai/jobs`);
    expect(ai).toBeGreaterThan(costOfRequest('GET', `${VAL}/report.pdf`));
    expect(ai).toBeGreaterThan(costOfRequest('GET', '/api/v1/search'));
  });

  it('prices a bundle above a single render', () => {
    expect(costOfRequest('GET', `${VAL}/evidence.zip`)).toBeGreaterThan(
      costOfRequest('GET', `${VAL}/report.pdf`),
    );
  });

  it('ignores the query string when matching', () => {
    expect(costOfRequest('GET', `${VAL}/report.pdf?version=3`)).toBe(
      costOfRequest('GET', `${VAL}/report.pdf`),
    );
  });

  it('matches methods case-insensitively', () => {
    expect(costOfRequest('post', `${VAL}/calculations`)).toBe(
      costOfRequest('POST', `${VAL}/calculations`),
    );
  });

  it('never returns a negative cost', () => {
    for (const url of ['/', '/health', `${VAL}`, `${VAL}/report.pdf`, '/api/v1/search']) {
      for (const method of ['GET', 'POST', 'PATCH', 'DELETE']) {
        expect(costOfRequest(method, url)).toBeGreaterThanOrEqual(0);
      }
    }
  });
});

describe('isHeavyRequest', () => {
  it('is true exactly when a cost is charged', () => {
    expect(isHeavyRequest('GET', `${VAL}/report.pdf`)).toBe(true);
    expect(isHeavyRequest('GET', '/api/v1/valuations')).toBe(false);
  });
});

describe('WeightedWindowRateLimiter', () => {
  const WINDOW = 60_000;

  it('admits requests until the budget is spent', () => {
    const limiter = new WeightedWindowRateLimiter(30, WINDOW);
    expect(limiter.consume('u1', 10, 0).allowed).toBe(true);
    expect(limiter.consume('u1', 10, 1).allowed).toBe(true);
    expect(limiter.consume('u1', 10, 2).allowed).toBe(true);
    expect(limiter.consume('u1', 10, 3).allowed).toBe(false);
  });

  it('reports the remaining budget, not a request count', () => {
    const limiter = new WeightedWindowRateLimiter(100, WINDOW);
    expect(limiter.consume('u1', 25, 0).remaining).toBe(75);
    expect(limiter.consume('u1', 25, 1).remaining).toBe(50);
  });

  it('does not charge a request it rejects', () => {
    const limiter = new WeightedWindowRateLimiter(30, WINDOW);
    limiter.consume('u1', 25, 0);
    expect(limiter.consume('u1', 25, 1).allowed).toBe(false);
    expect(limiter.spent('u1', 1)).toBe(25);
    // A cheaper request still fits in what is left.
    expect(limiter.consume('u1', 5, 2).allowed).toBe(true);
  });

  it('keys budgets separately per user', () => {
    const limiter = new WeightedWindowRateLimiter(10, WINDOW);
    expect(limiter.consume('u1', 10, 0).allowed).toBe(true);
    expect(limiter.consume('u2', 10, 0).allowed).toBe(true);
    expect(limiter.consume('u1', 1, 1).allowed).toBe(false);
  });

  it('resets when the window rolls over', () => {
    const limiter = new WeightedWindowRateLimiter(10, WINDOW);
    limiter.consume('u1', 10, 0);
    expect(limiter.consume('u1', 10, WINDOW - 1).allowed).toBe(false);
    expect(limiter.consume('u1', 10, WINDOW).allowed).toBe(true);
  });

  it('reports a reset time inside the window', () => {
    const limiter = new WeightedWindowRateLimiter(10, WINDOW);
    const first = limiter.consume('u1', 1, 1_000);
    expect(first.resetAt).toBe(1_000 + WINDOW);
    expect(limiter.consume('u1', 1, 2_000).resetAt).toBe(1_000 + WINDOW);
  });

  it('admits an over-budget request once rather than taking the route offline', () => {
    const limiter = new WeightedWindowRateLimiter(10, WINDOW);
    // First call in a window always opens it, even at a cost above the budget.
    expect(limiter.consume('u1', 999, 0).allowed).toBe(true);
    // But nothing else gets through until the window rolls.
    expect(limiter.consume('u1', 1, 1).allowed).toBe(false);
  });

  it('never reports negative headroom', () => {
    const limiter = new WeightedWindowRateLimiter(10, WINDOW);
    expect(limiter.consume('u1', 999, 0).remaining).toBe(0);
    expect(limiter.consume('u1', 1, 1).remaining).toBe(0);
  });

  it('reports zero spent for an unknown or expired key', () => {
    const limiter = new WeightedWindowRateLimiter(10, WINDOW);
    expect(limiter.spent('nobody', 0)).toBe(0);
    limiter.consume('u1', 5, 0);
    expect(limiter.spent('u1', WINDOW)).toBe(0);
  });

  it('lets a realistic minute of work through the shipped default budget', () => {
    // Default is 200 units/min: a client pulling their report and workbook and
    // running a calculation must not be throttled.
    const limiter = new WeightedWindowRateLimiter(200, WINDOW);
    const requests: Array<[string, string]> = [
      ['GET', `${VAL}/report.pdf`],
      ['GET', `${VAL}/workbook.xlsx`],
      ['POST', `${VAL}/calculations`],
      ['GET', '/api/v1/search'],
      ['GET', `${VAL}/audit-trail`],
    ];
    for (const [method, url] of requests) {
      expect(limiter.consume('u1', costOfRequest(method, url), 0).allowed, url).toBe(true);
    }
  });

  it('stops a user spraying evidence bundles', () => {
    const limiter = new WeightedWindowRateLimiter(200, WINDOW);
    const cost = costOfRequest('GET', `${VAL}/evidence.zip`);
    let admitted = 0;
    for (let i = 0; i < 50; i += 1) {
      if (limiter.consume('u1', cost, i).allowed) admitted += 1;
    }
    expect(admitted).toBeLessThanOrEqual(Math.ceil(200 / cost));
    expect(admitted).toBeGreaterThan(0);
  });
});
