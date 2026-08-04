import { describe, expect, it } from 'vitest';
import pg from 'pg';
import {
  COST_RULES,
  DEFAULT_COST,
  costOfRequest,
  isHeavyRequest,
  normalizePath,
} from '../../src/domain/requestCost.js';
import { WeightedWindowRateLimiter } from '../../src/plugins/rateLimit.js';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';

const VAL = '/api/v1/valuations/01JZZZZZZZZZZZZZZZZZZZZZZZ';

/** pg.Pool connects lazily; nothing in this file issues a query. */
function stubPool(): pg.Pool {
  return new pg.Pool({ connectionString: 'postgres://unused:unused@127.0.0.1:1/unused' });
}

function testConfig() {
  return loadConfig({
    ...process.env,
    NODE_ENV: 'test',
    JWT_SECRET: 'z'.repeat(48),
    LOG_LEVEL: 'silent',
  } as NodeJS.ProcessEnv);
}

/** `METHOD /url` with every `:param` filled in, as a request would arrive. */
function concreteRoutes(keys: string[]): Array<{ method: string; path: string }> {
  return keys.map((k) => {
    const [method, url] = k.split(' ') as [string, string];
    return { method, path: url.replace(/:[^/]+/g, 'x') };
  });
}

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

  /**
   * The invariant the table lost: seven of its rules matched no URL this
   * service registers (`/ai/jobs`, `/backsolve`, `/agents/…`,
   * `/scenarios/:id/run`, `/asc718/expense`, `/documents/:id/content`,
   * `.zip`), so the routes they were written to price ran free. A dead rule is
   * invisible — it neither errors nor logs — which is why it has to be a test.
   */
  it('has no rule that matches nothing this service registers', async () => {
    const pool = stubPool();
    const app = buildApp({ config: testConfig(), pool });
    try {
      await app.ready();
      const routes = concreteRoutes(app.routeAudit.all());
      const dead = COST_RULES.filter(
        (rule) =>
          !routes.some(
            (r) =>
              (!rule.methods || rule.methods.includes(r.method.toUpperCase())) &&
              rule.pattern.test(normalizePath(r.path)),
          ),
      ).map((rule) => `${rule.methods?.join('|') ?? 'ANY'} ${rule.pattern}`);
      expect(dead).toEqual([]);
    } finally {
      await app.close();
      await pool.end();
    }
  });

  /** Every route that spends an LLM call or an engine round-trip is charged. */
  it('charges every route that leaves the process for AI or the engine', async () => {
    const pool = stubPool();
    const app = buildApp({ config: testConfig(), pool });
    try {
      await app.ready();
      const registered = new Set(app.routeAudit.all());
      const mustCost: Array<[string, string]> = [
        ['POST', '/api/v1/valuations/:id/ai/:pipeline'],
        ['POST', '/api/v1/admin/prompts/:id/test'],
        ['POST', '/api/v1/valuations/:id/qa'],
        ['POST', '/api/v1/valuations/:id/calculations'],
        ['POST', '/api/v1/valuations/:id/scenarios'],
        ['POST', '/api/v1/valuations/:id/scenarios/preview'],
        ['POST', '/api/v1/valuations/:id/sensitivity'],
        ['POST', '/api/v1/valuations/:id/sensitivity/model'],
        ['POST', '/api/v1/valuations/:id/asc718'],
        ['POST', '/api/v1/valuations/:id/report/render'],
        ['POST', '/api/v1/valuations/:id/evidence-bundle'],
        ['POST', '/api/v1/debt/instruments/:id/value'],
        ['POST', '/api/v1/debt/rating-spread'],
        ['POST', '/api/v1/funds/:id/waterfall'],
        ['POST', '/api/v1/funds/:id/calibrate'],
        ['GET', '/api/v1/valuations/export'],
        ['GET', '/api/v1/users/export'],
        ['GET', '/api/v1/valuations/:id/documents/:documentId/download'],
      ];
      for (const [method, url] of mustCost) {
        // Guards the list itself: a renamed route must fail here, not silently
        // stop being asserted.
        expect(registered, `${method} ${url} is no longer registered`).toContain(`${method} ${url}`);
        expect(costOfRequest(method, url.replace(/:[^/]+/g, 'x')), `${method} ${url}`).toBeGreaterThan(0);
      }
    } finally {
      await app.close();
      await pool.end();
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
    expect(costOfRequest('POST', `${VAL}/evidence-bundle`)).toBeGreaterThan(0);
    expect(costOfRequest('GET', `${VAL}/audit-trail.csv`)).toBeGreaterThan(0);
  });

  it('charges the render that produces the PDF, not only the download', () => {
    // `.pdf$` never matched POST …/report/render, so the expensive half of the
    // pair — the one that actually runs the renderer — was free.
    expect(costOfRequest('POST', `${VAL}/report/render`)).toBeGreaterThan(0);
  });

  it('charges engine round-trips only on the methods that run them', () => {
    expect(costOfRequest('POST', `${VAL}/calculations`)).toBeGreaterThan(0);
    expect(costOfRequest('GET', `${VAL}/calculations`)).toBe(DEFAULT_COST);
    expect(costOfRequest('POST', `${VAL}/scenarios`)).toBeGreaterThan(0);
    expect(costOfRequest('GET', `${VAL}/scenarios`)).toBe(DEFAULT_COST);
  });

  it('charges AI pipelines the most of any single request', () => {
    const ai = costOfRequest('POST', `${VAL}/ai/extract`);
    expect(ai).toBeGreaterThan(costOfRequest('GET', `${VAL}/report.pdf`));
    expect(ai).toBeGreaterThan(costOfRequest('GET', '/api/v1/search'));
    // Every pipeline the route accepts, not just the one that got a rule.
    for (const pipeline of ['extract', 'summarize', 'comparables', 'missing_data', 'explain']) {
      expect(costOfRequest('POST', `${VAL}/ai/${pipeline}`), pipeline).toBe(ai);
    }
  });

  it('leaves the apply step cheap — it re-reads a stored job, it does not run one', () => {
    expect(costOfRequest('POST', `${VAL}/ai/extract/apply`)).toBe(DEFAULT_COST);
    expect(costOfRequest('GET', `${VAL}/ai`)).toBe(DEFAULT_COST);
  });

  it('prices a bundle above a single render', () => {
    expect(costOfRequest('POST', `${VAL}/evidence-bundle`)).toBeGreaterThan(
      costOfRequest('GET', `${VAL}/report.pdf`),
    );
  });

  it('ignores the query string when matching', () => {
    expect(costOfRequest('GET', `${VAL}/report.pdf?version=3`)).toBe(
      costOfRequest('GET', `${VAL}/report.pdf`),
    );
  });

  it('matches methods case-insensitively', () => {
    expect(costOfRequest('post', `${VAL}/calculations`)).toBe(costOfRequest('POST', `${VAL}/calculations`));
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
    const cost = costOfRequest('POST', `${VAL}/evidence-bundle`);
    let admitted = 0;
    for (let i = 0; i < 50; i += 1) {
      if (limiter.consume('u1', cost, i).allowed) admitted += 1;
    }
    expect(admitted).toBeLessThanOrEqual(Math.ceil(200 / cost));
    expect(admitted).toBeGreaterThan(0);
  });
});
