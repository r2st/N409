import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, apiDownload, ApiError } from '../../lib/api';
import {
  formatWorkbookValue,
  type AnomalySeverity,
  type FinancialAnomaly,
  type FinancialAnomalyReport,
  type WorkbookSheet,
} from '../../lib/m2';
import { useWorkspace } from './ValuationWorkspace';
import { Button, EmptyState, ErrorNote, Spinner, WriteGate } from '../../components/ui';

type CellKey = `${string}|${string}|${string}`;
const cellKey = (sheet: string, row: string, col: string): CellKey => `${sheet}|${row}|${col}`;

type WorkbookResponse = { sheets: WorkbookSheet[]; anomalies: FinancialAnomalyReport };

const SEVERITY_STYLE: Record<AnomalySeverity, { row: string; chip: string; label: string }> = {
  error: {
    row: 'border-red-200 bg-red-50/60',
    chip: 'bg-red-100 text-red-800',
    label: 'Error',
  },
  warning: {
    row: 'border-amber-200 bg-amber-50/60',
    chip: 'bg-amber-100 text-amber-800',
    label: 'Check',
  },
  info: {
    row: 'border-paper-300 bg-paper-50',
    chip: 'bg-paper-200 text-ink-600',
    label: 'Note',
  },
};

/**
 * Findings against the entered statements.
 *
 * Deliberately not a gate: the panel says what it found and leaves the analyst
 * to decide, because most of these are legitimate under an explanation and an
 * engine that refused them would be wrong more often than the person it
 * overruled. Errors are the exception worth reading first — a cost entered
 * negative is added back into every margin below it — so they sort to the top
 * and are the only ones coloured as a fault.
 */
