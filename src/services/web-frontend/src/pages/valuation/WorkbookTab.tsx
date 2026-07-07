import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, ApiError } from '../../lib/api';
import { formatWorkbookValue, type WorkbookSheet } from '../../lib/m2';
import { useWorkspace } from './ValuationWorkspace';
import { Button, ErrorNote, Spinner } from '../../components/ui';

type CellKey = `${string}|${string}|${string}`;
const cellKey = (sheet: string, row: string, col: string): CellKey => `${sheet}|${row}|${col}`;

/**
 * The working model: spreadsheet-style grid per sheet. Input rows are
 * editable; derived rows recompute server-side on save (single source of
 * truth for formulas is domain/workbook.ts in the valuation service).
 */
export function WorkbookTab() {
  const { valuation } = useWorkspace();
  const [sheets, setSheets] = useState<WorkbookSheet[] | null>(null);
  const [activeSheet, setActiveSheet] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Map<CellKey, string>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  const load = useCallback(async () => {
    try {
      const { sheets: s } = await api<{ sheets: WorkbookSheet[] }>(`/valuations/${valuation.id}/workbook`);
      setSheets(s);
      setActiveSheet((cur) => cur ?? s[0]?.key ?? null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load the workbook.');
    }
  }, [valuation.id]);

  useEffect(() => {
    void load();
  }, [load]);

  const sheet = useMemo(() => sheets?.find((s) => s.key === activeSheet) ?? null, [sheets, activeSheet]);
  const dirty = drafts.size > 0;

  if (error && !sheets) return <ErrorNote>{error}</ErrorNote>;
  if (!sheets || !sheet) return <Spinner />;

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
      const { sheets: s } = await api<{ sheets: WorkbookSheet[] }>(`/valuations/${valuation.id}/workbook`, {
        method: 'PATCH',
        body: { cells },
      });
      setSheets(s);
      setDrafts(new Map());
      setSavedAt(Date.now());
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save the workbook.');
    } finally {
      setBusy(false);
    }
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
              className={`cursor-pointer rounded px-3 py-1.5 text-xs font-semibold transition-colors ${
                s.key === activeSheet ? 'bg-white text-ink-900 shadow-card' : 'text-ink-400 hover:text-ink-700'
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
          <Button onClick={() => void save()} disabled={!dirty || busy}>
            {busy ? 'Saving…' : 'Save workbook'}
          </Button>
        </div>
      </div>

      {error && <ErrorNote>{error}</ErrorNote>}
      <p className="text-sm text-ink-400">{sheet.description}</p>

      <div className="overflow-x-auto rounded-lg border border-paper-300 bg-white shadow-card">
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
              <tr key={row.key} className={`border-b border-paper-200 ${row.kind === 'derived' ? 'bg-paper-50' : ''}`}>
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
                      <td key={cell.column_key} className="tnum px-3 py-2 text-right font-medium text-ink-700">
                        {formatWorkbookValue(cell.value, row.format)}
                      </td>
                    );
                  }
                  const draft = drafts.get(key);
                  const display = draft !== undefined ? draft : cell.value === null ? '' : String(cell.value);
                  return (
                    <td key={cell.column_key} className="px-1.5 py-1">
                      <input
                        type="text"
                        inputMode="decimal"
                        aria-label={`${row.label} ${cell.column_key}`}
                        value={display}
                        onChange={(e) => setDraft(key, e.target.value, cell.value)}
                        className={`tnum w-full rounded border px-2 py-1.5 text-right text-sm focus:border-bond-600 focus:ring-1 focus:ring-bond-600/30 focus:outline-none ${
                          draft !== undefined ? 'border-amber-300 bg-amber-50' : 'border-transparent bg-transparent hover:border-ink-200'
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
      <p className="text-xs text-ink-400">
        Rows marked <span className="font-semibold">calc</span> are derived and recompute on save. Clear a cell
        to remove its value.
      </p>
    </div>
  );
}
