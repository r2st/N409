import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../../lib/api';
import { formatDateTime } from '../../lib/format';
import { formatMoney, type Calculation } from '../../lib/pipeline';
import { Button, EmptyState, ErrorNote, Spinner, StatCard } from '../ui';

interface ApproachRow {
  key: string;
  name: string;
  weight: number;
  equity_value: number;
  reused: boolean;
}

/** UI recalc names ↔ engine approach keys (mirrors routes/calculations.ts). */
export const RECALC_OPTIONS = [
  { approach: 'asset', engineKey: 'asset', label: 'Asset' },
  { approach: 'opm', engineKey: 'opm_backsolve', label: 'OPM' },
  { approach: 'income', engineKey: 'income', label: 'DCF' },
  { approach: 'market', engineKey: 'market', label: 'Market' },
] as const;
export type RecalcApproach = (typeof RECALC_OPTIONS)[number]['approach'];

function approachRows(calc: Calculation): ApproachRow[] {
  const approaches = (calc.results?.approaches ?? {}) as Record<
    string,
    { weight?: number; equity_value?: number; reused?: boolean }
  >;
  const labels: Record<string, string> = {
    asset: 'Asset approach',
    opm_backsolve: 'OPM backsolve',
    income: 'Income (DCF)',
    market: 'Market (comps)',
  };
  return Object.entries(approaches).map(([key, a]) => ({
    key,
    name: labels[key] ?? key,
    weight: a.weight ?? 0,
    equity_value: a.equity_value ?? 0,
    reused: a.reused === true,
  }));
}

