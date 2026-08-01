import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { isUlid, problems } from '@n409/shared';
import { canReadValuation, valuationScope } from '../auth/rbac.js';
import {
  exportValuations,
  findValuationById,
  listValuations,
  parseSort,
  type ValuationRow,
} from '../repos/valuations.js';
import { ValuationFilterQuery, toRepoFilters } from './valuations.js';
import { toCsv as recordsToCsv } from '../domain/csv.js';
import { tablePdf, type PdfColumn } from '../export/pdf.js';
import { buildXlsx, XLSX_CONTENT_TYPE, type XlsxColumn, type XlsxValue } from '../export/xlsx.js';
import { valuationWorkbookSheets } from '../export/valuationWorkbook.js';
import { findCapTable } from '../repos/capTables.js';
import { listGrants } from '../repos/grants.js';
import { listWorkbookCells } from '../repos/workbook.js';
import { latestSucceededCalculation } from '../repos/calculations.js';
import { listOverwrites } from '../repos/overwrites.js';
import { requirePrincipal } from '../plugins/auth.js';

/**
 * CSV / PDF / XLSX export of the valuations list (M3 feature 16 + M4 P2), plus
 * the per-valuation auditor workbook. Accepts every filter GET /valuations does
 * (M3 advanced filters + tabs) plus M4's rich sort — export is just another
 * projection of what the caller is already allowed to see.
 *
 * XLSX exists because CSV loses types and PDF loses arithmetic: auditors asked
 * for a workbook they can foot and tie, which needs real numbers and real
 * formulas (feature-improvements §4).
 */

const ExportQuery = ValuationFilterQuery.extend({
  format: z.enum(['csv', 'pdf', 'xlsx']).default('csv'),
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

/**
 * XLSX: the CSV projection, but typed — dates become real dates and counts
 * become real numbers, so the sheet is sortable and summable on arrival.
 */
const XLSX_LIST_COLUMNS: Array<XlsxColumn & { key: string }> = [
  { key: 'number', header: 'Number', width: 14, format: 'text' },
  { key: 'company_name', header: 'Company', width: 30, format: 'text' },
  { key: 'kind', header: 'Kind', width: 12, format: 'text' },
  { key: 'state', header: 'State', width: 22, format: 'text' },
  { key: 'service_name', header: 'Service', width: 22, format: 'text' },
  { key: 'owner_email', header: 'Owner', width: 26, format: 'text' },
  { key: 'partner_name', header: 'Partner', width: 22, format: 'text' },
  { key: 'reviewer_email', header: 'Reviewer', width: 26, format: 'text' },
  { key: 'source', header: 'Source', width: 14, format: 'text' },
  { key: 'currency', header: 'Currency', width: 10, format: 'text' },
  { key: 'paid_status', header: 'Paid', width: 14, format: 'text' },
  { key: 'waiting_on_client', header: 'Waiting on client', width: 17, format: 'text' },
  { key: 'created_at', header: 'Created', width: 13, format: 'date' },
  { key: 'due_date', header: 'Due', width: 13, format: 'date' },
  { key: 'published_at', header: 'Published', width: 13, format: 'date' },
  { key: 'id', header: 'ID', width: 28, format: 'text' },
];

/**
 * Dates arrive from pg as Date objects but from the JSON path as strings, and a
 * date written as a string sorts lexically rather than chronologically — which
 * is exactly the bug this export exists to avoid.
 */
function xlsxCell(value: unknown, format: XlsxColumn['format']): XlsxValue {
  if (value === null || value === undefined) return null;
  if (format === 'date') {
    const d = value instanceof Date ? value : new Date(String(value));
    return Number.isNaN(d.getTime()) ? String(value) : d;
  }
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  if (typeof value === 'number' || typeof value === 'string') return value;
  if (Array.isArray(value)) return value.join('; ');
  return String(value);
}

export function registerExportRoutes(app: FastifyInstance, deps: { pool: pg.Pool }): void {
  app.get('/api/v1/valuations/export', { preHandler: app.authenticate }, async (req, reply) => {
    const principal = requirePrincipal(req);
    const parsed = ExportQuery.safeParse(req.query);
    if (!parsed.success) throw problems.badRequest('Invalid query', { errors: parsed.error.issues });
    const { format } = parsed.data;
    const filters = toRepoFilters(parsed.data);

    const sort = parseSort(parsed.data.sort);
    if (sort === null) throw problems.badRequest('Invalid sort');

    const generatedAt = new Date();
    const stamp = generatedAt.toISOString().slice(0, 10);
    if (format === 'csv' || format === 'xlsx') {
      const rows = await exportValuations(deps.pool, valuationScope(principal), filters, MAX_EXPORT_ROWS);
      if (format === 'csv') {
        return reply
          .header('content-type', 'text/csv; charset=utf-8')
          .header('content-disposition', `attachment; filename="valuations-${stamp}.csv"`)
          .send(recordsToCsv(CSV_COLUMNS, rows));
      }
      const xlsx = buildXlsx(
        [
          {
            name: 'Valuations',
            columns: XLSX_LIST_COLUMNS,
            rows: rows.map((row) => XLSX_LIST_COLUMNS.map((c) => xlsxCell(row[c.key], c.format))),
          },
        ],
        { mtime: generatedAt },
      );
      return reply
        .header('content-type', XLSX_CONTENT_TYPE)
        .header('content-disposition', `attachment; filename="valuations-${stamp}.xlsx"`)
        .send(xlsx);
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

  /**
   * The auditor workbook: summary, the three model sheets, cap table, waterfall
   * and grant schedules. Read-scoped like every other per-valuation projection —
   * anyone who can read the valuation can export it, because everything in the
   * file is already visible in the workspace tabs.
   */
  app.get('/api/v1/valuations/:id/workbook.xlsx', { preHandler: app.authenticate }, async (req, reply) => {
    const principal = requirePrincipal(req);
    const { id } = req.params as { id: string };
    if (!isUlid(id)) throw problems.notFound();

    const valuation = await findValuationById(deps.pool, id);
    if (
      !valuation ||
      !canReadValuation(principal, { userId: valuation.user_id, partnerId: valuation.partner_id })
    ) {
      throw problems.notFound();
    }

    const [cells, capTable, grants, calculation, overwrites] = await Promise.all([
      listWorkbookCells(deps.pool, id),
      findCapTable(deps.pool, id),
      listGrants(deps.pool, id),
      latestSucceededCalculation(deps.pool, id),
      listOverwrites(deps.pool, id),
    ]);

    const fmv = calculation?.fmv_per_share === null ? null : Number(calculation?.fmv_per_share);
    const generatedAt = new Date();

    const sheets = valuationWorkbookSheets({
      valuation,
      cells,
      capTable: capTable ? { entries: capTable.entries, validation: capTable.validation } : null,
      grants,
      fmvPerShare: fmv !== undefined && Number.isFinite(fmv) ? fmv : null,
      generatedAt,
      overwrites,
      calculation,
    });

    const stamp = generatedAt.toISOString().slice(0, 10);
    return reply
      .header('content-type', XLSX_CONTENT_TYPE)
      .header('content-disposition', `attachment; filename="workbook-${valuation.number}-${stamp}.xlsx"`)
      .send(buildXlsx(sheets, { mtime: generatedAt }));
  });
}
