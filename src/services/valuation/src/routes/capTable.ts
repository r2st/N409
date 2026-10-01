import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { isUlid, problems } from '@n409/shared';
import { canReadValuation, isOps, type Principal } from '../auth/rbac.js';
import { findValuationById, type ValuationRow } from '../repos/valuations.js';
import { requirePrincipal } from '../plugins/auth.js';
import {
  CAP_TABLE_FIELDS,
  CsvReadError,
  MAX_CAP_TABLE_ENTRIES,
  FORMAT_PRESET_KEYS,
  FORMAT_PRESETS,
  parseCapTableSheet,
  parseCsvSheet,
  presetByKey,
  toWaterfallInputs,
  validateCapTable,
  type ColumnMapping,
} from '../domain/capTable.js';
import { decodeSheetText, SheetTextError } from '../domain/sheetText.js';
import { buildCapTableGraph } from '../domain/capTableGraph.js';
import { findCapTable, saveCapTable } from '../repos/capTables.js';
import { malformedIfMatch, parseIfMatch, versionEtag } from '../domain/concurrency.js';
import { TRANSACTION_PAGE_LIMIT, listRounds } from '../repos/transactions.js';
import { looksLikeXlsx, readXlsx, XlsxReadError } from '../domain/xlsxRead.js';
import { bufferUpload, soleUpload } from './uploadLimits.js';
import { safeFilename } from '../documents/filename.js';
import { refuseIfRetired } from '../domain/retiredEngagement.js';
import { invalidBody } from '../domain/validationProblem.js';
import { forbidden } from '../domain/accessProblem.js';
import { CAP_TABLE_IMPORT_BODY_LIMIT } from './bodyLimits.js';

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
const MAX_UPLOAD_ROWS = MAX_CAP_TABLE_ENTRIES;

/**
 * Bounds on `ImportBody.mapping` — see the field's own note.
 *
 * The key axis is the eight `CAP_TABLE_FIELDS`, with headroom so a client
 * sending a stale field name meets the schema's message rather than being
 * silently ignored by `resolveMapping`; the value axis is one column heading.
 */
const MAX_MAPPING_KEYS = 32;
const MAX_MAPPING_KEY_CHARS = 64;
const MAX_MAPPING_COLUMN_CHARS = 200;

/**
 * Bounds on each entry of `ImportBody.rows` — see the field's own note.
 *
 * A row's keys are spreadsheet column headings, the same category of string
 * as `mapping`'s values, so they share its 200-character ceiling. The count
 * is the same shape `mapping` was bounded for (R430, M6): `parseCapTableSheet`
 * only ever reads the ~8 `CAP_TABLE_FIELDS` back out of a row via `readCell`,
 * so `z.record(z.string(), z.unknown())` left every other key paid for and
 * never used — parsed, hashed, walked by every row of an import — for no
 * column any mapping names. Generous past any real export (`FORMAT_PRESETS`'
 * widest preset maps under 20 headings) so a wide but genuine sheet still
 * imports.
 */
const MAX_ROW_KEYS = 100;