/** Trigger engine computation and show the FMV breakdown. Ops-only. */
export function CalculationPanel({ valuationId, currency }: { valuationId: string; currency: string }) {
  const [calculations, setCalculations] = useState<Calculation[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<'full' | RecalcApproach | null>(null);

  const load = useCallback(async () => {
    try {
      const { calculations: items } = await api<{ calculations: Calculation[] }>(
        `/valuations/${valuationId}/calculations`,
      );
      setCalculations(items);
    } catch {
      setError('Could not load calculations.');
    }
  }, [valuationId]);

  useEffect(() => {
    void load();
  }, [load]);

  const run = async (approach?: RecalcApproach) => {
    setError(null);
    setBusy(approach ?? 'full');
    try {
      await api(`/valuations/${valuationId}/calculations`, {
        method: 'POST',
        body: { inputs: {}, ...(approach ? { approach } : {}) },
      });
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Computation failed.');
      await load();
    } finally {
      setBusy(null);
    }
  };

  if (!calculations && !error) return <Spinner />;

  const latest = calculations?.find((c) => c.status === 'succeeded');
  const discounts = latest?.results?.discounts as { dloc?: number; dlom?: number; dlom_method?: string } | undefined;
  const assumptions = latest?.results?.assumptions as
    | { time_to_exit_years?: number; volatility?: number | null; risk_free_rate?: number }
    | undefined;

  return (
    <div className="space-y-6">
      {error && <ErrorNote>{error}</ErrorNote>}

      <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
        <Button onClick={() => void run()} disabled={busy !== null}>
          {busy === 'full' ? 'Computing…' : 'Run calculation'}
        </Button>
        <p className="text-sm text-ink-500">
          Uses saved params + the latest AI extraction and comparables.
        </p>
      </div>

      {latest && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-semibold text-ink-500">Recalculate one approach:</span>
          {RECALC_OPTIONS.map(({ approach, engineKey, label }) => {
            const inLatest = Boolean(
              (latest.results?.approaches as Record<string, unknown> | undefined)?.[engineKey],
            );
            return (
              <button
                key={approach}
                disabled={busy !== null || !inLatest}
                title={
                  inLatest
                    ? `Recompute only the ${label} approach; the others reuse the latest run`
                    : `The ${label} approach has no weight in the latest run`
                }
                onClick={() => void run(approach)}
                className="cursor-pointer rounded-full border border-ink-200 bg-white px-3 py-1 text-xs font-semibold text-ink-700 transition-colors hover:border-bond-600 hover:text-bond-700 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {busy === approach ? 'Recomputing…' : `↻ ${label}`}
              </button>
            );
          })}
        </div>
      )}

      {latest && (
        <>
          <div className="grid gap-4 sm:grid-cols-3">
            <StatCard label="Fair market value / share" value={formatMoney(latest.fmv_per_share, currency)} accent />
            <StatCard label="Equity value" value={formatMoney(latest.equity_value, currency)} />
            <StatCard
              label="DLOM applied"
              value={discounts?.dlom !== undefined ? `${(discounts.dlom * 100).toFixed(1)}%` : '—'}
            />
          </div>

          <section className="overflow-x-auto rounded-lg border border-paper-300 bg-white p-6 shadow-card">
            <h3 className="overline mb-4 text-ink-400">Approach breakdown</h3>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-ink-400">
                  <th className="py-1 pr-4 font-semibold">Approach</th>
                  <th className="py-1 pr-4 font-semibold">Weight</th>
                  <th className="py-1 font-semibold">Equity value</th>
                </tr>
              </thead>
              <tbody>
                {approachRows(latest).map((row) => (
                  <tr key={row.key} className="border-t border-paper-300">
                    <td className="py-1.5 pr-4 font-semibold text-ink-900">
                      {row.name}
                      {row.reused && (
                        <span
                          className="ml-2 rounded-full bg-paper-200 px-2 py-0.5 text-[0.65rem] font-bold text-ink-500 uppercase"
                          title="Carried over from the previous run during a per-approach recalculation"
                        >
                          reused
                        </span>
                      )}
                    </td>
                    <td className="tnum py-1.5 pr-4">{(row.weight * 100).toFixed(0)}%</td>
                    <td className="tnum py-1.5">{formatMoney(row.equity_value, currency)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="mt-4 text-xs text-ink-400">
              {assumptions &&
                `T = ${assumptions.time_to_exit_years?.toFixed(2)}y · σ = ${assumptions.volatility ?? '—'} · r = ${assumptions.risk_free_rate}`}
              {discounts?.dlom_method && ` · DLOM: ${discounts.dlom_method}`} · engine {latest.engine_version}
            </p>
          </section>
        </>
      )}

      {calculations && calculations.length === 0 && (
        <EmptyState title="No calculations yet">
          Save the methodology params and run extraction first, then compute the fair market value.
        </EmptyState>
      )}

      {calculations && calculations.length > 0 && (
        <section>
          <h3 className="overline mb-3 text-ink-400">History</h3>
          <ul className="divide-y divide-paper-300 rounded-lg border border-paper-300 bg-white shadow-card">
            {calculations.map((calc) => (
              <li key={calc.id} className="flex flex-wrap items-center gap-3 px-4 py-2.5 text-sm">
                <span
                  className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold ring-1 ring-inset ${
                    calc.status === 'succeeded'
                      ? 'bg-bond-50 text-bond-700 ring-bond-200'
                      : 'bg-red-50 text-red-800 ring-red-200'
                  }`}
                >
                  {calc.status}
                </span>
                <span className="tnum font-semibold text-ink-900">
                  {calc.status === 'succeeded' ? formatMoney(calc.fmv_per_share, currency) : (calc.error ?? 'failed')}
                </span>
                {Array.isArray(calc.results?.recomputed) && (
                  <span className="rounded-full bg-sky-50 px-2 py-0.5 text-[0.65rem] font-bold text-sky-800 uppercase">
                    recalc: {(calc.results.recomputed as string[]).join(', ')}
                  </span>
                )}
                <span className="tnum ml-auto text-xs text-ink-400">
                  {formatDateTime(calc.created_at)} · {calc.engine_version}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
