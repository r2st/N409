import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanRoutes } from '../support/routeSource.js';

/**
 * Every door a file leaves by, and whether anything recorded it.
 *
 * "The export itself is an auditable act" is what `evidence.ts` has said since
 * it was written, and the platform kept discovering the sentence one route at
 * a time: R215 found that a *published* report served from stored bytes left
 * one event dated the day it was made, however many times it was pulled. R315
 * found three more — the CSV of every account's contact details, the auditor
 * workbook (the whole working model, on a URL the UI never shows), and the
 * client's own uploaded documents, whose arrival, re-filing and deletion were
 * each recorded while the bytes going back out were not.
 *
 * The pattern in all four is the same: a *read* that hands over a copy, next
 * to a write that was audited, in a codebase whose audit spine looks complete
 * because every mutation is on it. So the rule is stated here over the source
 * rather than rediscovered: a route that sets `content-disposition` is handing
 * somebody a file, and it either records that or says in one line why not.
 *
 * The exemptions are the point of the census. A list of five reasons is a
 * decision; a list of fifty would be the same as no rule, which is why the
 * reasons are written per route and not per file.
 */

const routesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../src/routes');

/**
 * 600 rather than the scan's default 250: the evidence bundle's handler is
 * three hundred lines of manifest assembly and its `content-disposition` sits
 * past the default cap — which would drop the one route that named this rule
 * in the first place out of its own census. No registration follows it in the
 * file, and `bodyFrom` stops at the next registration regardless, so the
 * larger cap cannot bleed one handler into another.
 */
const routes = scanRoutes(routesDir, { maxBodyLines: 600 });

/** A route that hands back a file. */
const SERVES_A_FILE = /content-disposition/;
/** The three spellings an audit write reaches this codebase's spine by. */
const RECORDS = /\brecordEvent\(|\brecordAdminEvent\(|\brecordListExport\(|\baudit\(/;

const key = (r: { method: string; url: string }) => `${r.method} ${r.url}`;

/**
 * The doors that deliberately record nothing, each with the reason.
 *
 * Two shapes qualify. Either the file carries nothing the caller was not
 * already served through the same authorization on the same screen (so the row
 * would record a rendering, not a disclosure), or the act is already on a
 * different spine that answers the same question better.
 */
const NO_EVENT: Record<string, string> = {
  'GET /api/v1/valuations/:id/audit-trail.csv':
    'The trail exporting itself. Every row in the file is a row the same caller ' +
    'is already reading on the change-log screen through the same guard, and an ' +
    'event about reading the events is the one entry that grows the thing it ' +
    'describes.',
  'GET /api/v1/valuations/compare':
    'A rendering of the JSON this route returns to the same caller without the ' +
    '?format=csv, over two engagements each loaded through `load(principal, …)`. ' +
    'The file holds no figure the caller cannot open either engagement to see.',
  'GET /api/v1/billing/invoices/:id/pdf':
    "The caller's own invoice. Money movement is audited on the billing spine " +
    '(`billingAuditTrail`), which records the charge, the refund and the ' +
    'dispute — the questions anyone asks of an invoice — and a row per reprint ' +
    'of the document answers none of them.',
  'GET /api/v1/valuations/:id/payments/:paymentId/receipt.pdf':
    'The receipt half of the same reasoning as the invoice above.',
  'GET /api/v1/sample-report/pdf':
    'A fixed marketing artefact built from `sampleEngagements` fixtures. There ' +
    'is no client in it to disclose.',
};

describe('every file-serving route records the export or says why not', () => {
  const serving = routes.filter((r) => SERVES_A_FILE.test(r.body));

  it('finds the file-serving routes at all', () => {
    // Vacuity guard: if the scan or the header spelling changes, this census
    // passes by having nothing left to ask.
    expect(serving.length).toBeGreaterThanOrEqual(10);
    expect(serving.map(key)).toContain('POST /api/v1/valuations/:id/evidence-bundle');
    expect(serving.map(key)).toContain('GET /api/v1/valuations/:id/report.pdf');
  });

  it('records, or holds a written reason', () => {
    const silent = serving.filter((r) => !RECORDS.test(r.body)).map((r) => `${key(r)} (${r.file}:${r.line})`);
    const unexplained = silent.filter((entry) => !NO_EVENT[entry.slice(0, entry.lastIndexOf(' ('))]);
    expect(unexplained).toEqual([]);
  });

  it('keeps the exemption list from going stale', () => {
    // An exemption for a route that now records, or no longer exists, is a
    // reason nobody will re-read — and the next one added under it inherits
    // the appearance of a maintained list.
    const stale = Object.keys(NO_EVENT).filter((k) => {
      const route = serving.find((r) => key(r) === k);
      return !route || RECORDS.test(route.body);
    });
    expect(stale).toEqual([]);
  });

  it('names the doors the source scan cannot see', () => {
    // The partner API registers from `PARTNER_API_ENDPOINTS` via `define()`,
    // so no scan of `app.get(` reaches its report download. It records
    // `report_downloaded` — asserted here by reading the file, because the
    // census above structurally cannot.
    const partnerApi = routes.filter((r) => r.file === 'partnerApi.ts');
    expect(partnerApi.every((r) => !SERVES_A_FILE.test(r.body))).toBe(true);
    const source = readFileSync(path.join(routesDir, 'partnerApi.ts'), 'utf8');
    expect(source).toMatch(/content-disposition/);
    expect(source).toMatch(/type: 'report_downloaded'/);
  });
});
