import { useState } from 'react';
import { api, ApiError } from '../../lib/api';
import { Button, ErrorNote } from '../ui';
import { Heatmap, type HeatCell } from '../charts';

/**
 * Full-model sensitivity (engine-wrapper app/engine/sensitivity.py): stresses
 * the valuation's own params + inputs across the five levers analysts care
 * about, one at a time (tables) and in pairs (heatmaps). Ops only.
 */

type ParamName = 'discount_rate' | 'volatility' | 'exit_multiple' | 'time_to_exit' | 'growth_rate';

interface OneWayPoint {
  value: number;
  fmv_per_share: number | null;
  equity_value: number | null;
  delta_from_base: number | null;
  error?: string;
}
interface OneWayTable {
  parameter: ParamName;
  base_value: number;
  points: OneWayPoint[];
}
interface TwoWayCell {
  fmv_per_share: number | null;
  delta_from_base: number | null;
  error?: string;
}
interface TwoWayTable {
  row_parameter: ParamName;
  col_parameter: ParamName;
  row_values: number[];
  col_values: number[];
  rows: TwoWayCell[][];
}
export interface ModelSensitivityResult {
  base: { fmv_per_share: number; equity_value: number; parameters: Partial<Record<ParamName, number>> };
  one_way: OneWayTable[];
  two_way: TwoWayTable[];
  currency: string | null;
}

const PARAM_META: Record<ParamName, { label: string; fmt: (v: number) => string }> = {
  discount_rate: { label: 'Discount rate', fmt: (v) => `${(v * 100).toFixed(1)}%` },
  volatility: { label: 'Volatility', fmt: (v) => `${(v * 100).toFixed(0)}%` },
  exit_multiple: { label: 'Exit multiple', fmt: (v) => `${v.toFixed(2)}×` },
  time_to_exit: { label: 'Time to exit', fmt: (v) => `${v.toFixed(2)}y` },
  growth_rate: { label: 'Terminal growth', fmt: (v) => `${(v * 100).toFixed(1)}%` },
};

/** Default two-way pairs; the engine skips any lever this valuation doesn't drive. */
const DEFAULT_PAIRS: Array<[ParamName, ParamName]> = [
  ['volatility', 'time_to_exit'],
  ['discount_rate', 'exit_multiple'],
];

function money(v: number | null, currency: string | null): string {
  if (v === null) return '—';
  return new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency: currency || 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  }).format(v);
}

function deltaClass(delta: number | null): string {
  if (delta === null) return 'text-ink-400';
  if (delta > 0.001) return 'text-bond-700';
  if (delta < -0.001) return 'text-red-700';
  return 'text-ink-500';
}

// Amounts are formatted from the currency the sensitivity response carries,
// so the panel needs no currency of its own.
export function ModelSensitivityPanel({ valuationId }: { valuationId: string }) {
  const [result, setResult] = useState<ModelSensitivityResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async () => {
    setError(null);
    setBusy(true);
    try {
      const { sensitivity } = await api<{ sensitivity: ModelSensitivityResult }>(
        `/valuations/${valuationId}/sensitivity/model`,
        { method: 'POST', body: { two_way: DEFAULT_PAIRS, steps: 5 } },
      );
      setResult(sensitivity);
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 403
          ? 'Model sensitivity is operations-only.'
          : err instanceof ApiError
            ? err.message
            : 'Could not run the model sensitivity.',
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="space-y-6" data-testid="model-sensitivity">
      <div className="flex flex-wrap items-center gap-4">
        <div>
          <div className="overline text-ink-400">Full-model sensitivity</div>
          <p className="mt-1 text-sm text-ink-500">
            Re-runs the whole valuation while stressing each assumption ±20% around its base.
          </p>
        </div>
        <Button className="ml-auto" onClick={() => void run()} disabled={busy}>
          {busy ? 'Running…' : result ? 'Re-run' : 'Run model sensitivity'}
        </Button>
      </div>

      {error && <ErrorNote>{error}</ErrorNote>}

      {result && (
        <>
          <div className="font-display text-xl font-semibold text-ink-900">
            Base FMV: {money(result.base.fmv_per_share, result.currency)} / share
          </div>

          {result.one_way.length > 0 && (
            <div className="grid gap-6 lg:grid-cols-2">
              {result.one_way.map((table) => {
                const meta = PARAM_META[table.parameter];
                // The engine degrades a variation it rejects to a null FMV and
                // says why (sensitivity.py `_fmv`). Without the reason the row
                // is just a dash, and the usual cause — a stressed discount
                // rate crossing terminal growth — looks like a broken run
                // rather than a bound of the model.
                const failed = table.points.filter((p) => p.error);
                const reasons = [...new Set(failed.map((p) => p.error as string))];
                return (
                  <div key={table.parameter}>
                    <h3 className="mb-2 font-display text-base font-semibold text-ink-900">{meta.label}</h3>
                    <div className="overflow-x-auto overscroll-x-contain rounded-lg border border-paper-300 bg-surface shadow-card">
                      <table className="w-full text-sm">
                        <caption className="sr-only">{`${meta.label} sensitivity`}</caption>
                        <thead>
                          <tr className="border-b border-paper-300 text-xs text-ink-400">
                            <th className="px-4 py-2.5 text-left font-semibold">{meta.label}</th>
                            <th className="px-4 py-2.5 text-right font-semibold">FMV / share</th>
                            <th className="px-4 py-2.5 text-right font-semibold">Δ base</th>
                          </tr>
                        </thead>
                        <tbody>
                          {table.points.map((p, i) => {
                            const isBase = Math.abs(p.value - table.base_value) < 1e-9;
                            return (
                              <tr
                                key={i}
                                className={`border-b border-paper-200 last:border-0 ${isBase ? 'bg-bond-50' : ''}`}
                              >
                                <td
                                  className={`tnum px-4 py-2 ${isBase ? 'font-semibold text-ink-900' : 'text-ink-700'}`}
                                >
                                  {meta.fmt(p.value)}
                                </td>
                                <td className="tnum px-4 py-2 text-right text-ink-900" title={p.error}>
                                  {money(p.fmv_per_share, result.currency)}
                                  {p.error && <span className="sr-only">{p.error}</span>}
                                </td>
                                <td className={`tnum px-4 py-2 text-right ${deltaClass(p.delta_from_base)}`}>
                                  {p.delta_from_base === null
                                    ? 'n/a'
                                    : `${p.delta_from_base > 0 ? '+' : ''}${(p.delta_from_base * 100).toFixed(1)}%`}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                    {reasons.length > 0 && (
                      <p className="mt-2 text-xs text-ink-500">
                        {failed.length} of {table.points.length} variations did not compute:{' '}
                        {reasons.join('; ')}
                      </p>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {result.two_way.map((tw, idx) => {
            const rowMeta = PARAM_META[tw.row_parameter];
            const colMeta = PARAM_META[tw.col_parameter];
            const cells: HeatCell[][] = tw.rows.map((row) =>
              row.map((c) => ({ value: c.fmv_per_share, delta: c.delta_from_base, note: c.error })),
            );
            return (
              <Heatmap
                key={idx}
                title={`${rowMeta.label} × ${colMeta.label}`}
                rowLabel={rowMeta.label}
                colLabel={colMeta.label}
                rowValues={tw.row_values.map(rowMeta.fmt)}
                colValues={tw.col_values.map(colMeta.fmt)}
                cells={cells}
                format={(v) => money(v, result.currency)}
              />
            );
          })}
        </>
      )}
    </section>
  );
}
