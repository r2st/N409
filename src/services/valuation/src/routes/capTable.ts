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
  parseCsvSheet,
  presetByKey,
  toWaterfallInputs,
  validateCapTable,
  type ColumnMapping,
} from '../domain/capTable.js';
import { buildCapTableGraph } from '../domain/capTableGraph.js';
import { findCapTable, saveCapTable } from '../repos/capTables.js';
import { parseIfMatch, versionEtag } from '../domain/concurrency.js';
import { listRounds } from '../repos/transactions.js';
import { looksLikeXlsx, readXlsx, XlsxReadError } from '../domain/xlsxRead.js';
import { UPLOAD_FIELD_LIMITS } from './uploadLimits.js';
import { refuseIfRetired } from '../domain/retiredEngagement.js';

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
/**
 * The most rows one import may carry, on every path into it.
 *
 * Matches the row cap on {@link ImportBody} so a preview cannot be rejected —
 * and is now applied to the pasted-CSV path too, which is the one the textarea
 * uses and the one that had no bound at all. `rows` is capped by zod at 2,000
 * and `/upload` truncates to 2,000 and says so; `csv` was only ever bounded by
 * its two megabytes of *text*, which is some 340,000 lines of `Class,1000`.
 *
 * The same cap table refused as `rows` was therefore accepted as `csv`, and on
 * PUT it was persisted: hundreds of thousands of entries in one `cap_tables`
 * JSON document, which every reader of that valuation then loads whole — the
 * workbook export, the waterfall projection, the graph, the report exhibits.
 * A bound two of three callers enforce is not a bound.
 */
const MAX_UPLOAD_ROWS = 2000;

