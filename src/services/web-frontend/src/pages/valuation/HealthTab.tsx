import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../../lib/api';
import { formatDateTime } from '../../lib/format';
import { useWorkspace } from './ValuationWorkspace';
import { Button, EmptyState, ErrorNote, Spinner } from '../../components/ui';

type Severity = 'ok' | 'info' | 'warning' | 'error';
type Category = 'methodology' | 'assumptions' | 'completeness' | 'mathematical' | 'temporal';

interface HealthCheck {
  key: string;
  category: Category;
  label: string;
  severity: Severity;
  detail: string;
}

interface HealthRun {
  id: string;
  calculation_id: string;
  severity: Severity;
  blocking: boolean;
  checks: HealthCheck[];
  counts: Record<Severity, number>;
  created_at: string;
}

interface HealthResponse {
  health_checks: HealthRun[];
  latest_calculation_id: string | null;
  gate: { satisfied: boolean; health_check_id: string | null; severity: Severity | null; blocking: boolean | null };
}

const SEVERITY_STYLES: Record<Severity, string> = {
  ok: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
  info: 'bg-paper-100 text-ink-500 ring-paper-300',
  warning: 'bg-amber-50 text-amber-800 ring-amber-200',
  error: 'bg-red-50 text-red-700 ring-red-200',
};

const CATEGORY_LABELS: Record<Category, string> = {
  methodology: 'Methodology consistency',
  assumptions: 'Assumption reasonableness',
  completeness: 'Data completeness',
  mathematical: 'Mathematical consistency',
  temporal: 'Temporal consistency',
};

const CATEGORY_ORDER: Category[] = [
  'methodology',
  'assumptions',
  'completeness',
  'mathematical',
  'temporal',
];

function SeverityPill({ severity }: { severity: Severity }) {
  return (
    <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ring-1 ring-inset ${SEVERITY_STYLES[severity]}`}>
      {severity}
    </span>
  );
}

/**
 * Valuation health checks (domain/healthChecks.ts, ops-only): a categorized
 * readiness checklist run over the latest calculation before finalization. An
 * `error` blocks finalization; the banner always refers to the LATEST
 * calculation, so a recalculation invalidates a prior run.
 */
export function HealthTab() {
  const { valuation } = useWorkspace();
  const [data, setData] = useState<HealthResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  const load = useCallback(async () => {
    try {
      setData(await api<HealthResponse>(`/valuations/${valuation.id}/health-checks`));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load health checks.');
    }
  }, [valuation.id]);

  useEffect(() => {
    void load();
  }, [load]);

  const run = async () => {
    setRunning(true);
    setError(null);
    try {
      await api(`/valuations/${valuation.id}/health-checks`, { method: 'POST' });
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Health checks run failed.');
    } finally {
      setRunning(false);
    }
  };

  if (error && !data) return <ErrorNote>{error}</ErrorNote>;
  if (!data) return <Spinner />;

  const latest = data.health_checks[0] ?? null;
  const noCalc = data.latest_calculation_id === null;

  return (
    <div className="space-y-6">
      <div
        data-testid="health-gate-banner"
        className={`rounded-md border px-4 py-3 text-sm ${
          noCalc
            ? 'border-paper-300 bg-paper-100 text-ink-500'
            : data.gate.satisfied
              ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
              : 'border-red-200 bg-red-50 text-red-800'
        }`}
      >
        {noCalc
          ? 'No completed calculation yet — health checks open once the first calculation succeeds.'
          : data.gate.satisfied
            ? `Ready to finalize — the latest calculation passed with a ${data.gate.severity} verdict.`
            : 'Finalization blocked — the latest calculation has one or more error-level health checks to resolve.'}
      </div>

      <div>
        <Button onClick={() => void run()} disabled={running || noCalc}>
          {running ? 'Running…' : 'Run health checks'}
        </Button>
      </div>
      {error && <ErrorNote>{error}</ErrorNote>}

      {!latest ? (
        <EmptyState title="No health checks yet">
          Run the checks to verify methodology, assumptions, completeness, math, and dates before finalizing.
        </EmptyState>
      ) : (
        <section className="rounded-lg border border-paper-300 bg-surface p-6 shadow-card">
          <div className="mb-4 flex flex-wrap items-center gap-3">
            <h2 className="overline text-ink-400">Latest run</h2>
            <SeverityPill severity={latest.severity} />
            <span className="tnum text-xs text-ink-400">{formatDateTime(latest.created_at)}</span>
            {latest.calculation_id !== data.latest_calculation_id && (
              <span className="rounded-full bg-amber-50 px-2 py-0.5 text-xs font-semibold text-amber-800 ring-1 ring-amber-200 ring-inset">
                stale — checks an older calculation
              </span>
            )}
            <span className="ml-auto flex gap-2 text-xs text-ink-500">
              <span className="font-semibold text-red-700">{latest.counts.error} error</span>
              <span className="font-semibold text-amber-700">{latest.counts.warning} warning</span>
              <span>{latest.counts.info} info</span>
            </span>
          </div>

          <div className="space-y-6">
            {CATEGORY_ORDER.filter((cat) => latest.checks.some((c) => c.category === cat)).map((cat) => (
              <div key={cat}>
                <h3 className="mb-2 text-sm font-semibold text-ink-800">{CATEGORY_LABELS[cat]}</h3>
                <ul className="space-y-1.5">
                  {latest.checks
                    .filter((c) => c.category === cat)
                    .map((check) => (
                      <li key={check.key} className="flex items-start gap-2.5 text-sm">
                        <SeverityPill severity={check.severity} />
                        <span className="text-ink-700">
                          <span className="font-medium text-ink-900">{check.label}.</span> {check.detail}
                        </span>
                      </li>
                    ))}
                </ul>
              </div>
            ))}
          </div>
        </section>
      )}

      {data.health_checks.length > 1 && (
        <section>
          <h2 className="overline mb-3 text-ink-400">History</h2>
          <ol className="space-y-2">
            {data.health_checks.slice(1).map((run) => (
              <li
                key={run.id}
                className="flex items-center gap-3 rounded-md border border-paper-300 bg-surface px-3.5 py-2 text-sm"
              >
                <SeverityPill severity={run.severity} />
                <span className="text-ink-600">
                  {run.checks.length} checks · {run.counts.error} error / {run.counts.warning} warning
                </span>
                <span className="tnum ml-auto text-xs text-ink-400">{formatDateTime(run.created_at)}</span>
              </li>
            ))}
          </ol>
        </section>
      )}
    </div>
  );
}
