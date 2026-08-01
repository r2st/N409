import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { isUlid, problems } from '@n409/shared';
import { canReadValuation, isOps, type Principal } from '../auth/rbac.js';
import { findValuationById, type ValuationRow } from '../repos/valuations.js';
import { requirePrincipal } from '../plugins/auth.js';
import {
  CAP_TABLE_FIELDS,
  FORMAT_PRESETS,
  parseCapTable,
  parseCsv,
  presetByKey,
  toWaterfallInputs,
  validateCapTable,
  type ColumnMapping,
} from '../domain/capTable.js';
import { findCapTable, saveCapTable } from '../repos/capTables.js';
import { looksLikeXlsx, readXlsx, XlsxReadError } from '../domain/xlsxRead.js';

/**
 * Cap-table integration (feature 9). Import a CSV (Carta / Pulley / generic)
 * with a column mapping, validate share counts / preference stacks / conversion
 * ratios / option pool, store the structured result, and project it into the
 * waterfall-engine inputs. Owner + ops can import and view.
 */

/**
 * Upload cap is well under the document limit: a cap table is a few hundred
 * rows, and an `.xlsx` is decompressed in memory before it is read.
 */
export const MAX_CAP_TABLE_UPLOAD_BYTES = 10 * 1024 * 1024;
/** Matches the row cap on {@link ImportBody} so a preview cannot be rejected. */
const MAX_UPLOAD_ROWS = 2000;

const ImportBody = z.object({
  format: z.string().max(40).default('generic'),
  /** Raw CSV text, OR pre-parsed rows from a client-side parser. */
  csv: z.string().max(2_000_000).optional(),
  rows: z.array(z.record(z.string(), z.unknown())).max(2000).optional(),
  /** field → source column overrides on top of the format preset. */
  mapping: z.record(z.string(), z.string()).optional(),
});

async function loadReadable(pool: pg.Pool, id: string, principal: Principal): Promise<ValuationRow> {
  if (!isUlid(id)) throw problems.notFound();
  const valuation = await findValuationById(pool, id);
  if (!valuation) throw problems.notFound();
  if (!canReadValuation(principal, { userId: valuation.user_id, partnerId: valuation.partner_id })) {
    throw problems.notFound();
  }
  return valuation;
}

function canEdit(principal: Principal, valuation: ValuationRow): boolean {
  return isOps(principal) || valuation.user_id === principal.id;
}

/** Resolve the effective column mapping: preset merged with user overrides. */
function resolveMapping(format: string, overrides?: Record<string, string>): ColumnMapping {
  const preset = presetByKey(format)?.mapping ?? {};
  const mapping: ColumnMapping = { ...preset };
  for (const [field, col] of Object.entries(overrides ?? {})) {
    if ((CAP_TABLE_FIELDS as readonly string[]).includes(field) && col) {
      mapping[field as keyof ColumnMapping] = col;
    }
  }
  return mapping;
}

/** Parse the body into rows (from raw CSV or supplied rows) + resolved mapping. */
function parseInput(body: z.infer<typeof ImportBody>): {
  rows: Record<string, unknown>[];
  mapping: ColumnMapping;
} {
  const rows = body.rows ?? (body.csv ? parseCsv(body.csv) : []);
  return { rows, mapping: resolveMapping(body.format, body.mapping) };
}

