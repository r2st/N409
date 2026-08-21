import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ChangeEvent } from 'react';
import { api, ApiError, apiUpload, ifMatch, type Problem } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { formatAmount, formatNumber } from '../../lib/format';
import { isOps } from '../../lib/rbac';
import type { ValuationDocument } from '../../lib/pipeline';
import { useWorkspace } from './ValuationWorkspace';
import {
  Button,
  EmptyState,
  ErrorNote,
  Field,
  inputClass,
  LoadingBlock,
  Select,
  Skeleton,
  SkeletonTable,
  Spinner,
} from '../../components/ui';
import { CapTableSyncPanel } from '../../components/valuation/CapTableSyncPanel';
import { CapTableGraph, type CapTableGraphData } from '../../components/CapTableGraph';

/**
 * Cap-table integration (feature 9). Import a spreadsheet (Carta / Pulley /
 * generic) as .xlsx or CSV, map the columns, preview the validation, then save
 * the structured table that feeds the waterfall engine. Also renders the stored
 * table + validation.
 *
 * An uploaded file is parsed server-side into rows; pasted CSV is sent as text.
 * Both converge on the same preview/save endpoints, so the mapping and
 * validation behave identically whichever route the data arrived by.
 */

interface Entry {
  security_class: string;
  class_type: string;
  shares: number;
  price_per_share: number | null;
  invested_amount: number | null;
  liquidation_multiple: number | null;
  seniority: number | null;
  conversion_ratio: number | null;
}
interface Issue {
  severity: 'error' | 'warning';
  code: string;
  message: string;
  /** Line in the uploaded sheet, header counted. Absent on table-level issues. */
  row?: number;
  security_class?: string;
}
interface Validation {
  valid: boolean;
  issues: Issue[];
  summary: {
    total_shares: number;
    common_shares: number;
    preferred_shares: number;
    option_shares: number;
    warrant_shares: number;
    fully_diluted_shares: number;
    total_preference_stack: number;
    class_count: number;
  };
}
interface CapTable {
  source_format: string;
  entries: Entry[];
  validation: Validation;
  updated_at: string;
  /**
   * Optimistic-lock counter (migration 0162), echoed back as `If-Match` on the
   * import below. Optional so the tab still works against an older server that
   * does not report it — `ifMatch` then sends nothing and the write falls back
   * to last-write-wins rather than failing.
   */
  version?: number;
}
interface FormatPreset {
  key: string;
  label: string;
  mapping: Record<string, string>;
}
interface UploadedSheet {
  name: string;
  headers: string[];
  rows: Record<string, string>[];
  /**
   * Source line of each row in the sheet. Echoed back on import so a validation
   * error can cite the row of the workbook: by the time the rows reach here the
   * preamble, header and blank spacers are gone, so their positions no longer
   * track what the reader sees in Excel.
   */
  lines: number[];
}
interface Upload {
  filename: string;
  source: 'xlsx' | 'csv';
  truncated: boolean;
  sheets: UploadedSheet[];
}

const FIELD_LABELS: Record<string, string> = {
  security_class: 'Security class *',
  class_type: 'Type (optional)',
  shares: 'Shares *',
  price_per_share: 'Price / share',
  invested_amount: 'Amount invested',
  liquidation_multiple: 'Liquidation ×',
  seniority: 'Seniority',
  conversion_ratio: 'Conversion ratio',
};

