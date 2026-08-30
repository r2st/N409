import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, describeActionFailure } from '../../lib/api';
import { formatDateTime, formatExactPercent, formatPerShare } from '../../lib/format';
import {
  fieldLabel,
  formatMoney,
  type Calculation,
  type EngineIssue,
  type PreflightResult,
} from '../../lib/pipeline';
import { Button, EmptyState, ErrorNote, ListTruncationNote, Spinner, StatCard, WriteGate } from '../ui';
import { CalculationInspector } from './CalculationInspector';

interface ApproachRow {
  key: string;
  name: string;
  weight: number;
  /**
   * `null` where the engine weighted the approach and produced no value for it
   * — which is not the same thing as an approach that concluded zero, and was
   * rendered as "$0" until it said so.
   */
  equity_value: number | null;
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

/** A present, non-null object — `typeof null` is `'object'`, which this is not. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

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
    equity_value: typeof a.equity_value === 'number' ? a.equity_value : null,
    reused: a.reused === true,
  }));
}

/**
 * Blocking errors and review warnings from the engine's pre-flight validator,
 * each anchored to the input that caused it.
 */
export function IssueList({ issues }: { issues: EngineIssue[] }) {
  if (issues.length === 0) return null;
  return (
    <ul className="space-y-2">
      {issues.map((issue, i) => {
        const blocking = issue.severity === 'error';
        return (
          <li
            key={`${issue.field}-${issue.code}-${i}`}
            className={`rounded-md border-l-4 px-3 py-2 text-sm ${
              blocking
                ? 'border-red-500 bg-red-50 text-red-900'
                : 'border-amber-500 bg-amber-50 text-amber-900'
            }`}
          >
            <span className="font-semibold">{issue.field ? fieldLabel(issue.field) : 'Payload'}</span>
            <span className="mx-1.5 opacity-50">—</span>
            <span>{issue.message}</span>
            {issue.hint && <p className="mt-1 text-xs opacity-80">{issue.hint}</p>}
          </li>
        );
      })}
    </ul>
  );
}

/** Trigger engine computation and show the FMV breakdown. Ops-only. */
export function CalculationPanel({
  valuationId,
  currency,
  readOnly = false,
}: {
  valuationId: string;
  currency: string;
  /** The engagement is retired: the runs stay readable, nothing new starts. */
  readOnly?: boolean;
}) {
  const [calculations, setCalculations] = useState<Calculation[] | null>(null);
  const [capped, setCapped] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<'full' | RecalcApproach | null>(null);
  const [checking, setChecking] = useState(false);
  const [preflight, setPreflight] = useState<PreflightResult | null>(null);
  // Which run is open in the step inspector. One at a time: the panel is the
  // engine's whole working state for a single calculation, and two side by side
  // is a diff view, which is a different feature.
  const [inspecting, setInspecting] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const { calculations: items, truncated } = await api<{
        calculations: Calculation[];
        truncated: boolean;
      }>(`/valuations/${valuationId}/calculations`);
      setCalculations(items);
      setCapped(truncated);
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
      setPreflight(null);
      await load();
    } catch (err) {
      // A rejected payload comes back with the engine's field-level issues;
      // show them where the pre-flight results go rather than as one string.
      const issues = err instanceof ApiError ? (err.problem.issues ?? []) : [];
      if (issues.length > 0) {
        setPreflight({ ok: false, engine_version: '', errors: issues, warnings: [] });
      }
      setError(describeActionFailure(err, 'Computation failed.'));
      await load();
    } finally {
      setBusy(null);
    }
  };

  /** Dry run: what the engine would reject or flag, without persisting anything. */
  const check = async () => {
    setError(null);
    setChecking(true);
    try {
      const result = await api<PreflightResult>(`/valuations/${valuationId}/calculations/preflight`, {
        method: 'POST',
        body: { inputs: {} },
      });
      setPreflight(result);
    } catch (err) {
      setError(describeActionFailure(err, 'Could not check the inputs.'));
    } finally {
      setChecking(false);
    }
  };

  if (!calculations && !error) return <Spinner />;

  /*
   * The newest run this panel is actually about.
   *
   * `calculations` holds runs of two shapes. The 409A pipeline writes
   * `results.approaches` (and the discounts and assumptions read below); a
   * specialty engine writes `results = { kind, specialty }` and puts its
   * headline into the typed `equity_value` / `fmv_per_share` columns, where it
   * means something else — an EMI run's per-share figure is the *restricted*
   * AMV, an IFRS 2 run's equity column is a total share-based-payment expense.
   * Nothing stops an EMI engagement from also running the ordinary compute, so
   * the two interleave here.
   *
   * Taking `find(succeeded)` therefore let a specialty run drive this panel:
   * its AMV printed under "Fair market value / share", an empty approach table
   * under a heading claiming a breakdown, and all four recalculate buttons
   * disabled with "has no weight in the latest run" — a sentence about a
   * weighting the run does not have and never will. Worse, the 409A run those
   * four buttons *could* have recalculated might be sitting one row down.
   *
   * So this panel takes the newest run carrying approaches. A specialty run is
   * not hidden — it stays in the History list below, and its own numbers are on
   * the Specialty Engine tab, captioned by the engine that produced them.
   */
  const latest = calculations?.find((c) => c.status === 'succeeded' && isRecord(c.results?.approaches));
  const discounts = latest?.results?.discounts as
    { dloc?: number; dlom?: number; dlom_method?: string } | undefined;
  const assumptions = latest?.results?.assumptions as
    { time_to_exit_years?: number; volatility?: number | null; risk_free_rate?: number } | undefined;

  return (
    <div className="space-y-6">
      {error && <ErrorNote>{error}</ErrorNote>}

      <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
        <WriteGate closed={readOnly}>
          <Button onClick={() => void run()} disabled={busy !== null || checking}>
            {busy === 'full' ? 'Computing…' : 'Run calculation'}
          </Button>
          <Button variant="secondary" onClick={() => void check()} disabled={busy !== null || checking}>
            {checking ? 'Checking…' : 'Check inputs'}
          </Button>
        </WriteGate>
        <p className="text-sm text-ink-500">Uses saved params + the latest AI extraction and comparables.</p>
      </div>

      {preflight && (
        <section className="space-y-3 rounded-lg border border-paper-300 bg-surface p-6 shadow-card">
          <div className="flex flex-wrap items-baseline gap-x-3">
            <h3 className="overline text-ink-400">Input check</h3>
            <span
              className={`text-sm font-semibold ${
                preflight.errors.length > 0
                  ? 'text-red-700'
                  : preflight.warnings.length > 0
                    ? 'text-amber-700'
                    : 'text-bond-700'
              }`}
            >
              {preflight.errors.length > 0
                ? `${preflight.errors.length} problem${preflight.errors.length > 1 ? 's' : ''} blocking the calculation`
                : preflight.warnings.length > 0
                  ? `Ready to compute · ${preflight.warnings.length} to review`
                  : 'Ready to compute — no issues found'}
            </span>
          </div>
          <IssueList issues={[...preflight.errors, ...preflight.warnings]} />
        </section>
      )}

      {latest && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-semibold text-ink-500">Recalculate one approach:</span>
          <WriteGate closed={readOnly}>
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
                  className="tap-area cursor-pointer rounded-full border border-ink-200 bg-surface px-3 py-1 text-xs font-semibold text-ink-700 transition-colors hover:border-bond-600 hover:text-bond-700 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {busy === approach ? 'Recomputing…' : `↻ ${label}`}
                </button>
              );
            })}
          </WriteGate>
        </div>
      )}

      {/* Warnings recorded with the run itself — visible without re-checking. */}
      {!preflight && latest && (latest.diagnostics?.length ?? 0) > 0 && (
        <section className="space-y-3 rounded-lg border border-paper-300 bg-surface p-6 shadow-card">
          <h3 className="overline text-ink-400">Review points from the latest run</h3>
          <IssueList issues={latest.diagnostics ?? []} />
        </section>
      )}

      {latest && (
        <>
          <div className="grid gap-4 sm:grid-cols-3">
            <StatCard
              label="Fair market value / share"
              value={formatPerShare(latest.fmv_per_share, currency)}
              accent
            />
            <StatCard label="Equity value" value={formatMoney(latest.equity_value, currency)} />
            <StatCard label="DLOM applied" value={formatExactPercent(discounts?.dlom)} />
          </div>

          <section className="overflow-x-auto overscroll-x-contain rounded-lg border border-paper-300 bg-surface p-6 shadow-card">
            <h3 id="approach-breakdown-heading" className="overline mb-4 text-ink-400">
              Approach breakdown
            </h3>
            <table className="w-full text-sm" aria-labelledby="approach-breakdown-heading">
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
          <ul className="divide-y divide-paper-300 rounded-lg border border-paper-300 bg-surface shadow-card">
            {calculations.map((calc) => (
              <li key={calc.id} className="text-sm">
                <div className="flex flex-wrap items-center gap-3 px-4 py-2.5">
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
                    {calc.status === 'succeeded'
                      ? formatPerShare(calc.fmv_per_share, currency)
                      : (calc.error ?? 'failed')}
                  </span>
                  {Array.isArray(calc.results?.recomputed) && (
                    <span className="rounded-full bg-sky-50 px-2 py-0.5 text-[0.65rem] font-bold text-sky-800 uppercase">
                      recalc: {(calc.results.recomputed as string[]).join(', ')}
                    </span>
                  )}
                  {/* Offered on every run, including a failed one — that is the
                      case where the result document says nothing at all and the
                      steps are the only account of where the run died. */}
                  <button
                    type="button"
                    onClick={() => setInspecting((cur) => (cur === calc.id ? null : calc.id))}
                    aria-expanded={inspecting === calc.id}
                    className="cursor-pointer text-xs font-semibold text-bond-700 hover:underline"
                  >
                    {inspecting === calc.id ? 'Hide steps' : 'Inspect steps'}
                  </button>
                  <span className="tnum ml-auto text-xs text-ink-400">
                    {formatDateTime(calc.created_at)} · {calc.engine_version}
                  </span>
                </div>
                {inspecting === calc.id && (
                  <div className="px-4 pb-4">
                    <CalculationInspector valuationId={valuationId} calculationId={calc.id} />
                  </div>
                )}
              </li>
            ))}
          </ul>
          {/* `latest` above is a `find` over this same page, so on a busy
              engagement the twenty-run window is what decides which run the
              approach breakdown at the top of this panel is describing. */}
          <ListTruncationNote truncated={capped} shown={calculations.length} noun="runs" />
        </section>
      )}
    </div>
  );
}