export function registerCapTableRoutes(app: FastifyInstance, deps: { pool: pg.Pool }): void {
  // Format presets for the column-mapping UI.
  app.get('/api/v1/cap-table/formats', { preHandler: app.authenticate }, async () => ({
    formats: FORMAT_PRESETS,
    fields: CAP_TABLE_FIELDS,
  }));

  // Current stored cap table + validation.
  app.get('/api/v1/valuations/:id/cap-table', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    const { id } = req.params as { id: string };
    const valuation = await loadReadable(deps.pool, id, principal);
    const table = await findCapTable(deps.pool, id);
    return { cap_table: table, can_edit: canEdit(principal, valuation) };
  });

  // Upload a spreadsheet and get back its sheets as raw rows. Nothing is
  // persisted: the client picks a sheet, then feeds those rows to the preview
  // and save endpoints below, so the mapping and validation path is identical
  // for pasted CSV, uploaded CSV and uploaded Excel.
  app.post('/api/v1/valuations/:id/cap-table/upload', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    const { id } = req.params as { id: string };
    const valuation = await loadReadable(deps.pool, id, principal);
    if (!canEdit(principal, valuation))
      throw problems.forbidden('Only the client or ops can import a cap table');

    const file = await req.file({ limits: { fileSize: MAX_CAP_TABLE_UPLOAD_BYTES, files: 1 } });
    if (!file) throw problems.badRequest('Expected a multipart file field named "file"');

    let buffer: Buffer;
    try {
      buffer = await file.toBuffer();
    } catch {
      throw problems.unprocessable(
        `File exceeds the ${MAX_CAP_TABLE_UPLOAD_BYTES / (1024 * 1024)} MB limit`,
      );
    }
    if (buffer.length === 0) throw problems.unprocessable('Uploaded file is empty');

    const filename = file.filename ?? 'upload';
    let sheets: Array<{ name: string; headers: string[]; rows: Record<string, string>[] }>;

    if (looksLikeXlsx(buffer)) {
      try {
        sheets = readXlsx(buffer);
      } catch (err) {
        if (err instanceof XlsxReadError) throw problems.unprocessable(err.message, { filename });
        throw err;
      }
      if (sheets.length === 0) throw problems.unprocessable('The workbook has no readable sheets');
    } else if (/\.(xls|xlsm|xlsb|numbers|ods)$/i.test(filename)) {
      // Legacy and non-OOXML spreadsheets have entirely different containers.
      throw problems.unprocessable(
        'Only .xlsx workbooks and CSV files can be imported — re-save this file as .xlsx or CSV',
        { filename },
      );
    } else {
      // Anything else is read as delimited text. A stray BOM would otherwise
      // become part of the first header name and break the column mapping.
      const text = buffer.toString('utf8').replace(/^\uFEFF/, '');
      const rows = parseCsv(text);
      sheets = [{ name: filename, headers: Object.keys(rows[0] ?? {}), rows }];
    }

    const truncated = sheets.some((s) => s.rows.length > MAX_UPLOAD_ROWS);
    return {
      filename,
      source: looksLikeXlsx(buffer) ? 'xlsx' : 'csv',
      truncated,
      sheets: sheets.map((s) => ({ ...s, rows: s.rows.slice(0, MAX_UPLOAD_ROWS) })),
    };
  });

  // Parse + validate WITHOUT saving — powers the mapping preview.
  app.post('/api/v1/valuations/:id/cap-table/preview', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    const { id } = req.params as { id: string };
    const valuation = await loadReadable(deps.pool, id, principal);
    if (!canEdit(principal, valuation))
      throw problems.forbidden('Only the client or ops can import a cap table');
    const parsed = ImportBody.safeParse(req.body);
    if (!parsed.success) throw problems.unprocessable('Invalid import', { errors: parsed.error.issues });
    const { rows, mapping } = parseInput(parsed.data);
    const entries = parseCapTable(rows, mapping);
    return { entries, validation: validateCapTable(entries), mapping };
  });

  // Import + persist. Blocks on hard validation errors.
  app.put('/api/v1/valuations/:id/cap-table', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    const { id } = req.params as { id: string };
    const valuation = await loadReadable(deps.pool, id, principal);
    if (!canEdit(principal, valuation))
      throw problems.forbidden('Only the client or ops can import a cap table');
    const parsed = ImportBody.safeParse(req.body);
    if (!parsed.success) throw problems.unprocessable('Invalid import', { errors: parsed.error.issues });

    const { rows, mapping } = parseInput(parsed.data);
    const entries = parseCapTable(rows, mapping);
    const validation = validateCapTable(entries);
    if (!validation.valid) {
      throw problems.unprocessable('Cap table has validation errors', { validation });
    }
    const table = await saveCapTable(
      deps.pool,
      {
        valuationId: id,
        sourceFormat: parsed.data.format,
        entries,
        validation,
        columnMapping: mapping,
        createdBy: principal.id,
      },
      { actorType: 'human', actorId: principal.id },
    );
    return { cap_table: table };
  });

  // Waterfall-engine inputs projected from the stored cap table (ops).
  app.get(
    '/api/v1/valuations/:id/cap-table/waterfall-inputs',
    { preHandler: app.authenticate },
    async (req) => {
      const principal = requirePrincipal(req);
      if (!isOps(principal)) throw problems.forbidden('Operations-only');
      const { id } = req.params as { id: string };
      await loadReadable(deps.pool, id, principal);
      const table = await findCapTable(deps.pool, id);
      if (!table) throw problems.notFound('No cap table imported yet');
      return { inputs: toWaterfallInputs(table.entries) };
    },
  );
}