export const ImportBody = z
  .object({
    format: z.enum(FORMAT_PRESET_KEYS).default('generic'),
    /** Raw CSV text, OR pre-parsed rows from a client-side parser. */
    csv: z.string().max(2_000_000).optional(),
    rows: z
      .array(
        z
          .record(z.string().max(MAX_MAPPING_COLUMN_CHARS), z.unknown())
          .refine((row) => Object.keys(row).length <= MAX_ROW_KEYS, {
            message: `Each row may have at most ${MAX_ROW_KEYS} columns`,
          }),
      )
      .max(MAX_CAP_TABLE_ENTRIES)
      .optional(),
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
    source_lines: z.array(z.number().int().min(1)).max(MAX_CAP_TABLE_ENTRIES).optional(),
    /**
     * field → source column overrides on top of the format preset.
     *
     * Bounded on both axes, which it was not. `z.record(z.string(),
     * z.string())` bounds neither the key count nor either string, so the only
     * ceiling on this field was the transport's — and this route is one of the
     * three that *raises* it, to `CAP_TABLE_IMPORT_BODY_LIMIT` (4 MiB), for the
     * sake of `csv` beside it. `routes/specialty.ts` and `routes/debt.ts` bound
     * the same `z.record` shape for the same reason each says out loud: the map
     * does not die with the request.
     *
     * Here it dies even less. `resolveMapping` drops keys that are not
     * `CAP_TABLE_FIELDS`, so an over-wide map cost only the walk — but the
     * *values* it keeps are written to `cap_tables.column_mapping` (jsonb) by
     * `saveCapTable`, returned by the preview endpoint, and re-read with the
     * row by every reader of `STORED_CAP_TABLE_COLUMNS` from then on. Eight
     * megabyte-long column names is a cap table whose every subsequent GET
     * carries four megabytes of a header nobody typed.
     *
     * A value is a column heading in someone's spreadsheet: the longest one any
     * `FORMAT_PRESETS` entry names is "Liquidation Preference" at 22
     * characters, and a heading past 200 is not one an analyst is picking out
     * of a mapping dropdown. The key bound is the field-name axis of the same
     * map — `resolveMapping` ignores anything that is not one of the eight, so
     * this only stops the walk being paid for.
     */
    mapping: z
      .record(z.string().max(MAX_MAPPING_KEY_CHARS), z.string().max(MAX_MAPPING_COLUMN_CHARS))
      .refine((v) => Object.keys(v).length <= MAX_MAPPING_KEYS, {
        message: `At most ${MAX_MAPPING_KEYS} column mappings`,
      })
      .optional(),
  })
  .strict();

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
 * Whatever the readers raise for a file they cannot read, as a 422.
 *
 * `XlsxReadError`, `CsvReadError` and `SheetTextError` all mean the same thing
 * — the bytes are not a sheet this can import — and all three are reachable
 * from the same two endpoints. Left to escape they are 500s, which says the
 * server broke rather than that the file cannot be read, and they are one
 * upload away for anybody.
 */
function asUnreadableFile(err: unknown, filename?: string): never {
  if (err instanceof XlsxReadError || err instanceof CsvReadError || err instanceof SheetTextError) {
    throw problems.unprocessable(err.message, filename === undefined ? undefined : { filename });
  }
  throw err;
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
    // Only the rows that can be imported are built. The count of the rest is
    // what the refusal below needs, and materialising 300,000 records to
    // report a number cost 138 MB of heap per request — see `parseCsvSheet`.
    const sheet = parseCsvSheet(body.csv, { maxRows: MAX_UPLOAD_ROWS });
    // Refused rather than truncated, because this parse feeds the PUT as well
    // as the preview, and silently storing the first 2,000 rows of somebody's
    // cap table is the one outcome worse than refusing it. `/upload` may
    // truncate because it persists nothing and reports `truncated`; here the
    // honest answer names the limit, exactly as zod does for `rows`.
    if (sheet.totalRows > MAX_UPLOAD_ROWS) {
      throw problems.unprocessable(
        `The pasted CSV has ${sheet.totalRows} rows; at most ${MAX_UPLOAD_ROWS} can be imported at once`,
        { rows: sheet.totalRows, limit: MAX_UPLOAD_ROWS },
      );
    }
    return { rows: sheet.rows, mapping, sourceLines: sheet.lines };
  }
  return { rows: [], mapping };
}

/**
 * `parseInput` with the pasted-CSV reader's refusals turned into 422s.
 *
 * Both endpoints that parse a body go through here. A pasted CSV is parsed by
 * the same bounded reader an upload is, so text wider than a worksheet raises
 * from inside the handler rather than from the upload branch that already had
 * a catch.
 */