const ImportBody = z.object({
  format: z.string().max(40).default('generic'),
  /** Raw CSV text, OR pre-parsed rows from a client-side parser. */
  csv: z.string().max(2_000_000).optional(),
  rows: z.array(z.record(z.string(), z.unknown())).max(2000).optional(),
  /**
   * Source line of each entry of `rows`, as the upload endpoint reported it.
   *
   * Only meaningful with `rows`: the `csv` path parses the file here and knows
   * the lines first-hand. It is what lets a validation error name the row of
   * the spreadsheet for an .xlsx import, where the client picked a sheet from
   * /upload and sent its rows back — by then the preamble, header and blank
   * spacers are gone and the array positions no longer track the sheet.
   *
   * Untrusted like any other body field, and only ever used to label a message,
   * so a client that sends nonsense mislabels its own errors and nothing else.
   */
  source_lines: z.array(z.number().int().min(1)).max(2000).optional(),
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

/**
 * Parse the body into rows + resolved mapping + the source line of each row.
 *
 * The lines come from whichever half supplied the rows: parsed here for raw
 * CSV, echoed by the client for rows that came from /upload. When neither
 * offers them the entries carry no line, which is the honest outcome — see
 * `parseCapTable`.
 */
function parseInput(body: z.infer<typeof ImportBody>): {
  rows: Record<string, unknown>[];
  mapping: ColumnMapping;
  sourceLines?: number[];
} {
  const mapping = resolveMapping(body.format, body.mapping);
  if (body.rows) {
    // Only when it actually lines up. A mismatched length means the client
    // built the two arrays from different things, and labelling row 12's error
    // with row 40's number is worse than labelling it with nothing.
    const sourceLines = body.source_lines?.length === body.rows.length ? body.source_lines : undefined;
    return { rows: body.rows, mapping, sourceLines };
  }
  if (body.csv) {
    const sheet = parseCsvSheet(body.csv);
    // Refused rather than truncated, because this parse feeds the PUT as well
    // as the preview, and silently storing the first 2,000 rows of somebody's
    // cap table is the one outcome worse than refusing it. `/upload` may
    // truncate because it persists nothing and reports `truncated`; here the
    // honest answer names the limit, exactly as zod does for `rows`.
    if (sheet.rows.length > MAX_UPLOAD_ROWS) {
      throw problems.unprocessable(
        `The pasted CSV has ${sheet.rows.length} rows; at most ${MAX_UPLOAD_ROWS} can be imported at once`,
        { rows: sheet.rows.length, limit: MAX_UPLOAD_ROWS },
      );
    }
    return { rows: sheet.rows, mapping, sourceLines: sheet.lines };
  }
  return { rows: [], mapping };
}

export function registerCapTableRoutes(app: FastifyInstance, deps: { pool: pg.Pool }): void {
  // Format presets for the column-mapping UI.
  app.get('/api/v1/cap-table/formats', { preHandler: app.authenticate }, async () => ({
    formats: FORMAT_PRESETS,
    fields: CAP_TABLE_FIELDS,
  }));

  // Current stored cap table + validation.
  app.get('/api/v1/valuations/:id/cap-table', { preHandler: app.authenticate }, async (req, reply) => {
    const principal = requirePrincipal(req);
    const { id } = req.params as { id: string };
    const valuation = await loadReadable(deps.pool, id, principal);
    const table = await findCapTable(deps.pool, id);
    // The validator the PUT sends back as If-Match (migration 0162). Set here
    // rather than left to the client to read out of the body, matching
    // GET /valuations/:id — the round trip is then the ordinary HTTP one and an
    // intermediary cannot serve a body whose version has moved. Absent when
    // there is no table yet: there is no version to be stale against, and an
    // ETag on "null" would invite an If-Match that can only ever conflict.
    if (table) reply.header('ETag', versionEtag(table.version));
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
    refuseIfRetired(valuation, 'accepting cap table changes');
    if (!canEdit(principal, valuation))
      throw problems.forbidden('Only the client or ops can import a cap table');

    const file = await req.file({
      limits: { fileSize: MAX_CAP_TABLE_UPLOAD_BYTES, files: 1, ...UPLOAD_FIELD_LIMITS },
    });
    if (!file) throw problems.badRequest('Expected a multipart file field named "file"');

    let buffer: Buffer;
    try {
      buffer = await file.toBuffer();
    } catch {
      throw problems.unprocessable(`File exceeds the ${MAX_CAP_TABLE_UPLOAD_BYTES / (1024 * 1024)} MB limit`);
    }
    if (buffer.length === 0) throw problems.unprocessable('Uploaded file is empty');

    const filename = file.filename ?? 'upload';
    let sheets: Array<{
      name: string;
      headers: string[];
      rows: Record<string, string>[];
      /** Source line of each row — echoed back on import so errors can cite it. */
      lines: number[];
    }>;

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
      // Anything else is read as delimited text. The parser strips the BOM and
      // sniffs the delimiter, and reports the header row itself: deriving the
      // columns from `Object.keys(rows[0])` lost them entirely for a file with
      // headers and no data rows, and put them in enumeration rather than
      // source order for every other file.
      const sheet = parseCsvSheet(buffer.toString('utf8'));
      sheets = [{ name: filename, ...sheet }];
    }

    const truncated = sheets.some((s) => s.rows.length > MAX_UPLOAD_ROWS);
    return {
      filename,
      source: looksLikeXlsx(buffer) ? 'xlsx' : 'csv',
      truncated,
      sheets: sheets.map((s) => ({
        ...s,
        rows: s.rows.slice(0, MAX_UPLOAD_ROWS),
        // Truncated in step with `rows`, so the two stay parallel — the import
        // path drops them entirely if they ever disagree.
        lines: s.lines.slice(0, MAX_UPLOAD_ROWS),
      })),
    };
  });

  // Parse + validate WITHOUT saving — powers the mapping preview.
  app.post('/api/v1/valuations/:id/cap-table/preview', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    const { id } = req.params as { id: string };
    const valuation = await loadReadable(deps.pool, id, principal);
    refuseIfRetired(valuation, 'accepting cap table changes');
    if (!canEdit(principal, valuation))
      throw problems.forbidden('Only the client or ops can import a cap table');
    const parsed = ImportBody.safeParse(req.body);
    if (!parsed.success) throw problems.unprocessable('Invalid import', { errors: parsed.error.issues });
    const { rows, mapping, sourceLines } = parseInput(parsed.data);
    const entries = parseCapTable(rows, mapping, sourceLines);
    return { entries, validation: validateCapTable(entries), mapping };
  });

  // Import + persist. Blocks on hard validation errors.
  app.put('/api/v1/valuations/:id/cap-table', { preHandler: app.authenticate }, async (req, reply) => {
    const principal = requirePrincipal(req);
    const { id } = req.params as { id: string };
    const valuation = await loadReadable(deps.pool, id, principal);
    refuseIfRetired(valuation, 'accepting cap table changes');
    if (!canEdit(principal, valuation))
      throw problems.forbidden('Only the client or ops can import a cap table');

    // Opt-in concurrency check: a client that echoes the ETag it read gets its
    // import refused if somebody else — another editor, or the provider sync —
    // has saved since (migration 0162). Parsed before the body so a malformed
    // header fails the same way whatever the import contains.
    const ifMatch = parseIfMatch(req.headers['if-match']);
    if (ifMatch.kind === 'invalid') {
      throw problems.unprocessable(`Malformed If-Match header: ${ifMatch.raw}`);
    }
    const expectedVersion = ifMatch.kind === 'version' ? ifMatch.version : undefined;

    const parsed = ImportBody.safeParse(req.body);
    if (!parsed.success) throw problems.unprocessable('Invalid import', { errors: parsed.error.issues });

    const { rows, mapping, sourceLines } = parseInput(parsed.data);
    const entries = parseCapTable(rows, mapping, sourceLines);
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
      { expectedVersion },
    );
    reply.header('ETag', versionEtag(table.version));
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

  /**
   * The cap table as a dependency graph — conversion and seniority drawn
   * rather than tabulated. Same readership as the table itself (owner + ops):
   * it is a rearrangement of data the caller can already see, not a new
   * disclosure.
   */
  app.get('/api/v1/valuations/:id/cap-table/graph', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    const { id } = req.params as { id: string };
    const valuation = await loadReadable(deps.pool, id, principal);
    const table = await findCapTable(deps.pool, id);
    if (!table) throw problems.notFound('No cap table imported yet');
    const rounds = await listRounds(deps.pool, id);
    return {
      graph: buildCapTableGraph({
        companyName: valuation.company_name,
        entries: table.entries,
        rounds,
      }),
    };
  });
}
