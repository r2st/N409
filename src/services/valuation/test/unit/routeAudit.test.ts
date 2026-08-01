import { describe, expect, it } from 'vitest';
import pg from 'pg';
import Fastify from 'fastify';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { PUBLIC_ROUTES, registerRouteAudit } from '../../src/plugins/routeAudit.js';

/**
 * The security property this file defends: no endpoint of the valuation API is
 * reachable without a session unless somebody wrote down why.
 *
 * `buildApp` itself fails `ready()` on a violation, so these tests mostly
 * assert that the guard is wired and still has teeth — including over the
 * encapsulated scopes (Stripe webhooks, SAML ACS) that register during boot
 * rather than during buildApp.
 */

/** pg.Pool connects lazily; nothing here issues a query. */
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

describe('route authentication audit', () => {
  it('every registered route is authenticated or explicitly public', async () => {
    const pool = stubPool();
    const app = buildApp({ config: testConfig(), pool });
    try {
      await app.ready();
      expect(app.routeAudit.unguarded()).toEqual([]);
    } finally {
      await app.close();
      await pool.end();
    }
  });

  it('the public allow-list has no stale entries', async () => {
    // A route that is renamed or deleted must not leave its exemption behind,
    // or the next route to take that URL inherits a waiver nobody granted it.
    const pool = stubPool();
    const app = buildApp({ config: testConfig(), pool });
    try {
      await app.ready();
      expect(app.routeAudit.staleExemptions()).toEqual([]);
    } finally {
      await app.close();
      await pool.end();
    }
  });

  it('covers the encapsulated webhook and SSO scopes', async () => {
    // These register inside `app.register()` bodies that only run on ready();
    // auditing synchronously would skip them, so assert they were seen.
    const pool = stubPool();
    const app = buildApp({ config: testConfig(), pool });
    try {
      await app.ready();
      // If any of these were missed, they would surface as stale exemptions.
      const stale = app.routeAudit.staleExemptions();
      expect(stale).not.toContain('POST /api/v1/stripe/webhook');
      expect(stale).not.toContain('POST /api/v1/billing/webhook');
      expect(stale).not.toContain('POST /api/v1/auth/saml/acs');
    } finally {
      await app.close();
      await pool.end();
    }
  });

  it('reports a route that has neither authentication nor an exemption', async () => {
    const app = Fastify({ logger: false });
    app.decorate('authenticate', async () => {});
    const audit = registerRouteAudit(app);
    app.get('/api/v1/leaky', async () => ({ ok: true }));
    app.get('/api/v1/guarded', { preHandler: app.authenticate }, async () => ({ ok: true }));
    await app.ready();

    expect(audit.unguarded()).toEqual(['GET /api/v1/leaky']);
    await app.close();
  });

  it('accepts authentication anywhere in a preHandler chain', async () => {
    // The partner API composes `[app.authenticate, apiKeyGuard]`.
    const app = Fastify({ logger: false });
    app.decorate('authenticate', async () => {});
    const audit = registerRouteAudit(app);
    app.get('/api/v1/chained', { preHandler: [app.authenticate, async () => {}] }, async () => ({}));
    await app.ready();

    expect(audit.unguarded()).toEqual([]);
    await app.close();
  });

  it('every exemption records why the route is public', () => {
    for (const route of PUBLIC_ROUTES) {
      expect(route.reason.length, `${route.method} ${route.url}`).toBeGreaterThan(10);
    }
  });

  it('lists no exemption twice', () => {
    const keys = PUBLIC_ROUTES.map((r) => `${r.method} ${r.url}`);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
