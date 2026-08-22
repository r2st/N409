import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildApp, RenderBody } from '../src/app.js';
import { extractText } from './support/pdfText.js';

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * The HTTP contract against the library it wraps.
 *
 * This service exists so a PDF render can happen somewhere other than the
 * process serving the API. Nothing in this repository crosses that boundary —
 * the valuation service imports `@n409/report/pdf` and renders in-process — so
 * a field added to `ReportPdfInput` and not to `RenderBody` breaks no test and
 * no caller here. It breaks whoever first uses the service the way the
 * deployment document describes it, and it breaks them silently: zod strips
 * what it was not told about, so the render succeeds and the field is simply
 * not in the document.
 *
 * Two had drifted. `branding` had been absent since white-labelling shipped, so
 * a partner's report would have come back in the platform's own livery. And
 * `watermark` — the diagonal DRAFT stamp added in R92 precisely because an
 * unmarked draft is forwarded to auditors and filed in data rooms as final —
 * would have been dropped, handing back bytes indistinguishable from the signed
 * deliverable. A draft and a final differing by the *absence* of a page element
 * differ in the way a reader is least likely to notice.
 *
 * The census is a source scan of the interface rather than a list, so the next
 * field is caught the day it is added rather than the day somebody needs it.
 */
function libraryFields(): string[] {
  const src = readFileSync(path.join(here, '../src/pdf.ts'), 'utf8');
  const start = src.indexOf('export interface ReportPdfInput {');
  expect(start, 'ReportPdfInput moved or was renamed').toBeGreaterThan(-1);
  const body = src.slice(start, src.indexOf('\n}', start));
  // Top-level members only: `  name?: type` at one indent, comments skipped.
  return [...body.matchAll(/^ {2}([a-z_][a-z0-9_]*)\??:/gm)].map((m) => m[1]!);
}

describe('POST /render/v1/pdf accepts everything the library renders', () => {
  it('names every field of ReportPdfInput', () => {
    const wire = new Set(Object.keys(RenderBody.shape));
    const missing = libraryFields().filter((f) => !wire.has(f));
    expect(missing, 'ReportPdfInput fields the HTTP contract would silently strip').toEqual([]);
  });

  it('finds the fields it is supposed to be checking', () => {
    // A scan that quietly stops matching would pass the test above by having
    // nothing to compare. Three of the fields it must always see.
    const fields = libraryFields();
    expect(fields).toContain('sections');
    expect(fields).toContain('watermark');
    expect(fields).toContain('branding');
    expect(fields.length).toBeGreaterThan(8);
  });

  it('stamps a draft asked for over HTTP', async () => {
    const app = buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/render/v1/pdf',
      payload: {
        title: 'Valuation Report',
        company_name: 'Acme',
        meta: [],
        sections: [{ heading: 'Introduction', html: '<p>Body.</p>' }],
        watermark: 'Draft',
      },
    });
    expect(res.statusCode).toBe(200);
    // The cover notice names the marker in upper case; the stamp itself is
    // drawn on every page. Either would do — the point is that the field
    // reached the renderer instead of being stripped by the schema.
    expect(extractText(res.rawPayload)).toContain('DRAFT');
  });

  it('renders the partner name from a branding block sent as base64', async () => {
    const app = buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/render/v1/pdf',
      payload: {
        title: 'Valuation Report',
        company_name: 'Acme',
        meta: [],
        sections: [{ heading: 'Introduction', html: '<p>Body.</p>' }],
        // No logo: a Buffer cannot cross JSON, and the wire field that carries
        // one is the single place this contract's spelling differs.
        branding: { partner_name: 'Northgate Advisors', brand_color: '#123456' },
      },
    });
    expect(res.statusCode).toBe(200);
    expect(extractText(res.rawPayload)).toContain('Northgate Advisors');
  });

  it('refuses a brand colour that is not #rrggbb', async () => {
    const app = buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/render/v1/pdf',
      payload: {
        title: 'T',
        company_name: 'Acme',
        meta: [],
        sections: [{ heading: 'H', html: '<p>x</p>' }],
        branding: { partner_name: 'P', brand_color: 'red' },
      },
    });
    expect(res.statusCode).toBe(422);
  });
});
