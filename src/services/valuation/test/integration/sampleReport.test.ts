import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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

  it('leaks no client data — the outline is template copy only', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/sample-report' });
    const body = res.payload;
    // Template variables are placeholders in the skeleton; none should be
    // filled, because nothing here instantiates a template against a company.
    expect(body).not.toMatch(/\{\{\s*company_name\s*\}\}/);
    expect(res.json().outline.sections.every((s: { blurb: string | null }) => s.blurb !== null)).toBe(true);
  });
});