function AnomalyPanel({
  report,
  onJump,
}: {
  report: FinancialAnomalyReport;
  onJump: (a: FinancialAnomaly) => void;
}) {
  if (report.empty || report.anomalies.length === 0) return null;

  const { error, warning, info } = report.counts;
  const parts = [
    error > 0 ? `${error} ${error === 1 ? 'error' : 'errors'}` : null,
    warning > 0 ? `${warning} to check` : null,
    info > 0 ? `${info} noted` : null,
  ].filter(Boolean);

  return (
    <section className="rounded-lg border border-paper-300 bg-surface shadow-card">
      <header className="flex items-baseline justify-between gap-3 border-b border-paper-200 px-4 py-3">
        <h3 className="text-sm font-semibold text-ink-800">Statement review</h3>
        <span className="text-xs text-ink-400">{parts.join(' · ')}</span>
      </header>
      <ul className="divide-y divide-paper-200">
        {report.anomalies.map((a, i) => {
          const style = SEVERITY_STYLE[a.severity];
          return (
            <li key={`${a.check}-${a.sheet}-${a.row_key ?? ''}-${a.column_key ?? ''}-${i}`}>
              <button
                type="button"
                onClick={() => onJump(a)}
                className={`flex w-full cursor-pointer gap-3 border-l-4 px-4 py-3 text-left transition-colors hover:bg-paper-100 ${style.row}`}
              >
                <span
                  className={`mt-0.5 shrink-0 rounded px-1.5 py-0.5 text-[0.65rem] font-semibold tracking-wide uppercase ${style.chip}`}
                >
                  {style.label}
                </span>
                <span className="min-w-0">
                  <span className="block text-sm font-medium text-ink-800">{a.summary}</span>
                  <span className="mt-0.5 block text-xs leading-relaxed text-ink-500">{a.detail}</span>
                  <span className="mt-1 block text-[0.7rem] text-ink-400">
                    {[a.sheet_label, a.row_label, a.column_label].filter(Boolean).join(' · ')}
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/**
 * The working model: spreadsheet-style grid per sheet. Input rows are
 * editable; derived rows recompute server-side on save (single source of
 * truth for formulas is domain/workbook.ts in the valuation service).
 */
export function WorkbookTab() {
  const { valuation, retired } = useWorkspace();
  const [sheets, setSheets] = useState<WorkbookSheet[] | null>(null);
  const [anomalies, setAnomalies] = useState<FinancialAnomalyReport | null>(null);
  const [activeSheet, setActiveSheet] = useState<string | null>(null);
  const [highlight, setHighlight] = useState<CellKey | null>(null);
  const [drafts, setDrafts] = useState<Map<CellKey, string>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [exporting, setExporting] = useState(false);

  /**
   * Adopt a workbook, keeping the analyst's place only if it still exists.
   *
   * Both the load and the save replace `sheets` wholesale, and the selection
   * used to survive either unconditionally (`cur ?? first`, which keeps `cur`
   * whenever it is non-null). The engine emits one sheet per approach the
   * weighting asks for, so dropping an approach drops its sheet — and a save
   * that does that leaves `activeSheet` naming a sheet that is gone, `sheet`
   * resolving to null, and the panel showing the not-found branch over data it
   * already has. Shared between the two paths rather than fixed in `load`,
   * because the save is the one that actually reaches it: it sets `sheets`
   * from the PATCH response and never calls `load` at all.
   */
  const adoptSheets = useCallback((s: WorkbookSheet[], a: FinancialAnomalyReport) => {
    setSheets(s);
    setAnomalies(a);
    setActiveSheet((cur) => (cur !== null && s.some((x) => x.key === cur) ? cur : (s[0]?.key ?? null)));
  }, []);

  const load = useCallback(async () => {
    try {
      const { sheets: s, anomalies: a } = await api<WorkbookResponse>(`/valuations/${valuation.id}/workbook`);
      adoptSheets(s, a);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load the workbook.');
    }
  }, [valuation.id, adoptSheets]);

  useEffect(() => {
    void load();
  }, [load]);

  const sheet = useMemo(() => sheets?.find((s) => s.key === activeSheet) ?? null, [sheets, activeSheet]);
  const dirty = drafts.size > 0;

  if (error && !sheets) return <ErrorNote>{error}</ErrorNote>;
  if (!sheets) return <Spinner />;
  /**
   * A workbook with no sheets is a real response — the engine has not run yet,
   * so there is no assumption register or calculation record to show. It used
   * to fall into `!sheet` and return the spinner, which is the one reading that
   * is definitely wrong: the load finished, and the tab span forever telling
   * the analyst to wait for something that had already arrived empty.
   */
  if (sheets.length === 0) {
    return (
      <EmptyState title="No workbook yet">
        The assumption register and calculation record are built when this valuation is calculated. Run the
        engine from the Methodology tab to populate them.
      </EmptyState>
    );
  }
  // Unreachable now that `load` re-seeds a stale key, and kept as a floor
  // rather than a `!` — but a *refusal*, not a spinner. A spinner here waits
  // for a load that has already finished.
  if (!sheet) return <ErrorNote>That sheet is no longer part of this workbook.</ErrorNote>;

  /**
   * The auditor workbook: the assumption register and calculation record, the
   * manual-override log, then model sheets, cap table, waterfall and grants,
   * with live formulas. Unsaved cells are deliberately not included — the export
   * must match what the file of record says.
   */
  const downloadXlsx = async () => {
    setExporting(true);
    setError(null);
    try {
      await apiDownload(`/valuations/${valuation.id}/workbook.xlsx`, `workbook-${valuation.number}.xlsx`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not export the workbook.');
    } finally {
      setExporting(false);
    }
  };

  const setDraft = (key: CellKey, raw: string, original: number | null) => {
    setDrafts((prev) => {
      const next = new Map(prev);
      const normalized = raw.trim();
      const originalText = original === null ? '' : String(original);
      if (normalized === originalText) next.delete(key);
      else next.set(key, normalized);
      return next;
    });
  };

  const save = async () => {
    setBusy(true);
    setError(null);
    setSavedAt(null);
    const cells: Array<{ sheet: string; row_key: string; column_key: string; value: number | null }> = [];
    let invalid: string | null = null;
    for (const [key, raw] of drafts) {
      const [sheetKey, rowKey, colKey] = key.split('|') as [string, string, string];
      if (raw === '') {
        cells.push({ sheet: sheetKey, row_key: rowKey, column_key: colKey, value: null });
        continue;
      }
      const num = Number(raw);
      if (!Number.isFinite(num)) {
        invalid = `“${raw}” is not a number (${rowKey} / ${colKey}).`;
        break;
      }
      cells.push({ sheet: sheetKey, row_key: rowKey, column_key: colKey, value: num });
    }
    if (invalid) {
      setError(invalid);
      setBusy(false);
      return;
    }
    try {
      const { sheets: s, anomalies: a } = await api<WorkbookResponse>(
        `/valuations/${valuation.id}/workbook`,
        { method: 'PATCH', body: { cells } },
      );
      // Anomalies are re-checked against what was just saved, so correcting the
      // cell that raised a finding clears it without a reload.
      adoptSheets(s, a);
      setDrafts(new Map());
      setSavedAt(Date.now());
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save the workbook.');
    } finally {
      setBusy(false);
    }
  };

  /**
   * Open the sheet a finding is about and mark the cell it names.
   *
   * A finding that spans lines (a missing period, an absent balance sheet) has
   * no single cell to mark, so it only switches sheets — better than marking an
   * arbitrary row and implying that is the one at fault.
   */
  const jumpTo = (a: FinancialAnomaly) => {
    setActiveSheet(a.sheet);
    setHighlight(a.row_key && a.column_key ? cellKey(a.sheet, a.row_key, a.column_key) : null);
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex gap-1 rounded-md border border-paper-300 bg-paper-50 p-1">
          {sheets.map((s) => (
            <button
              key={s.key}
              type="button"
              onClick={() => setActiveSheet(s.key)}
              aria-pressed={s.key === activeSheet}
              className={`tap-area cursor-pointer rounded px-3 py-1.5 text-xs font-semibold transition-colors ${
                s.key === activeSheet
                  ? 'bg-surface text-ink-900 shadow-card'
                  : 'text-ink-400 hover:text-ink-700'
              }`}
            >
              {s.label}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-3">
          {savedAt && !dirty && <span className="text-xs font-medium text-bond-700">Saved.</span>}
          {dirty && (
            <span className="text-xs font-medium text-amber-700">
              {drafts.size} unsaved {drafts.size === 1 ? 'cell' : 'cells'}
            </span>
          )}
          <Button
            variant="secondary"
            onClick={() => void downloadXlsx()}
            disabled={exporting}
            title="Assumptions, overrides, the calculation record, and every model sheet — for an auditor to tie to."
          >
            {exporting ? 'Preparing…' : 'Export auditor workbook'}
          </Button>
          <WriteGate closed={retired}>
            <Button onClick={() => void save()} disabled={!dirty || busy}>
              {busy ? 'Saving…' : 'Save workbook'}
            </Button>
          </WriteGate>
        </div>
      </div>

      {error && <ErrorNote>{error}</ErrorNote>}
      {anomalies && <AnomalyPanel report={anomalies} onJump={jumpTo} />}
      <p className="text-sm text-ink-400">{sheet.description}</p>

      <WriteGate closed={retired}>
        <div className="overflow-x-auto rounded-lg border border-paper-300 bg-surface shadow-card">
          <table className="w-full min-w-[40rem] border-collapse text-sm">
            <thead>
              <tr className="border-b border-paper-300 bg-paper-50">
                <th className="px-4 py-2.5 text-left text-xs font-semibold tracking-wide text-ink-400 uppercase">
                  Line item
                </th>
                {sheet.columns.map((col) => (
                  <th
                    key={col.key}
                    className="px-3 py-2.5 text-right text-xs font-semibold tracking-wide text-ink-400 uppercase"
                  >
                    {col.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sheet.rows.map((row) => (
                <tr
                  key={row.key}
                  className={`border-b border-paper-200 ${row.kind === 'derived' ? 'bg-paper-50' : ''}`}
                >
                  <td
                    className={`px-4 py-2 ${row.kind === 'derived' ? 'font-semibold text-ink-700' : 'text-ink-800'}`}
                  >
                    {row.label}
                    {row.kind === 'derived' && (
                      <span className="ml-2 rounded bg-paper-200 px-1.5 py-0.5 text-[0.65rem] font-semibold text-ink-400 uppercase">
                        calc
                      </span>
                    )}
                  </td>
                  {row.cells.map((cell) => {
                    const key = cellKey(sheet.key, row.key, cell.column_key);
                    if (row.kind === 'derived') {
                      return (
                        <td
                          key={cell.column_key}
                          className="tnum px-3 py-2 text-right font-medium text-ink-700"
                        >
                          {formatWorkbookValue(cell.value, row.format)}
                        </td>
                      );
                    }
                    const draft = drafts.get(key);
                    const display =
                      draft !== undefined ? draft : cell.value === null ? '' : String(cell.value);
                    return (
                      <td key={cell.column_key} className="px-1.5 py-1">
                        <input
                          type="text"
                          inputMode="decimal"
                          aria-label={`${row.label} ${cell.column_key}`}
                          value={display}
                          onChange={(e) => setDraft(key, e.target.value, cell.value)}
                          onFocus={() => setHighlight(null)}
                          className={`tnum w-full rounded border px-2 py-1.5 text-right text-sm focus:border-bond-600 focus:ring-1 focus:ring-bond-600/30 focus:outline-none ${
                            draft !== undefined
                              ? 'border-amber-300 bg-amber-50'
                              : highlight === key
                                ? 'border-red-400 bg-red-50 ring-1 ring-red-400/30'
                                : 'border-transparent bg-transparent hover:border-ink-200'
                          }`}
                        />
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </WriteGate>
      <p className="text-xs text-ink-400">
        Rows marked <span className="font-semibold">calc</span> are derived and recompute on save. Clear a
        cell to remove its value.
      </p>
    </div>
  );
}
