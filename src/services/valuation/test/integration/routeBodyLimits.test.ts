import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authHeader, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';

const dbUp = await isDbAvailable();

/**
 * A route whose schema declares a body the transport will not carry.
 *
 * `buildApp` sets no `bodyLimit`, so Fastify's 1 MiB default bounds every route
 * on this service — and three of them state, in their own zod schemas, a body
 * several times that. The refusal comes from the content-type parser, before
 * the handler and before the schema, so it names no field and quotes no limit:
 * an analyst is told "Request body is too large" about a report their editor
 * believes is legal. See routes/bodyLimits.ts.
 *
 * The assertions are one-sided on purpose. Each case sends a body at its
 * schema's stated ceiling and asserts only that the parser did not refuse it —
 * what the handler then decides is that route's own business, tested where that
 * route is tested. The last case is the other half: the default must still hold
 * everywhere it was not deliberately raised.
 */
describe.skipIf(!dbUp)('declared body ceilings are reachable', () => {
  let ctx: TestApp;
  let admin: Awaited<ReturnType<typeof seedUser>>;
  let valuationId: string;

  beforeAll(async () => {
    ctx = await setupTestApp();
    admin = await seedUser(ctx, { roles: ['admin'] });
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/valuations',
      headers: authHeader(admin.token),
      payload: { kind: '409a', company_name: 'Long Prose Co' },
    });
    valuationId = created.json().valuation.id;
  });
  afterAll(async () => ctx?.teardown());

  /** `PutBody`: 50 sections of 100,000 characters, which is what the editor allows. */
  it('accepts a report at the report schema’s ceiling', async () => {
    const html = 'x'.repeat(100_000);
    const sections = Array.from({ length: 50 }, (_, i) => ({
      key: `chapter-${i}`,
      heading: `Chapter ${i + 1}`,
      html,
    }));
    const res = await ctx.app.inject({
      method: 'PUT',
      url: `/api/v1/valuations/${valuationId}/report`,
      headers: authHeader(admin.token),
      payload: { content: { title: 'Valuation Report', sections } },
    });
    expect(res.statusCode).not.toBe(413);
    expect(res.statusCode).toBe(200);
  });

  /** `ImportBody.csv`: 2,000,000 characters. */
  it('accepts a cap-table import at the CSV schema’s ceiling', async () => {
    const header = 'holder,class,shares\n';
    const row = 'Holder Name,Common,1000\n';
    const csv = header + row.repeat(Math.ceil((2_000_000 - header.length) / row.length));
    expect(csv.length).toBeGreaterThan(1024 * 1024);
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${valuationId}/cap-table/preview`,
      headers: authHeader(admin.token),
      payload: { format: 'generic', csv: csv.slice(0, 2_000_000) },
    });
    expect(res.statusCode).not.toBe(413);
  });

  /** `CreateBody.body`: 1,000,000 characters. */
  it('accepts a report template at the template schema’s ceiling', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/report-templates',
      headers: authHeader(admin.token),
      payload: { name: 'long-template', kind: '409a', body: 'y'.repeat(1_000_000) },
    });
    expect(res.statusCode).not.toBe(413);
    expect(res.statusCode).toBe(201);
  });

  /**
   * The ceiling was raised on three routes and not on the service. A route that
   * never asked for more must still be bounded by Fastify's default, or this
   * round quietly gave every one of the ~430 others eight megabytes of buffer
   * ahead of its own `preHandler` authentication.
   */
  it('still refuses an over-large body on a route that declared no more', async () => {
    const res = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/valuations/${valuationId}`,
      headers: authHeader(admin.token),
      payload: { company_name: 'z'.repeat(2 * 1024 * 1024) },
    });
    expect(res.statusCode).toBe(413);
  });
});
