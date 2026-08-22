import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MetricsRegistry } from '@n409/shared';
import { buildApp as buildReportApp, RenderBody } from '@n409/report';
import { renderReportPdf as renderLocally, type ReportPdfInput } from '@n409/report/pdf';
import {
  configureReportRenderer,
  registerReportRenderMetrics,
  renderReportPdf,
  reportRenderPayload,
  reportServiceUrl,
  resetReportRenderMetrics,
} from '../../src/clients/reportRender.js';
import { circuits } from '../../src/clients/internal.js';
import { sampleReportPdfInput } from '../../src/domain/sampleReportPdf.js';
import { extractText } from '../../../report/test/support/pdfText.js';

/**
 * PDF rendering delegated to the report service.
 *
 * Two properties are being defended here and they pull in opposite directions,
 * which is why the suite is as long as it is.
 *
 * **The offload has to actually happen.** Not "the code path exists" — the real
 * report the platform ships has to survive the wire contract, which has caps
 * and shapes the library it wraps does not (`sections` max 100, 200k of HTML
 * apiece, `logo` as base64 rather than a Buffer). A payload the schema refuses
 * is a 422, and a 422 falls back, and a fallback is invisible: correct bytes,
 * correct route, and the half-second of blocked event loop quietly back. So the
 * round trip below runs the genuine `sampleReportPdfInput` through the genuine
 * `buildApp()` of the report service and compares the result with the local
 * render, rather than testing a hand-written payload against a mock.
 *
 * **And it must never be load-bearing.** Every way the hop can fail gets a case
 * that ends in a valid PDF. A 409A report is the deliverable; the day this file
 * makes it depend on a second process is the day this was a bad trade.
 */

/** Routes `fetch` into a report service instance via Fastify's inject. */
function injectingFetch(app: ReturnType<typeof buildReportApp>): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    const res = await app.inject({
      method: 'POST',
      url: new URL(String(url)).pathname,
      headers: { 'content-type': 'application/json' },
      payload: init?.body as string,
    });
    return new Response(res.rawPayload, {
      status: res.statusCode,
      headers: { 'content-type': res.headers['content-type'] as string },
    });
  }) as unknown as typeof fetch;
}

/**
 * How `fetch` actually reports a refused connection: a bare `TypeError: fetch
 * failed` with the syscall on `cause`. Written out rather than faked as a
 * plain `Error`, because the distinction is load-bearing — `classifyFailure`
 * reads the code off the cause, and an error without one is classified
 * permanent and never opens the breaker.
 */
function connectionRefused(): Error {
  return new TypeError('fetch failed', {
    cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:3004'), { code: 'ECONNREFUSED' }),
  });
}

/** A fetch that fails the way `err` says, before any bytes are sent. */
function failingFetch(err: Error): typeof fetch {
  return (async () => {
    throw err;
  }) as unknown as typeof fetch;
}

function timeoutError(): Error {
  const err = new Error('The operation was aborted due to timeout');
  err.name = 'TimeoutError';
  return err;
}

/** A fetch that answers, with whatever status and bytes are asked for. */
function answeringFetch(status: number, body: string | Buffer): typeof fetch {
  return (async () =>
    new Response(typeof body === 'string' ? body : new Uint8Array(body), {
      status,
    })) as unknown as typeof fetch;
}

const REPORT = 'http://report.internal:3004';

/** Counter samples for `report_render_total`, as `{mode:reason} → count`. */
function renderCounts(registry: MetricsRegistry): Record<string, number> {
  const out: Record<string, number> = {};
  for (const line of registry.render().split('\n')) {
    const m = /^report_render_total\{mode="([a-z]+)",reason="([a-z_]+)"\} (\d+)/.exec(line);
    if (m) out[`${m[1]}:${m[2]}`] = Number(m[3]);
  }
  return out;
}

let registry: MetricsRegistry;

beforeEach(() => {
  configureReportRenderer(null);
  resetReportRenderMetrics();
  registry = new MetricsRegistry();
  registerReportRenderMetrics(registry);
  // The breaker registry is module-level and shared with the AI/engine clients,
  // so a suite that leaves the report breaker open half-fails the next one.
  circuits.resetAll();
});

afterEach(() => {
  configureReportRenderer(null);
  resetReportRenderMetrics();
  circuits.resetAll();
});

