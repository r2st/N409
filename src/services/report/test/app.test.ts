import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';

describe('report service', () => {
  it('serves health', async () => {
    const app = buildApp();
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json().service).toBe('report');
  });

  it('renders a PDF over HTTP', async () => {
    const app = buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/render/v1/pdf',
      payload: {
        title: 'Valuation Report',
        company_name: 'Acme',
        meta: [{ label: 'Template', value: 'generic.v1' }],
        sections: [{ heading: 'Introduction', html: '<p>Hello <strong>world</strong>.</p>' }],
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('renders a section carrying an out-of-range numeric character reference', async () => {
    // The narrative reaching this service is part LLM-written and part copied
    // out of a client's own documents. `&#99999999;` is a well-formed number,
    // so the decoder's NaN guard passed it to String.fromCodePoint, which threw
    // RangeError — and the throw escaped all the way out as a 500. One stray
    // reference anywhere in any section cost the whole report.
    const app = buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/render/v1/pdf',
      payload: {
        title: 'Valuation Report',
        company_name: 'Acme',
        sections: [{ heading: 'Conclusion', html: '<p>Valued at &#99999999; per share &#x110000;.</p>' }],
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('rejects an invalid render request with 422 problem+json', async () => {
    const app = buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/render/v1/pdf',
      payload: { title: '', company_name: 'Acme', sections: [] },
    });
    expect(res.statusCode).toBe(422);
    expect(res.headers['content-type']).toContain('application/problem+json');
  });

  /*
   * The refusal names the field, in `detail`.
   *
   * Nobody using the product ever sees a 422 from this service: the caller
   * falls back to rendering the same bytes in its own process and answers 200
   * (`clients/reportRender.ts`). The reader is the operator holding the warn
   * line that fallback writes, whose `detail` is this string — and until R357
   * it was `Invalid render request`, which does not say which of `RenderBody`'s
   * caps the payload outgrew. "Is the offload still happening" is the only
   * question a report-scale change has to answer, and this is the sentence
   * that answers it.
   */
  it('names the offending field in the 422 detail, not only in the extension', async () => {
    const app = buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/render/v1/pdf',
      payload: { title: '', company_name: 'Acme', sections: [] },
    });
    expect(res.statusCode).toBe(422);
    const body = res.json();
    expect(body.detail).toContain('Invalid render request');
    expect(body.detail).toMatch(/title/);
    // The extension is unchanged — a machine reading `path` should not have to
    // parse the prose that was added beside it.
    expect(Array.isArray(body.errors)).toBe(true);
    expect(body.errors.some((issue: { path: unknown[] }) => issue.path[0] === 'title')).toBe(true);
  });

  it('names the cap a too-large payload outgrew', async () => {
    // The realistic 422 on this wire is not a malformed body but a report that
    // grew past a cap: `sections` at 100. An operator reading `Invalid render
    // request` cannot tell that from a drifted schema field.
    const app = buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/render/v1/pdf',
      payload: {
        title: 'Valuation Report',
        company_name: 'Acme',
        sections: Array.from({ length: 101 }, (_, i) => ({ heading: `S${i}`, html: '<p>x</p>' })),
      },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().detail).toMatch(/^Invalid render request — sections: /);
  });

  it('counts the issues it did not name rather than printing all of them', async () => {
    // Bounded at three named fields plus a count — `validationDetail`'s rule,
    // asserted here because this service is the one that can produce a long
    // issue list from a single bad body.
    const app = buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/render/v1/pdf',
      payload: { title: 42, company_name: 42, sections: 42, include_toc: 'yes', watermark: 42 },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().detail).toMatch(/\(and \d+ more problems?\)$/);
  });

  it('accepts the contents-page and confidentiality options', async () => {
    const app = buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/render/v1/pdf',
      payload: {
        title: 'Valuation Report',
        company_name: 'Acme',
        sections: [{ heading: 'Introduction', html: '<p>Hello.</p>' }],
        include_toc: true,
        confidentiality: null,
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('rejects a non-boolean include_toc', async () => {
    const app = buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/render/v1/pdf',
      payload: {
        title: 'Valuation Report',
        company_name: 'Acme',
        sections: [{ heading: 'Introduction', html: '<p>Hello.</p>' }],
        include_toc: 'yes',
      },
    });
    expect(res.statusCode).toBe(422);
  });

  // ── Internal shared-secret gate ──────────────────────────────────────────
  //
  // This service renders an 8 MB body's worth of PDF for anyone who can reach
  // it, and until now that was everyone who could reach the port — loopback
  // binding and a firewall rule were the whole defence, while the AI and
  // engine services next to it have required `X-Internal-Token` since audit
  // B-1 P0. These pin the parity.
  describe('internal service token', () => {
    const SECRET = 'r'.repeat(64);
    const RENDER = {
      title: 'Valuation Report',
      company_name: 'Acme',
      sections: [{ heading: 'Introduction', html: '<p>Hello.</p>' }],
    };

    afterEach(() => {
      delete process.env.INTERNAL_SERVICE_TOKEN;
    });

    it('renders without a token when none is configured (local dev)', async () => {
      delete process.env.INTERNAL_SERVICE_TOKEN;
      const app = buildApp();
      const res = await app.inject({ method: 'POST', url: '/render/v1/pdf', payload: RENDER });
      expect(res.statusCode).toBe(200);
    });

    it('refuses an unauthenticated render once a token is configured', async () => {
      process.env.INTERNAL_SERVICE_TOKEN = SECRET;
      const app = buildApp();
      const res = await app.inject({ method: 'POST', url: '/render/v1/pdf', payload: RENDER });
      expect(res.statusCode).toBe(401);
    });

    it('refuses a wrong token', async () => {
      process.env.INTERNAL_SERVICE_TOKEN = SECRET;
      const app = buildApp();
      const res = await app.inject({
        method: 'POST',
        url: '/render/v1/pdf',
        headers: { 'x-internal-token': 's'.repeat(64) },
        payload: RENDER,
      });
      expect(res.statusCode).toBe(401);
    });

    it('renders for the caller that presents the token', async () => {
      process.env.INTERNAL_SERVICE_TOKEN = SECRET;
      const app = buildApp();
      const res = await app.inject({
        method: 'POST',
        url: '/render/v1/pdf',
        headers: { 'x-internal-token': SECRET },
        payload: RENDER,
      });
      expect(res.statusCode).toBe(200);
      expect(res.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');
    });

    it('keeps /health and /ready reachable so the supervisor never needs the secret', async () => {
      process.env.INTERNAL_SERVICE_TOKEN = SECRET;
      const app = buildApp();
      for (const url of ['/', '/health', '/ready']) {
        expect((await app.inject({ method: 'GET', url })).statusCode, url).toBe(200);
      }
    });
  });
});