/** Split just the header row of a CSV (basic quote handling) for the mapping UI. */
function csvHeaders(text: string): string[] {
  const firstLine = text.split(/\r?\n/).find((l) => l.trim() !== '') ?? '';
  const out: string[] = [];
  let field = '';
  let q = false;
  for (let i = 0; i < firstLine.length; i++) {
    const c = firstLine[i];
    if (q) {
      if (c === '"' && firstLine[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') q = false;
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ',') {
      out.push(field.trim());
      field = '';
    } else field += c;
  }
  out.push(field.trim());
  return out.filter((h) => h !== '');
}

const TYPE_TONE: Record<string, string> = {
  common: 'text-ink-700',
  preferred: 'text-bond-700',
  option: 'text-amber-700',
  warrant: 'text-sky-700',
};

/**
 * File order within a severity.
 *
 * The validator emits issues per entry and per check, so a table with three bad
 * rows lists them grouped by check rather than by row, and a reader reconciling
 * the list against the open spreadsheet jumps up and down it. Table-level
 * issues (`empty`, `no_option_pool`) have no row and sort last, where they read
 * as a summary rather than as something to go and find.
 *
 * Applied to errors and warnings separately, not to the concatenation: errors
 * are what block the save, so they stay together at the top rather than being
 * interleaved with warnings that happen to sit on earlier rows.
 */
function byRow(a: Issue, b: Issue): number {
  return (a.row ?? Number.POSITIVE_INFINITY) - (b.row ?? Number.POSITIVE_INFINITY);
}

function ValidationBanner({ validation }: { validation: Validation }) {
  const errors = validation.issues.filter((i) => i.severity === 'error');
  const warnings = validation.issues.filter((i) => i.severity === 'warning');
  return (
    <div
      className={`rounded-md border px-4 py-3 text-sm ${
        validation.valid
          ? 'border-bond-200 bg-bond-50 text-bond-800'
          : 'border-red-200 bg-red-50 text-red-800'
      }`}
    >
      <p className="font-semibold">
        {validation.valid ? 'Cap table is valid' : `${errors.length} error(s) block this import`}
        {warnings.length > 0 && ` · ${warnings.length} warning(s)`}
      </p>
      {(errors.length > 0 || warnings.length > 0) && (
        <ul className="mt-2 space-y-1">
          {[...errors.sort(byRow), ...warnings.sort(byRow)].map((i, idx) => (
            <li
              key={idx}
              className={`flex gap-2 ${i.severity === 'error' ? 'text-red-700' : 'text-amber-700'}`}
            >
              {i.row === undefined ? (
                <span aria-hidden="true">•</span>
              ) : (
                // The row as its own element, not only inside the prose: this
                // list is read while scrolling a spreadsheet alongside it, and
                // a column of line numbers is scannable in a way a sentence is
                // not.
                <span className="shrink-0 font-mono text-xs tabular-nums" aria-label={`Row ${i.row}`}>
                  {i.row}
                </span>
              )}
              <span>{i.message}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function EntriesTable({ entries, currency }: { entries: Entry[]; currency: string }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-paper-300 text-left text-xs text-ink-500 uppercase">
            <th className="py-1.5 pr-3">Security</th>
            <th className="py-1.5 pr-3">Type</th>
            <th className="py-1.5 pr-3 text-right">Shares</th>
            <th className="py-1.5 pr-3 text-right">Price</th>
            <th className="py-1.5 pr-3 text-right">Invested</th>
            <th className="py-1.5 text-right">Liq ×</th>
          </tr>
        </thead>
        <tbody className="tnum">
          {entries.map((e, i) => (
            <tr key={`${e.security_class}-${i}`} className="border-b border-paper-200 last:border-0">
              <td className="py-1.5 pr-3 font-semibold text-ink-800">{e.security_class}</td>
              <td className={`py-1.5 pr-3 font-medium ${TYPE_TONE[e.class_type] ?? ''}`}>{e.class_type}</td>
              <td className="py-1.5 pr-3 text-right">{formatNumber(e.shares)}</td>
              <td className="py-1.5 pr-3 text-right text-ink-500">
                {e.price_per_share !== null ? formatAmount(e.price_per_share, currency) : '—'}
              </td>
              <td className="py-1.5 pr-3 text-right text-ink-500">
                {e.invested_amount !== null ? formatAmount(e.invested_amount, currency) : '—'}
              </td>
              <td className="py-1.5 text-right text-ink-500">
                {e.liquidation_multiple !== null ? `${e.liquidation_multiple}×` : '—'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function CapTableTab() {
  const { valuation } = useWorkspace();
  const { user } = useAuth();
  const currency = valuation.currency ?? 'USD';
  const [stored, setStored] = useState<CapTable | null>(null);
  const [canEdit, setCanEdit] = useState(false);
  const [loading, setLoading] = useState(true);
  const [formats, setFormats] = useState<FormatPreset[]>([]);
  const [error, setError] = useState<string | null>(null);

  // Importer state
  const [importing, setImporting] = useState(false);
  const [format, setFormat] = useState('generic');
  const [csv, setCsv] = useState('');
  const [upload, setUpload] = useState<Upload | null>(null);
  const [sheetIndex, setSheetIndex] = useState(0);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [preview, setPreview] = useState<{ entries: Entry[]; validation: Validation } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await api<{ cap_table: CapTable | null; can_edit: boolean }>(
        `/valuations/${valuation.id}/cap-table`,
      );
      setStored(res.cap_table);
      setCanEdit(res.can_edit);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load the cap table.');
    } finally {
      setLoading(false);
    }
  }, [valuation.id]);

  useEffect(() => {
    void load();
    void api<{ formats: FormatPreset[] }>('/cap-table/formats')
      .then((r) => setFormats(r.formats))
      .catch(() => {});
  }, [load]);

  const sheet = upload?.sheets[sheetIndex] ?? null;
  const pastedHeaders = useMemo(() => csvHeaders(csv), [csv]);
  // An uploaded file supersedes the textarea; the server already parsed it.
  const headers = sheet ? sheet.headers : pastedHeaders;
  const currentPreset = formats.find((f) => f.key === format);
  const hasInput = sheet ? sheet.rows.length > 0 : csv.trim() !== '';

  /** Preview and save send parsed rows for an upload, raw text for a paste. */
  const importBody = () =>
    sheet
      ? { format, rows: sheet.rows, source_lines: sheet.lines, mapping }
      : // The raw-text path needs none: the server parses the file and so knows
        // the lines first-hand.
        { format, csv, mapping };

  const resetImport = () => {
    setUpload(null);
    setSheetIndex(0);
    setCsv('');
    setMapping({});
    setPreview(null);
  };

  const onFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    // Clear the input so re-picking the same file after a failure re-fires.
    e.target.value = '';
    if (!file) return;
    setError(null);
    setBusy(true);
    try {
      const form = new FormData();
      form.append('file', file);
      const res = await apiUpload<Upload>(`/valuations/${valuation.id}/cap-table/upload`, form);
      setUpload(res);
      // Land on the sheet most likely to hold the cap table rather than
      // whichever tab happened to be first in the workbook.
      const best = res.sheets.findIndex((s) => /cap|equity|shares|ownership/i.test(s.name));
      // A workbook where nothing matches and nothing has rows leaves both
      // searches at -1, and `-1 || 0` is -1: the tab landed on `sheets[-1]`,
      // so the sheet picker showed a value none of its options carried and
      // the "no data rows" hint — which is exactly the advice that workbook
      // needs — never rendered. Fall back to the first sheet instead.
      const withRows = res.sheets.findIndex((s) => s.rows.length > 0);
      setSheetIndex(best !== -1 ? best : withRows !== -1 ? withRows : 0);
      setCsv('');
      setMapping({});
      setPreview(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not read that file.');
    } finally {
      setBusy(false);
    }
  };

  const runPreview = async () => {
    setError(null);
    setBusy(true);
    try {
      const res = await api<{ entries: Entry[]; validation: Validation }>(
        `/valuations/${valuation.id}/cap-table/preview`,
        { method: 'POST', body: importBody() },
      );
      setPreview(res);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not preview the import.');
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    setError(null);
    setBusy(true);
    try {
      // Guarded on the version this tab loaded. An import replaces the whole
      // table, so without this a save built on a stale read silently discards
      // whatever landed since — another editor's import, or the provider sync
      // running on its schedule (migration 0162).
      await api(`/valuations/${valuation.id}/cap-table`, {
        method: 'PUT',
        body: importBody(),
        headers: ifMatch(stored?.version),
      });
      setImporting(false);
      resetImport();
      await load();
    } catch (err) {
      // A conflict is an out-of-date tab rather than a failed import: reload so
      // the user decides against what actually landed. Handled before the
      // validation branch because a 409 carries no `validation` and would
      // otherwise fall through to the generic message.
      if (err instanceof ApiError && err.status === 409) {
        await load();
        setError(
          err.problem.detail ??
            'Someone else changed this cap table while you were importing. It has been reloaded — please review it and reapply your import.',
        );
        return;
      }
      // A rejected import carries the same validation payload the preview
      // shows, so the user sees which rows failed rather than a bare message.
      // The field is specific to this endpoint, hence the local widening.
      const rejected =
        err instanceof ApiError ? (err.problem as Problem & { validation?: Validation }) : null;
      if (rejected?.validation) {
        setPreview({ entries: [], validation: rejected.validation });
      }
      setError(err instanceof ApiError ? err.message : 'Could not save the cap table.');
    } finally {
      setBusy(false);
    }
  };

  if (loading)
    return (
      <LoadingBlock label="Loading cap table…" className="max-w-4xl space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-3" aria-hidden>
          <Skeleton className="h-6 w-56" />
          <Skeleton className="h-[38px] w-36" />
        </div>
        <div className="rounded-lg border border-paper-300 bg-surface p-2 shadow-card">
          <SkeletonTable columns={5} rows={7} />
        </div>
      </LoadingBlock>
    );

  return (
    <div className="max-w-4xl space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="font-display text-xl font-semibold text-ink-900">Capitalization table</h2>
        {canEdit && (
          <Button
            variant={importing ? 'secondary' : 'primary'}
            onClick={() => {
              if (importing) resetImport();
              setImporting((s) => !s);
            }}
          >
            {importing ? 'Cancel import' : stored ? 'Re-import' : 'Import cap table'}
          </Button>
        )}
      </div>

      {error && <ErrorNote>{error}</ErrorNote>}

      {importing && (
        <section className="space-y-4 rounded-lg border border-paper-300 bg-surface p-5 shadow-card">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Source format">
              <Select
                value={format}
                onChange={(e) => {
                  setFormat(e.target.value);
                  setMapping({});
                  setPreview(null);
                }}
              >
                {formats.map((f) => (
                  <option key={f.key} value={f.key}>
                    {f.label}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Upload Excel or CSV" hint="Or paste the CSV below.">
              <input
                type="file"
                accept=".xlsx,.csv,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                onChange={(e) => void onFile(e)}
                disabled={busy}
                className="text-sm"
              />
            </Field>
          </div>

          {upload ? (
            <div className="space-y-3 rounded-md border border-paper-300 bg-paper-50 px-4 py-3">
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <span className="font-semibold text-ink-800">{upload.filename}</span>
                <span className="text-xs text-ink-400">
                  {upload.source === 'xlsx' ? 'Excel workbook' : 'CSV'} ·{' '}
                  {sheet ? `${sheet.rows.length} rows` : 'no rows'}
                </span>
                <button
                  type="button"
                  onClick={resetImport}
                  className="ml-auto text-xs font-medium text-bond-700 underline"
                >
                  Remove
                </button>
              </div>
              {upload.sheets.length > 1 && (
                <Field label="Sheet">
                  <Select
                    value={String(sheetIndex)}
                    onChange={(e) => {
                      setSheetIndex(Number(e.target.value));
                      setMapping({});
                      setPreview(null);
                    }}
                  >
                    {upload.sheets.map((s, i) => (
                      <option key={s.name} value={i}>
                        {s.name} ({s.rows.length} rows)
                      </option>
                    ))}
                  </Select>
                </Field>
              )}
              {upload.truncated && (
                <p className="text-xs text-amber-700">
                  Only the first 2,000 rows were read. Split the file if the cap table is longer.
                </p>
              )}
              {sheet?.rows.length === 0 && (
                <p className="text-xs text-amber-700">
                  This sheet has no data rows — pick another sheet from the workbook.
                </p>
              )}
            </div>
          ) : (
            <Field label="CSV content">
              <textarea
                value={csv}
                onChange={(e) => setCsv(e.target.value)}
                rows={6}
                placeholder="class,shares,price&#10;Common Stock,8000000,0.10"
                className="w-full rounded-md border border-ink-200 bg-surface px-3 py-2 font-mono text-xs text-ink-900 focus:border-bond-600 focus:ring-2 focus:ring-bond-600/20 focus:outline-none"
              />
            </Field>
          )}

          {headers.length > 0 && (
            <div>
              <h3 className="overline mb-2 text-ink-400">Column mapping</h3>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                {Object.keys(FIELD_LABELS).map((fieldKey) => {
                  const presetCol = currentPreset?.mapping[fieldKey];
                  const value =
                    mapping[fieldKey] ?? (headers.includes(presetCol ?? '') ? presetCol : '') ?? '';
                  return (
                    <Field key={fieldKey} label={FIELD_LABELS[fieldKey]!}>
                      <Select
                        value={value}
                        onChange={(e) => setMapping((m) => ({ ...m, [fieldKey]: e.target.value }))}
                      >
                        <option value="">—</option>
                        {headers.map((h) => (
                          <option key={h} value={h}>
                            {h}
                          </option>
                        ))}
                      </Select>
                    </Field>
                  );
                })}
              </div>
            </div>
          )}

          <div className="flex flex-wrap gap-3">
            <Button variant="secondary" onClick={() => void runPreview()} disabled={busy || !hasInput}>
              {busy ? 'Working…' : 'Preview'}
            </Button>
            {preview && preview.validation.valid && (
              <Button onClick={() => void save()} disabled={busy}>
                Save cap table
              </Button>
            )}
          </div>

          {preview && (
            <div className="space-y-3">
              <ValidationBanner validation={preview.validation} />
              {preview.entries.length > 0 && <EntriesTable entries={preview.entries} currency={currency} />}
            </div>
          )}
        </section>
      )}

      {canEdit && <CapTableSyncPanel valuationId={valuation.id} onApplied={load} />}

      {!stored && !importing ? (
        <EmptyState title="No cap table imported yet">
          {canEdit
            ? 'Upload an Excel or CSV export from Carta, Pulley, or any generic source.'
            : 'The cap table will appear here once imported.'}
        </EmptyState>
      ) : (
        stored && (
          <section className="space-y-4 rounded-lg border border-paper-300 bg-surface p-6 shadow-card">
            <div className="flex flex-wrap items-center gap-3">
              <h3 className="overline text-ink-400">Current cap table</h3>
              <span className="text-xs text-ink-400">
                {stored.source_format} · {stored.entries.length} classes
              </span>
            </div>
            <ValidationBanner validation={stored.validation} />
            <div className="grid gap-3 sm:grid-cols-3">
              <div className="rounded-md border border-paper-300 bg-paper-50 px-4 py-3">
                <div className="overline text-ink-400">Fully diluted</div>
                <div className="tnum mt-1 font-display text-xl font-semibold text-ink-900">
                  {formatNumber(stored.validation.summary.fully_diluted_shares)}
                </div>
              </div>
              <div className="rounded-md border border-paper-300 bg-paper-50 px-4 py-3">
                <div className="overline text-ink-400">Option pool</div>
                <div className="tnum mt-1 font-display text-xl font-semibold text-ink-900">
                  {formatNumber(stored.validation.summary.option_shares)}
                </div>
              </div>
              <div className="rounded-md border border-paper-300 bg-paper-50 px-4 py-3">
                <div className="overline text-ink-400">Preference stack</div>
                <div className="tnum mt-1 font-display text-xl font-semibold text-ink-900">
                  {formatAmount(stored.validation.summary.total_preference_stack, currency)}
                </div>
              </div>
            </div>
            <EntriesTable entries={stored.entries} currency={currency} />
          </section>
        )
      )}

      {stored && <StructureExplorer valuationId={valuation.id} />}

      {isOps(user) && <AnonymizePanel valuationId={valuation.id} />}
    </div>
  );
}

interface AnonymizedDocument {
  id: string;
  original_filename: string;
  filename: string;
  text: string;
}
interface AnonymizeResult {
  text: string;
  documents: AnonymizedDocument[];
  anonymization: { applied: boolean; enforced?: boolean; redacted: Record<string, number> };
  known_entities: { companies: number; people: number };
}

/**
 * Reads as the sentence an operator would say, not as the API's field names.
 *
 * Both forms are spelled out rather than derived, because half of these do not
 * take a bare "s" — "addresses", "companies" — and a summary reading "2 email
 * addresss" undermines a panel whose whole job is to be trusted with the
 * careful handling of somebody's cap table.
 */
const CATEGORY_LABELS: Record<string, [one: string, many: string]> = {
  companies: ['company name', 'company names'],
  names: ['person name', 'person names'],
  emails: ['email address', 'email addresses'],
  phones: ['phone number', 'phone numbers'],
  ssns: ['SSN', 'SSNs'],
  eins: ['EIN', 'EINs'],
  addresses: ['address', 'addresses'],
};

const plural = (n: number, [one, many]: [string, string]) => `${n} ${n === 1 ? one : many}`;

/**
 * Cap-table anonymization (409.ai parity gap #22).
 *
 * Two jobs, and the second is the one that justifies putting it on this tab
 * rather than burying it in an admin screen. The first is to produce a demo or
 * sample from a real engagement without its client in it. The second is to let
 * an operator see, on *this* sheet, what redaction actually catches — before
 * running a pipeline that will send it out. Both need the redacted text where it
 * can be read and copied, which is why the output is a plain preformatted block
 * and not a download.
 *
 * Collapsed by default, in the shape of the structure explorer above it: the
 * table is what a visit to this tab is usually for, and this is a deliberate
 * second question.
 *
 * The issuer and the client contact are struck without being named here, so the
 * "other names" box asks only for what the platform cannot know — the holders,
 * who appear on a cap table as bare names in a column with nothing for a pattern
 * to key on. The result says how many entities were applied, because "0
 * redactions" means something very different when the list was empty.
 */
function AnonymizePanel({ valuationId }: { valuationId: string }) {
  const [open, setOpen] = useState(false);
  const [documents, setDocuments] = useState<ValuationDocument[] | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [text, setText] = useState('');
  const [names, setNames] = useState('');
  const [result, setResult] = useState<AnonymizeResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || documents) return;
    api<{ documents: ValuationDocument[] }>(`/valuations/${valuationId}/documents`)
      .then((d) => setDocuments(d.documents))
      // Not fatal: pasted text is a complete way to use this panel, so a
      // documents outage should cost the list and nothing else.
      .catch(() => setDocuments([]));
  }, [open, documents, valuationId]);

  const toggle = (id: string) =>
    setSelected((prev) => (prev.includes(id) ? prev.filter((d) => d !== id) : [...prev, id]));

  const run = async () => {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const res = await api<AnonymizeResult>(`/valuations/${valuationId}/ai/anonymize`, {
        method: 'POST',
        body: {
          text,
          document_ids: selected,
          // Split on commas and newlines both: a list pasted out of a holder
          // column arrives one per line.
          known_people: names
            .split(/[,\n]/)
            .map((n) => n.trim())
            .filter((n) => n !== ''),
        },
      });
      setResult(res);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not anonymize this cap table.');
    } finally {
      setBusy(false);
    }
  };

  const struck = result ? Object.entries(result.anonymization.redacted) : [];
  const total = struck.reduce((sum, [, n]) => sum + n, 0);

  return (
    <section className="rounded-lg border border-paper-300 bg-surface p-6 shadow-card">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="overline text-ink-400">Anonymize</h3>
          <p className="mt-1 text-sm text-ink-500">
            Strike the identities out of a cap table — for a sample report, or to see what redaction catches
            before anything is sent to a model. The company and the client contact are struck automatically.
          </p>
        </div>
        {/* Named rather than a bare "Show": this sits directly under the
            structure explorer's own toggle, and two adjacent buttons reading
            "Show" tell a screen-reader user nothing about which is which. */}
        <Button variant="secondary" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
          {open ? 'Hide anonymizer' : 'Show anonymizer'}
        </Button>
      </div>

      {open && (
        <div className="mt-5 space-y-4">
          {error && <ErrorNote>{error}</ErrorNote>}

          {documents && documents.length > 0 && (
            <fieldset className="space-y-1.5">
              <legend className="overline text-ink-400">Documents</legend>
              {documents.map((doc) => (
                <label key={doc.id} className="flex items-center gap-2 text-sm text-ink-700">
                  <input
                    type="checkbox"
                    checked={selected.includes(doc.id)}
                    onChange={() => toggle(doc.id)}
                  />
                  <span>{doc.filename}</span>
                </label>
              ))}
            </fieldset>
          )}

          <Field label="Or paste a cap table">
            <textarea
              className={`${inputClass} h-32 font-mono text-xs`}
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="Holder,Class,Shares…"
            />
          </Field>

          <Field
            label="Other names to strike"
            hint="Holders and founders — one per line, or comma-separated. The company and the client contact are already included."
          >
            <textarea
              className={`${inputClass} h-20`}
              value={names}
              onChange={(e) => setNames(e.target.value)}
            />
          </Field>

          <Button onClick={run} disabled={busy || (text.trim() === '' && selected.length === 0)}>
            {busy ? 'Anonymizing…' : 'Anonymize'}
          </Button>

          {result && (
            <div className="space-y-3">
              <p className="text-sm text-ink-600" data-testid="anonymize-summary">
                {total === 0
                  ? 'Nothing was struck.'
                  : `Struck ${struck
                      .map(([category, n]) => plural(n, CATEGORY_LABELS[category] ?? [category, category]))
                      .join(', ')}.`}{' '}
                <span className="text-ink-400">
                  Matched against{' '}
                  {plural(result.known_entities.companies, ['known company', 'known companies'])} and{' '}
                  {plural(result.known_entities.people, ['known person', 'known people'])}.
                </span>
              </p>

              {result.text !== '' && (
                <pre className="max-h-64 overflow-auto rounded-md border border-paper-300 bg-paper-50 p-3 font-mono text-xs whitespace-pre-wrap text-ink-800">
                  {result.text}
                </pre>
              )}

              {result.documents.map((doc) => (
                <div key={doc.id}>
                  {/* Both filenames: the redacted one is what may be
                      forwarded, the original is what the operator ticked. */}
                  <p className="text-xs text-ink-500">
                    <span className="font-semibold text-ink-700">{doc.filename}</span> — from{' '}
                    {doc.original_filename}
                  </p>
                  <pre className="mt-1 max-h-64 overflow-auto rounded-md border border-paper-300 bg-paper-50 p-3 font-mono text-xs whitespace-pre-wrap text-ink-800">
                    {doc.text}
                  </pre>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

/**
 * The structure explorer — the same cap table drawn as conversion and
 * seniority edges.
 *
 * Collapsed by default and fetched only when opened: the table above is what
 * most visits want, and the graph is the second question ("what actually pays
 * first, and what converts into what"), not the first.
 */
function StructureExplorer({ valuationId }: { valuationId: string }) {
  const [open, setOpen] = useState(false);
  const [graph, setGraph] = useState<CapTableGraphData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || graph) return;
    api<{ graph: CapTableGraphData }>(`/valuations/${valuationId}/cap-table/graph`)
      .then((d) => setGraph(d.graph))
      .catch(() => setError('Could not build the structure graph.'));
  }, [open, graph, valuationId]);

  return (
    <section className="rounded-lg border border-paper-300 bg-surface p-6 shadow-card">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="overline text-ink-400">Structure explorer</h3>
          <p className="mt-1 text-sm text-ink-500">
            The preference stack in payment order, with what converts into what. Select a class to isolate its
            relationships.
          </p>
        </div>
        <Button variant="secondary" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
          {open ? 'Hide' : 'Show'}
        </Button>
      </div>
      {open && (
        <div className="mt-5">
          {error ? <ErrorNote>{error}</ErrorNote> : graph ? <CapTableGraph graph={graph} /> : <Spinner />}
        </div>
      )}
    </section>
  );
}
