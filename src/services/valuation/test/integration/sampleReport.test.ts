import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FixedWindowRateLimiter } from '../../src/plugins/rateLimit.js';
import { costOfRequest } from '../../src/domain/requestCost.js';
import { isDbAvailable, setupTestApp, type TestApp } from './helpers.js';

const dbUp = await isDbAvailable();

describe.skipIf(!dbUp)('public sample report outline', () => {
  let ctx: TestApp;

  beforeAll(async () => {
    ctx = await setupTestApp();
  });

  afterAll(async () => {
    await ctx?.teardown();
  });

  it('serves the 409A outline anonymously', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/sample-report' });
    expect(res.statusCode).toBe(200);
    const { outline, kinds } = res.json();
    expect(outline.kind).toBe('409a');
    expect(outline.version).toMatch(/^409a\.v\d+$/);
    expect(outline.sections.length).toBeGreaterThan(20);
    expect(outline.sections.map((s: { key: string }) => s.key)).toContain('dlom');
    expect(outline.exhibits.length).toBeGreaterThan(0);
    expect(kinds).toContain('409a');
  });

  it('honours the kind parameter and rejects an unknown one', async () => {
    const ok = await ctx.app.inject({ method: 'GET', url: '/api/v1/sample-report?kind=emi' });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().outline.kind).toBe('emi');
    // A specialty kind renders its own schedules, not the 409A exhibits.
    expect(ok.json().outline.exhibits).toEqual([]);

    const bad = await ctx.app.inject({ method: 'GET', url: '/api/v1/sample-report?kind=nonsense' });
    expect(bad.statusCode).toBe(400);
  });

  it('serves the worked example and the availability of the PDF alongside it', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/sample-report' });
    const { figures, pdf, notice } = res.json();
    expect(pdf).toEqual({ available: true });
    expect(notice).toMatch(/not a valuation opinion/i);
    expect(figures.map((f: { label: string }) => f.label)).toContain('FMV / share');

    // A specialty kind has no rendered sample, and has to say so rather than
    // offering a download that 400s.
    const emi = await ctx.app.inject({ method: 'GET', url: '/api/v1/sample-report?kind=emi' });
    expect(emi.json().pdf).toEqual({ available: false });
  });

  it('renders the sample PDF to anyone, as an attachment', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/sample-report/pdf' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/pdf/);
    expect(res.headers['content-disposition']).toMatch(/attachment; filename="n409-sample-409a-report\.pdf"/);
    expect(res.headers['cache-control']).toMatch(/max-age=\d+/);
    expect(res.rawPayload.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(res.rawPayload.length).toBeGreaterThan(20_000);
  }, 60_000);

  it('refuses a kind it publishes no sample for, rather than rendering an empty one', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/sample-report/pdf?kind=emi' });
    expect(res.statusCode).toBe(400);
    expect(res.json().detail ?? res.json().title).toMatch(/no sample is published/i);
  });

  it('is byte-identical across requests, so the download can be cached', async () => {
    const [a, b] = await Promise.all([
      ctx.app.inject({ method: 'GET', url: '/api/v1/sample-report/pdf' }),
      ctx.app.inject({ method: 'GET', url: '/api/v1/sample-report/pdf' }),
    ]);
    expect(a.rawPayload.equals(b.rawPayload)).toBe(true);
  }, 60_000);

  /**
   * The render is the only unauthenticated route on this service that costs
   * real CPU, and neither half of the authenticated budget reaches it: the cost
   * table charges `/\.pdf$/` and this path ends `/pdf`, and the cost limiter
   * keys on a principal this caller does not have. Asserted here so that a
   * later edit to either cannot quietly become the route's only protection
   * again — if someone adds a cost rule for it, this test says out loud that
   * doing so is not what is guarding the route.
   */
  it('is not covered by the authenticated cost budget, which is why it has its own limiter', () => {
    expect(costOfRequest('GET', '/api/v1/sample-report/pdf')).toBe(0);
    // The engagement's own report, for contrast, is charged.
    expect(costOfRequest('GET', '/api/v1/valuations/abc/report.pdf')).toBeGreaterThan(0);
  });

  it('leaks no client data — the outline is template copy only', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/sample-report' });
    const body = res.payload;
    // Template variables are placeholders in the skeleton; none should be
    // filled, because nothing here instantiates a template against a company.
    expect(body).not.toMatch(/\{\{\s*company_name\s*\}\}/);
    expect(res.json().outline.sections.every((s: { blurb: string | null }) => s.blurb !== null)).toBe(true);
  });
});

