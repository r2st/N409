import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ChangeEvent } from 'react';
import { api, ApiError, type Problem } from '../../lib/api';
import { formatMoney, formatNumber } from '../../lib/format';
import { useWorkspace } from './ValuationWorkspace';
import { Button, EmptyState, ErrorNote, Field, Select, Spinner } from '../../components/ui';
import { CapTableSyncPanel } from '../../components/valuation/CapTableSyncPanel';

/**
 * Cap-table integration (feature 9). Import a CSV (Carta / Pulley / generic),
 * map the columns, preview the validation, then save the structured table that
 * feeds the waterfall engine. Also renders the stored table + validation.
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
}
interface FormatPreset {
  key: string;
  label: string;
  mapping: Record<string, string>;
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
          {[...errors, ...warnings].map((i, idx) => (
            <li key={idx} className={i.severity === 'error' ? 'text-red-700' : 'text-amber-700'}>
              • {i.message}
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
                {e.price_per_share !== null ? formatMoney(e.price_per_share, currency) : '—'}
              </td>
              <td className="py-1.5 pr-3 text-right text-ink-500">
                {e.invested_amount !== null ? formatMoney(e.invested_amount, currency) : '—'}
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

  const headers = useMemo(() => csvHeaders(csv), [csv]);
  const currentPreset = formats.find((f) => f.key === format);

  const onFile = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => setCsv(String(reader.result ?? ''));
    reader.readAsText(file);
  };

  const runPreview = async () => {
    setError(null);
    setBusy(true);
    try {
      const res = await api<{ entries: Entry[]; validation: Validation }>(
        `/valuations/${valuation.id}/cap-table/preview`,
        { method: 'POST', body: { format, csv, mapping } },
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
      await api(`/valuations/${valuation.id}/cap-table`, {
        method: 'PUT',
        body: { format, csv, mapping },
      });
      setImporting(false);
      setPreview(null);
      setCsv('');
      setMapping({});
      await load();
    } catch (err) {
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

  if (loading) return <Spinner />;

  return (
    <div className="max-w-4xl space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="font-display text-xl font-semibold text-ink-900">Capitalization table</h2>
        {canEdit && (
          <Button variant={importing ? 'secondary' : 'primary'} onClick={() => setImporting((s) => !s)}>
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
            <Field label="Upload CSV" hint="Or paste the CSV below.">
              <input type="file" accept=".csv,text/csv" onChange={onFile} className="text-sm" />
            </Field>
          </div>

          <Field label="CSV content">
            <textarea
              value={csv}
              onChange={(e) => setCsv(e.target.value)}
              rows={6}
              placeholder="class,shares,price&#10;Common Stock,8000000,0.10"
              className="w-full rounded-md border border-ink-200 bg-surface px-3 py-2 font-mono text-xs text-ink-900 focus:border-bond-600 focus:ring-2 focus:ring-bond-600/20 focus:outline-none"
            />
          </Field>

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
            <Button variant="secondary" onClick={() => void runPreview()} disabled={busy || !csv.trim()}>
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
            ? 'Import a CSV from Carta, Pulley, or a generic export.'
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
                  {formatMoney(stored.validation.summary.total_preference_stack, currency)}
                </div>
              </div>
            </div>
            <EntriesTable entries={stored.entries} currency={currency} />
          </section>
        )
      )}
    </div>
  );
}
