import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { problems } from '@n409/shared';
import { valuationScope } from '../auth/rbac.js';
import { VALUATION_KINDS, VALUATION_STATES } from '../domain/valuation.js';
import { listValuations, parseSort, type ValuationRow } from '../repos/valuations.js';
import { toCsv } from '../export/csv.js';
import { tablePdf, type PdfColumn } from '../export/pdf.js';
import { requirePrincipal } from '../plugins/auth.js';

/**
 * CSV / PDF export of the valuations list (M4, P2). Same filters, sort, and
 * scope enforcement as GET /valuations — export is just another projection
 * of what the caller is already allowed to see.
 */

const ExportQuery = z.object({
  format: z.enum(['csv', 'pdf']),
  state: z.enum(VALUATION_STATES).optional(),
  kind: z.enum(VALUATION_KINDS).optional(),
  sort: z.string().optional(),
});

const MAX_EXPORT_ROWS = 10_000;

const HEADERS = [
  'number',
  'company',
  'kind',
  'state',
  'paid_status',
  'currency',
  'created_at',
  'due_date',
  'published_at',
];

function rowValues(v: ValuationRow): unknown[] {
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
    const { format, state, kind } = parsed.data;

    const sort = parseSort(parsed.data.sort);
    if (sort === null) throw problems.badRequest('Invalid sort');

    const { items } = await listValuations(deps.pool, valuationScope(principal), {
      state,
      kind,
      sort,
      page: 1,
      perPage: MAX_EXPORT_ROWS,
    });

    const stamp = new Date().toISOString().slice(0, 10);
    if (format === 'csv') {
      const csv = toCsv(
        HEADERS,
        items.map((v) => rowValues(v)),
      );
      return reply
        .header('content-type', 'text/csv; charset=utf-8')
        .header('content-disposition', `attachment; filename="valuations-${stamp}.csv"`)
        .send(csv);
    }

    const pdf = tablePdf(
      `Valuations — exported ${stamp}`,
      PDF_COLUMNS,
      items.map((v) => rowValues(v).map((c) => (c === null || c === undefined ? '' : String(c)))),
    );
    return reply
      .header('content-type', 'application/pdf')
      .header('content-disposition', `attachment; filename="valuations-${stamp}.pdf"`)
      .send(pdf);
  });
}
