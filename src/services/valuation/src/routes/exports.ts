import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { problems } from '@n409/shared';
import { valuationScope } from '../auth/rbac.js';
import {
  exportValuations,
  listValuations,
  parseSort,
  type ValuationRow,
} from '../repos/valuations.js';
import { ValuationFilterQuery, toRepoFilters } from './valuations.js';
import { toCsv as recordsToCsv } from '../domain/csv.js';
import { tablePdf, type PdfColumn } from '../export/pdf.js';
import { requirePrincipal } from '../plugins/auth.js';

/**
 * CSV / PDF export of the valuations list (M3 feature 16 + M4 P2). Accepts
 * every filter GET /valuations does (M3 advanced filters + tabs) plus M4's
 * rich sort — export is just another projection of what the caller is
 * already allowed to see.
 */

const ExportQuery = ValuationFilterQuery.extend({
  format: z.enum(['csv', 'pdf']).default('csv'),
  sort: z.string().optional(),
});

const MAX_EXPORT_ROWS = 10_000;

/** CSV: the rich projection (owner/partner/reviewer joined in the repo). */
const CSV_COLUMNS = [
  'id',
  'number',
  'workflow_id',
  'kind',
  'state',
  'company_name',
  'service_name',
  'owner_email',
  'partner_name',
  'source',
  'currency',
  'paid_status',
  'waiting_on_client',
  'reviewer_email',
  'created_at',
  'due_date',
  'published_at',
];

/** PDF: a narrower projection that fits a printable table. */
function pdfRowValues(v: ValuationRow): unknown[] {
  return [
    v.number,
    v.company_name,
    v.kind,
    v.state,
    v.paid_status,
    v.currency,
    v.created_at?.toISOString?.() ?? v.created_at,
    v.due_date instanceof Date ? v.due_date.toISOString().slice(0, 10) : (v.due_date ?? ''),
    v.published_at instanceof Date ? v.published_at.toISOString().slice(0, 10) : (v.published_at ?? ''),
  ];
}

const PDF_COLUMNS: PdfColumn[] = [
  { header: 'No.', width: 45 },
  { header: 'Company', width: 190 },
  { header: 'Kind', width: 55 },
  { header: 'State', width: 110 },
  { header: 'Paid', width: 80 },
  { header: 'Ccy', width: 40 },
  { header: 'Created', width: 90 },
  { header: 'Due', width: 75 },
  { header: 'Published', width: 75 },
];

export function registerExportRoutes(app: FastifyInstance, deps: { pool: pg.Pool }): void {
  app.get('/api/v1/valuations/export', { preHandler: app.authenticate }, async (req, reply) => {
    const principal = requirePrincipal(req);
    const parsed = ExportQuery.safeParse(req.query);
    if (!parsed.success) throw problems.badRequest('Invalid query', { errors: parsed.error.issues });
    const { format } = parsed.data;
    const filters = toRepoFilters(parsed.data);

    const sort = parseSort(parsed.data.sort);
    if (sort === null) throw problems.badRequest('Invalid sort');

    const stamp = new Date().toISOString().slice(0, 10);
    if (format === 'csv') {
      const rows = await exportValuations(
        deps.pool,
        valuationScope(principal),
        filters,
        MAX_EXPORT_ROWS,
      );
      return reply
        .header('content-type', 'text/csv; charset=utf-8')
        .header('content-disposition', `attachment; filename="valuations-${stamp}.csv"`)
        .send(recordsToCsv(CSV_COLUMNS, rows));
    }

    const { items } = await listValuations(deps.pool, valuationScope(principal), {
      ...filters,
      sort,
      page: 1,
      perPage: MAX_EXPORT_ROWS,
    });
    const pdf = tablePdf(
      `Valuations — exported ${stamp}`,
      PDF_COLUMNS,
      items.map((v) => pdfRowValues(v).map((c) => (c === null || c === undefined ? '' : String(c)))),
    );
    return reply
      .header('content-type', 'application/pdf')
      .header('content-disposition', `attachment; filename="valuations-${stamp}.pdf"`)
      .send(pdf);
  });
}