describe('the wire contract accepts the reports this platform actually renders', () => {
  it('accepts the published sample, exhibits and charts included', () => {
    const input = sampleReportPdfInput('409a');
    // Not a token document: this is the one the marketing page serves, and it
    // is the largest render in the repository that does not need a database.
    expect(input.sections.length).toBeGreaterThan(20);
    const parsed = RenderBody.safeParse(reportRenderPayload(input));
    expect(parsed.success ? [] : parsed.error.issues).toEqual([]);
  });

  it('accepts a white-labelled, watermarked render — the two fields that do not cross unattended', () => {
    const input: ReportPdfInput = {
      ...sampleReportPdfInput('409a'),
      branding: {
        partner_name: 'Northgate Advisors',
        brand_color: '#123456',
        // A Buffer. `JSON.stringify` would make this `{"type":"Buffer",...}`,
        // which the schema refuses — the conversion is the thing under test.
        logo: Buffer.from('89504e470d0a1a0a', 'hex'),
      },
      watermark: 'Draft',
    };
    const payload = reportRenderPayload(input);
    const branding = payload.branding as Record<string, unknown>;
    expect(branding.logo_base64).toBe(Buffer.from('89504e470d0a1a0a', 'hex').toString('base64'));
    expect(branding).not.toHaveProperty('logo');
    expect(RenderBody.safeParse(payload).success).toBe(true);
  });

  it('drops `schedules`, which the renderer ignores and the wire has no field for', () => {
    const payload = reportRenderPayload({
      title: 'T',
      company_name: 'Acme',
      meta: [],
      sections: [{ heading: 'H', html: '<p>x</p>', schedules: ['dlom-derivation'] }],
    });
    expect((payload.sections as Array<Record<string, unknown>>)[0]).not.toHaveProperty('schedules');
    expect(RenderBody.safeParse(payload).success).toBe(true);
  });

  it('carries `generated_at` as a date the schema coerces back', () => {
    const at = new Date('2026-03-04T05:06:07.000Z');
    const parsed = RenderBody.parse(
      JSON.parse(
        JSON.stringify(
          reportRenderPayload({
            title: 'T',
            company_name: 'Acme',
            meta: [],
            sections: [{ heading: 'H', html: '<p>x</p>' }],
            generated_at: at,
          }),
        ),
      ),
    );
    expect(parsed.generated_at?.toISOString()).toBe(at.toISOString());
  });
});

describe('a delegated render produces the document the local renderer would have', () => {
  it('round-trips the sample through a real report service', async () => {
    const reportApp = buildReportApp();
    await reportApp.ready();
    try {
      configureReportRenderer(REPORT);
      const input = sampleReportPdfInput('409a');
      const delegated = await renderReportPdf(input, { fetchFn: injectingFetch(reportApp) });
      const local = await renderLocally(input);
      // Byte-for-byte. The sample is deterministic by construction (it is
      // cached for an hour on a public route), the renderer is the same code on
      // both sides, and equality is the only assertion that would catch a field
      // the wire schema silently strips — which is exactly how `watermark` and
      // `branding` went missing for four rounds.
      expect(delegated.equals(local)).toBe(true);
      expect(extractText(delegated)).toContain('Northwind');
      expect(renderCounts(registry)).toEqual({ 'delegated:ok': 1 });
    } finally {
      await reportApp.close();
    }
  });

  it('keeps the draft stamp, which a stripped field would have removed silently', async () => {
    const reportApp = buildReportApp();
    await reportApp.ready();
    try {
      configureReportRenderer(REPORT);
      const pdf = await renderReportPdf(
        { ...sampleReportPdfInput('409a'), watermark: 'Draft' },
        { fetchFn: injectingFetch(reportApp) },
      );
      expect(extractText(pdf)).toContain('DRAFT');
    } finally {
      await reportApp.close();
    }
  });
});

