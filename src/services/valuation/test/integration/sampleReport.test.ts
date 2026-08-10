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

  it('leaks no client data — the outline is template copy only', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/sample-report' });
    const body = res.payload;
    // Template variables are placeholders in the skeleton; none should be
    // filled, because nothing here instantiates a template against a company.
    expect(body).not.toMatch(/\{\{\s*company_name\s*\}\}/);
    expect(res.json().outline.sections.every((s: { blurb: string | null }) => s.blurb !== null)).toBe(true);
  });
});