function readInput(body: z.infer<typeof ImportBody>): ReturnType<typeof parseInput> {
  try {
    return parseInput(body);
  } catch (err) {
    asUnreadableFile(err);
  }
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

    const { file, refuseIfMore } = await soleUpload(req, { fileSize: MAX_CAP_TABLE_UPLOAD_BYTES });

    const buffer = await bufferUpload(file, MAX_CAP_TABLE_UPLOAD_BYTES);
    // Scrubbed once, here, because every use of it below is a sentence somebody
    // reads: the zero-byte refusal quotes it, and `asUnreadableFile` puts it in
    // the problem's `filename` member. Nothing on this path stores it, so this
    // was the one upload route where the name a browser sent was echoed back
    // exactly — bidi controls, C0 controls and all, at whatever length it came
    // in at. `safeFilename` is what the document upload passes the same value
    // through; see documents/filename.ts.
    const filename = safeFilename(file.filename ?? 'upload');
    // A second file here is not the silent data loss it is on the document
    // upload — nothing is stored on this path — but it is the same lie: the
    // client is handed the first file's sheets and told nothing about the
    // spreadsheet it also sent. See `soleUpload`.
    await refuseIfMore(filename);
    if (buffer.length === 0) {
      // The same condition the document upload answers, on the sibling path
      // that was left saying "Uploaded file is empty" — three words that name
      // neither the file nor anything to do about it. Zero bytes arriving
      // intact is not the truncated-upload case (`bufferUpload` answers that
      // one); it is a failed export or a placeholder, and re-uploading the same
      // file changes nothing, so the instruction is to open it rather than to
      // retry.
      throw problems.unprocessable(
        `“${filename}” contains no data — it is zero bytes, so there are no rows to read. ` +
          'Open it to check it exported correctly, then upload it again.',
        { filename },
      );
    }

    let sheets: Array<{
      name: string;
      headers: string[];
      rows: Record<string, string>[];
      /** Source line of each row — echoed back on import so errors can cite it. */
      lines: number[];
      /** Rows the sheet holds, which is `rows.length` unless the reader stopped early. */
      totalRows: number;
    }>;

    if (looksLikeXlsx(buffer)) {
      try {
        sheets = readXlsx(buffer).map((s) => ({ ...s, totalRows: s.rows.length }));
      } catch (err) {
        asUnreadableFile(err, filename);
      }
      if (sheets.length === 0) {
        /*
         * The workbook part parsed and named its sheets, and not one of the
         * sheet parts it names is in the package — the file is damaged or was
         * only partly downloaded. A file renamed to `.xlsx` never reaches here
         * (`parseSheetIndex` raises "Not an Excel workbook"), so this really is
         * a workbook with its contents missing.
         *
         * "The workbook has no readable sheets" states a property of our reader
         * rather than of the file, which reads as our defect: the person
         * uploading it has no way to check what "readable" means, and no
         * instruction that would change the outcome.
         */
        throw problems.unprocessable(
          `“${filename}” is an Excel workbook, but the sheets it lists are not inside the file — ` +
            'its contents are missing, which usually means it was damaged or only partly ' +
            'downloaded. Open it in Excel to check the cap table is still there, save a fresh ' +
            'copy, and upload that. A CSV export works too.',
          { filename },
        );
      }
    } else if (/\.(xls|xlsm|xlsb|numbers|ods)$/i.test(filename)) {
      // Legacy and non-OOXML spreadsheets have entirely different containers.
      throw problems.unprocessable(
        'Only .xlsx workbooks and CSV files can be imported — re-save this file as .xlsx or CSV',
        { filename },
      );
    } else {
      // Anything else is read as delimited text. `decodeSheetText` decides what
      // encoding that text is in and refuses a file that is not text at all —
      // a password-protected workbook is neither a ZIP nor a `.xls`, so it
      // reached this branch and was read as CSV. The parser strips the BOM and
      // sniffs the delimiter, and reports the header row itself: deriving the
      // columns from `Object.keys(rows[0])` lost them entirely for a file with
      // headers and no data rows, and put them in enumeration rather than
      // source order for every other file.
      try {
        const sheet = parseCsvSheet(decodeSheetText(buffer), { maxRows: MAX_UPLOAD_ROWS });
        sheets = [{ name: filename, ...sheet }];
      } catch (err) {
        asUnreadableFile(err, filename);
      }
    }

    // From the row count of the file, not of the reply: the CSV reader stops
    // building rows at the cap, so `rows.length` can no longer tell whether
    // anything was left behind.
    const truncated = sheets.some((s) => s.totalRows > MAX_UPLOAD_ROWS);
    return {
      filename,
      source: looksLikeXlsx(buffer) ? 'xlsx' : 'csv',
      truncated,
      sheets: sheets.map(({ totalRows, ...s }) => ({
        ...s,
        rows: s.rows.slice(0, MAX_UPLOAD_ROWS),
        // Truncated in step with `rows`, so the two stay parallel — the import
        // path drops them entirely if they ever disagree.
        lines: s.lines.slice(0, MAX_UPLOAD_ROWS),
        /** Rows the sheet holds, so a truncated reply says how much it left. */
        total_rows: totalRows,
      })),
    };
  });

  // Parse + validate WITHOUT saving — powers the mapping preview.
  app.post(
    '/api/v1/valuations/:id/cap-table/preview',
    { preHandler: app.authenticate, bodyLimit: CAP_TABLE_IMPORT_BODY_LIMIT },
    async (req) => {
      const principal = requirePrincipal(req);
      const { id } = req.params as { id: string };
      const valuation = await loadReadable(deps.pool, id, principal);
      refuseIfRetired(valuation, 'accepting cap table changes');
      if (!canEdit(principal, valuation))
        throw problems.forbidden('Only the client or ops can import a cap table');
      const parsed = ImportBody.safeParse(req.body);
      if (!parsed.success) throw invalidBody('Invalid import', parsed.error);
      const { rows, mapping, sourceLines } = readInput(parsed.data);
      const { entries, totals } = parseCapTableSheet(rows, mapping, sourceLines);
      return { entries, validation: validateCapTable(entries, totals), mapping };
    },
  );

  // Import + persist. Blocks on hard validation errors.
  app.put(
    '/api/v1/valuations/:id/cap-table',
    { preHandler: app.authenticate, bodyLimit: CAP_TABLE_IMPORT_BODY_LIMIT },
    async (req, reply) => {
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
        throw malformedIfMatch(ifMatch);
      }
      const expectedVersion = ifMatch.kind === 'version' ? ifMatch.version : undefined;

      const parsed = ImportBody.safeParse(req.body);
      if (!parsed.success) throw invalidBody('Invalid import', parsed.error);

      const { rows, mapping, sourceLines } = readInput(parsed.data);
      const { entries, totals } = parseCapTableSheet(rows, mapping, sourceLines);
      /*
       * Two validations, deliberately.
       *
       * `reported` knows what the sheet's totals row said and is what a refusal
       * quotes back; `stored` is derived from the entries alone. The stored
       * `validation` column is a cache that `findCapTable` re-derives on every
       * read — `withFreshValidation`, pinned by test — so an issue that depends on
       * the uploaded file, which the totals checks do, can only be persisted to be
       * silently dropped the next time anybody looks at the row. Writing the
       * reproducible one keeps the column meaning what it claims to mean.
       *
       * Nothing is lost by the split: the totals checks are warnings, so they
       * cannot change `valid`, and the import screen reads them from the preview.
       */
      const reported = validateCapTable(entries, totals);
      const validation = validateCapTable(entries);
      if (!reported.valid) {
        throw problems.unprocessable('Cap table has validation errors', { validation: reported });
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
    },
  );

  // Waterfall-engine inputs projected from the stored cap table (ops).
  app.get(
    '/api/v1/valuations/:id/cap-table/waterfall-inputs',
    { preHandler: app.authenticate },
    async (req) => {
      const principal = requirePrincipal(req);
      if (!isOps(principal)) throw forbidden('Reading the waterfall inputs', 'ops');
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
    const [table, { rounds, truncated }] = await Promise.all([
      findCapTable(deps.pool, id),
      listRounds(deps.pool, id),
    ]);
    if (!table) throw problems.notFound('No cap table imported yet');
    return {
      graph: buildCapTableGraph({
        companyName: valuation.company_name,
        entries: table.entries,
        rounds,
      }),
      // The graph draws a node per round, so a short book is a graph missing
      // financings rather than a graph that is merely shorter.
      truncated,
      page_limit: TRANSACTION_PAGE_LIMIT,
    };
  });
}
