import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { authHeader, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';

const dbUp = await isDbAvailable();

/**
 * Nothing leaves this service without saying whether it may be stored.
 *
 * The API sent no `Cache-Control` at all, which is not the same thing as "do
 * not cache" to either party downstream of it. The browser writes an `inline`
 * PDF — a company's 409A — into its disk cache, where it stays on whatever
 * machine last opened it. And `409.doaide.com` is Cloudflare-proxied, where
 * what may be stored is decided partly from the file extension: `.pdf`, `.csv`
 * and `.xlsx` are all on Cloudflare's default list, and this service serves all
 * three under a bearer token.
 *
 * So `no-store` is the default and a route that wants to be cached says so.
 * Two halves are pinned here: that the default actually reaches a response,
 * and — the half that rots — that the set of routes opting out of it is a set
 * somebody decided on.
 */
describe.skipIf(!dbUp)('cache-control', () => {
  let ctx: TestApp;
  let ops: { id: string; token: string };
  let valuationId: string;

  beforeAll(async () => {
    ctx = await setupTestApp({ AUTO_PIPELINE: 'off', EMAIL_MODE: 'off' });
    ops = await seedUser(ctx, { roles: ['admin'] });
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/valuations',
      headers: authHeader(ops.token),
      payload: { kind: '409a', company_name: 'Cacheable, Inc.' },
    });
    expect(created.statusCode).toBe(201);
    valuationId = created.json().valuation.id as string;
  }, 120_000);
  afterAll(async () => ctx?.teardown());

  const header = async (
    url: string,
    token?: string,
  ): Promise<{ status: number; cache: string | undefined }> => {
    const res = await ctx.app.inject({
      method: 'GET',
      url,
      ...(token ? { headers: authHeader(token) } : {}),
    });
    return { status: res.statusCode, cache: res.headers['cache-control'] as string | undefined };
  };

  it('marks every ordinary response no-store', async () => {
    const urls = [
      '/api/v1/valuations',
      '/api/v1/me',
      `/api/v1/valuations/${valuationId}`,
      `/api/v1/valuations/${valuationId}/documents`,
      `/api/v1/valuations/${valuationId}/cap-table`,
      '/api/v1/notifications',
      '/api/v1/admin/events',
      '/api/v1/search?q=Cacheable',
    ];
    for (const url of urls) {
      const { status, cache } = await header(url, ops.token);
      expect(status, url).toBeLessThan(400);
      expect(cache, url).toBe('no-store');
    }
  });

  it('marks the deliverables no-store, which is what the edge decides by extension', async () => {
    // The report has to exist and be rendered before it can be downloaded.
    await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/valuations/${valuationId}/report`,
      headers: authHeader(ops.token),
    });
    for (const url of [
      `/api/v1/valuations/${valuationId}/report.pdf`,
      `/api/v1/valuations/${valuationId}/audit-trail.csv`,
      '/api/v1/valuations/export',
    ]) {
      const { status, cache } = await header(url, ops.token);
      expect(status, url).toBeLessThan(400);
      expect(cache, url).toBe('no-store');
    }
  });

  it('marks a refusal no-store too', async () => {
    // A 401 or a 404 is as cacheable as a 200 to anything in the path, and a
    // stored "no such engagement" outlives the moment it was true.
    for (const [url, expected] of [
      ['/api/v1/valuations', 401],
      ['/api/v1/valuations/01ARZ3NDEKTSV4RRFFQ69G5FAV', 401],
    ] as const) {
      const res = await ctx.app.inject({ method: 'GET', url });
      expect(res.statusCode).toBe(expected);
      expect(res.headers['cache-control']).toBe('no-store');
    }
  });

  it('leaves a route that asked to be cached alone', async () => {
    // The public sample report is marketing collateral behind a CDN — the one
    // thing here that genuinely wants an edge copy.
    const sample = await header('/api/v1/sample-report/pdf?kind=409a');
    expect(sample.status).toBe(200);
    expect(sample.cache).toBe('public, max-age=3600');

    // And the conditional-GET routes keep the directive that makes a browser
    // send `If-None-Match` at all; `no-store` would silently disable the 304s.
    const help = await header('/api/v1/help/articles', ops.token);
    expect(help.status).toBe(200);
    expect(help.cache).toBe('private, no-cache');
  });

  /**
   * The population half. Every route file that sets `cache-control` itself is
   * opting out of the default, and the point of a default is that opting out
   * is a decision somebody made rather than a line nobody noticed.
   */
  it('has no undeclared opt-out', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const routes = join(here, '../../src/routes');
    const DECLARED: Record<string, string> = {
      // Marketing collateral, served publicly and unchanged for an hour.
      'sampleReport.ts': 'public sample — deliberately edge-cacheable',
      // SSE. `no-cache` is what keeps a proxy from buffering the stream.
      'stream.ts': 'event stream — no-cache, not no-store',
      // Already explicit before the default existed, and still correct.
      'account.ts': 'MFA secrets — explicit no-store',
      'adminUsers.ts': 'user export — explicit no-store',
      'unsubscribe.ts': 'one-time token page — explicit no-store',
      // Public read-only content that revalidates rather than re-downloads;
      // the directive is what makes the ETag do anything.
      'help.ts': 'conditionalJson — private, no-cache',
      'blog.ts': 'conditionalJson — public revalidation',
      'branding.ts': 'conditionalJson — public revalidation',
    };
    const setters = readdirSync(routes)
      .filter((f) => f.endsWith('.ts'))
      .filter((f) => /cache-control|conditionalJson/.test(readFileSync(join(routes, f), 'utf8')));
    expect(setters.sort()).toEqual(Object.keys(DECLARED).sort());
  });
});
