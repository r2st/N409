import { describe, expect, it } from 'vitest';
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
});