describe.skipIf(!dbUp)('public sample report render throttle', () => {
  let ctx: TestApp;

  beforeAll(async () => {
    // A budget of one, so a refusal is reached without rendering the document
    // ten times over — the render is the expensive thing this guards, and
    // spending it to prove the guard works would make the suite pay exactly the
    // cost the guard exists to avoid.
    ctx = await setupTestApp({}, { sampleReportPdfLimiter: new FixedWindowRateLimiter(1, 60_000) });
  });

  afterAll(async () => {
    await ctx?.teardown();
  });

  /**
   * The limiter keys on the client address, so each test below claims its own
   * and starts with a full budget. Sharing one address across tests would make
   * them order-dependent: the first to run would spend the budget and every
   * later one would see a 429 it did not ask for.
   *
   * X-Forwarded-For is how the address arrives — this service always sits
   * behind the web BFF, so its socket peer is loopback on every request. See
   * clientIpIsolation.test.ts.
   */
  const renderFrom = (ip: string, query = '') =>
    ctx.app.inject({
      method: 'GET',
      url: `/api/v1/sample-report/pdf${query}`,
      headers: { 'x-forwarded-for': ip },
    });

  it('refuses a further render once the per-IP budget is spent', async () => {
    const ip = '198.51.100.21';
    const first = await renderFrom(ip);
    expect(first.statusCode).toBe(200);
    expect(first.rawPayload.subarray(0, 5).toString('latin1')).toBe('%PDF-');

    const second = await renderFrom(ip);
    expect(second.statusCode).toBe(429);
    // A caller told to back off has to be told for how long, in both the header
    // a client library reads and the body a human does.
    expect(Number(second.headers['retry-after'])).toBeGreaterThan(0);
    expect(second.json().retry_after_seconds).toBeGreaterThan(0);
  }, 60_000);

  it('does not let one address spend another address budget', async () => {
    const noisy = '198.51.100.22';
    expect((await renderFrom(noisy)).statusCode).toBe(200);
    expect((await renderFrom(noisy)).statusCode).toBe(429);

    // The whole point of keying on the caller: a prospect downloading the
    // sample must not be refused because someone else already did.
    expect((await renderFrom('203.0.113.88')).statusCode).toBe(200);
  }, 60_000);

  it('spends the budget before parsing the kind, so a malformed flood is throttled too', async () => {
    const ip = '198.51.100.23';
    // `kind=emi` is refused on its merits — no sample is published for it — but
    // the refusal must still cost the caller. Otherwise the cheapest way to keep
    // the route busy is to ask it for something it will decline.
    expect((await renderFrom(ip, '?kind=emi')).statusCode).toBe(400);
    expect((await renderFrom(ip)).statusCode).toBe(429);
  }, 60_000);

  it('leaves the outline readable when the render budget is spent', async () => {
    const ip = '198.51.100.24';
    await renderFrom(ip);
    expect((await renderFrom(ip)).statusCode).toBe(429);

    // Only the render is limited. The outline is pure computation over the
    // templates, and the marketing page it backs should not go dark because
    // someone on the same NAT already downloaded the PDF.
    const outline = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/sample-report',
      headers: { 'x-forwarded-for': ip },
    });
    expect(outline.statusCode).toBe(200);
    expect(outline.json().outline.kind).toBe('409a');
  }, 60_000);
});