describe('every way the hop can fail still produces the deliverable', () => {
  const cases: Array<[string, () => typeof fetch, string]> = [
    ['a refused connection', () => failingFetch(connectionRefused()), 'local:unreachable'],
    ['our own deadline', () => failingFetch(timeoutError()), 'local:timeout'],
    ['a rejected payload', () => answeringFetch(422, '{"detail":"too many sections"}'), 'local:rejected'],
    ['an unwell service', () => answeringFetch(500, 'boom'), 'local:rejected'],
    [
      // A proxy interstitial, a JSON envelope, an empty 200 — all arrive as a
      // Buffer of the right type and the wrong content, and the first reader to
      // find out is a client whose report will not open.
      'a 200 that is not a PDF',
      () => answeringFetch(200, '<html>service unavailable</html>'),
      'local:not_a_pdf',
    ],
  ];

  for (const [name, fetchFn, expected] of cases) {
    it(`falls back on ${name}`, async () => {
      configureReportRenderer(REPORT);
      const pdf = await renderReportPdf(sampleReportPdfInput('409a'), { fetchFn: fetchFn() });
      expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
      expect(renderCounts(registry)).toEqual({ [expected]: 1 });
    });
  }

  it('renders locally when no report service is configured', async () => {
    const pdf = await renderReportPdf(sampleReportPdfInput('409a'));
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(renderCounts(registry)).toEqual({ 'local:not_configured': 1 });
  });

  it('treats an empty REPORT_URL as the off switch', async () => {
    configureReportRenderer('');
    expect(reportServiceUrl()).toBeNull();
    await renderReportPdf(sampleReportPdfInput('409a'));
    expect(renderCounts(registry)).toEqual({ 'local:not_configured': 1 });
  });

  it('stops dialling a service that keeps failing, and still renders', async () => {
    configureReportRenderer(REPORT);
    let dialled = 0;
    const fetchFn = (async () => {
      dialled += 1;
      throw connectionRefused();
    }) as unknown as typeof fetch;
    for (let i = 0; i < 8; i++) {
      const pdf = await renderReportPdf(
        { title: 'T', company_name: 'Acme', meta: [], sections: [{ heading: 'H', html: '<p>x</p>' }] },
        { fetchFn },
      );
      expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    }
    // Five failures open the breaker (see `circuits` in internal.ts); the
    // remaining three renders skip the socket entirely. Without this, a report
    // unit that is down would add a connection attempt to every render forever.
    expect(dialled).toBe(5);
    expect(renderCounts(registry)).toEqual({ 'local:unreachable': 5, 'local:circuit_open': 3 });
  });

  it('renders locally when the caller asked for options the wire cannot carry', async () => {
    configureReportRenderer(REPORT);
    // `compress: false` is how the test suites read text out of a document.
    // Delegating it would answer a compressed stream to a caller who asked for
    // the opposite, which is a silently wrong answer rather than a slow one.
    const pdf = await renderReportPdf(
      { title: 'T', company_name: 'Acme', meta: [], sections: [{ heading: 'H', html: '<p>x</p>' }] },
      { options: { compress: false }, fetchFn: failingFetch(new Error('must not be dialled')) },
    );
    expect(extractText(pdf)).toContain('Acme');
    expect(renderCounts(registry)).toEqual({ 'local:render_options': 1 });
  });
});

describe('the fallback is visible', () => {
  it('reports where renders happened, so a permanent fallback is not silent', async () => {
    configureReportRenderer(REPORT);
    await renderReportPdf(
      { title: 'T', company_name: 'Acme', meta: [], sections: [{ heading: 'H', html: '<p>x</p>' }] },
      { fetchFn: failingFetch(connectionRefused()) },
    );
    const text = registry.render();
    expect(text).toContain('report_render_total{mode="local",reason="unreachable"} 1');
    expect(text).toContain('report_render_duration_seconds_count{mode="local"} 1');
  });

  it('logs the reason once per fallback, at warn', async () => {
    configureReportRenderer(REPORT);
    const warns: Array<Record<string, unknown>> = [];
    await renderReportPdf(
      { title: 'T', company_name: 'Acme', meta: [], sections: [{ heading: 'H', html: '<p>x</p>' }] },
      {
        fetchFn: answeringFetch(422, '{"detail":"sections: array must contain at most 100"}'),
        log: { warn: (obj) => warns.push(obj), debug: () => {} },
      },
    );
    expect(warns).toHaveLength(1);
    expect(warns[0]).toMatchObject({ service: 'report', reason: 'rejected', status: 422 });
    // The upstream's own words: a 422 here is a contract drift somebody has to
    // read a field list to fix, and the field list is in the body.
    expect(String(warns[0]!.detail)).toContain('at most 100');
  });
});
