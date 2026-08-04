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
