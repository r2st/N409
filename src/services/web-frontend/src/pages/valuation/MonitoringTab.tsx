import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, ApiError } from '../../lib/api';
import { formatDateTime } from '../../lib/format';
import { useWorkspace } from './ValuationWorkspace';
import { Button, EmptyState, ErrorNote, Spinner } from '../../components/ui';

/**
 * Valuation monitoring panel (feature 10). Enable monitoring on a completed
 * valuation, see live revaluation triggers (funding, revenue, cap table,
 * expiry) with a green/yellow/red status, and roll forward into a fresh
 * valuation in one click. Ops-only (route-guarded).
 */

type Level = 'green' | 'yellow' | 'red';
interface Trigger {
  type: string;
  level: Level;
  message: string;
}
interface Snapshot {
  valuation_date: string | null;
  annual_revenue: number | null;
  fully_diluted_shares: number | null;
  last_round_date: string | null;
}
interface MonitorResponse {
  monitor: { enabled: boolean; baseline: Snapshot; last_checked_at: string | null } | null;
  current?: Snapshot;
  status: Level;
  triggers: Trigger[];
  monitorable?: boolean;
}

export const MONITOR_TONE: Record<Level, string> = {
  green: 'bg-bond-50 text-bond-700 ring-bond-200',
  yellow: 'bg-amber-50 text-amber-800 ring-amber-200',
  red: 'bg-red-50 text-red-700 ring-red-200',
};

const STATUS_LABEL: Record<Level, string> = {
  green: 'All clear',
  yellow: 'Watch',
  red: 'Revaluation suggested',
};

export function MonitoringTab() {
  const { valuation } = useWorkspace();
  const navigate = useNavigate();
  const [data, setData] = useState<MonitorResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setData(await api<MonitorResponse>(`/valuations/${valuation.id}/monitor`));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load monitoring.');
    }
  }, [valuation.id]);

  useEffect(() => {
    void load();
  }, [load]);

  const act = async (fn: () => Promise<unknown>) => {
    setError(null);
    setBusy(true);
    try {
      await fn();
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Action failed.');
    } finally {
      setBusy(false);
    }
  };

  const rollForward = async () => {
    setError(null);
    setBusy(true);
    try {
      const res = await api<{ valuation: { id: string } }>(
        `/valuations/${valuation.id}/monitor/new-valuation`,
        { method: 'POST', body: {} },
      );
      navigate(`/valuations/${res.valuation.id}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not start a new valuation.');
      setBusy(false);
    }
  };

  if (!data && !error) return <Spinner />;
  if (!data) return <ErrorNote>{error}</ErrorNote>;

  const monitored = data.monitor?.enabled;

  return (
    <div className="max-w-2xl space-y-5">
      {error && <ErrorNote>{error}</ErrorNote>}

      {!monitored ? (
        <section className="rounded-lg border border-paper-300 bg-white p-6 shadow-card">
          <h2 className="font-display text-lg font-semibold text-ink-900">Monitoring</h2>
          <p className="mt-2 mb-4 text-sm text-ink-500">
            Track this valuation for events that suggest a fresh 409A is due — a new funding round,
            a material revenue change, a cap-table change, or the 12-month safe-harbor expiry.
          </p>
          {data.monitorable === false ? (
            <EmptyState title="Not ready to monitor">
              A valuation can be monitored once it is completed.
            </EmptyState>
          ) : (
            <Button disabled={busy} onClick={() => void act(() => api(`/valuations/${valuation.id}/monitor`, { method: 'POST', body: {} }))}>
              Enable monitoring
            </Button>
          )}
        </section>
      ) : (
        <>
          <section className="rounded-lg border border-paper-300 bg-white p-6 shadow-card">
            <div className="flex flex-wrap items-center gap-3">
              <h2 className="font-display text-lg font-semibold text-ink-900">Monitoring</h2>
              <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-semibold ring-1 ring-inset ${MONITOR_TONE[data.status]}`}>
                <span className={`h-1.5 w-1.5 rounded-full ${data.status === 'green' ? 'bg-bond-500' : data.status === 'yellow' ? 'bg-amber-500' : 'bg-red-500'}`} />
                {STATUS_LABEL[data.status]}
              </span>
              {data.monitor?.last_checked_at && (
                <span className="tnum text-xs text-ink-400">
                  checked {formatDateTime(data.monitor.last_checked_at)}
                </span>
              )}
            </div>

            {data.triggers.length === 0 ? (
              <p className="mt-4 text-sm text-ink-500">
                No triggers active. This valuation is still current.
              </p>
            ) : (
              <ul className="mt-4 space-y-2">
                {data.triggers.map((t, i) => (
                  <li
                    key={`${t.type}-${i}`}
                    className={`rounded-md border px-3.5 py-2.5 text-sm ${
                      t.level === 'red' ? 'border-red-200 bg-red-50 text-red-800' : 'border-amber-200 bg-amber-50 text-amber-800'
                    }`}
                  >
                    <span className="font-semibold capitalize">{t.type.replace(/_/g, ' ')}:</span> {t.message}
                  </li>
                ))}
              </ul>
            )}

            <div className="mt-5 flex flex-wrap gap-3">
              {data.status !== 'green' && (
                <Button disabled={busy} onClick={() => void rollForward()}>
                  Start new valuation (roll forward)
                </Button>
              )}
              <Button
                variant="secondary"
                disabled={busy}
                onClick={() => void act(() => api(`/valuations/${valuation.id}/monitor`, { method: 'DELETE' }))}
              >
                Disable monitoring
              </Button>
            </div>
          </section>

          {data.current && data.monitor && (
            <section className="rounded-lg border border-paper-300 bg-white p-6 shadow-card">
              <h3 className="overline mb-3 text-ink-400">Baseline vs current</h3>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-paper-300 text-left text-xs text-ink-500 uppercase">
                      <th className="py-1.5 pr-3">Metric</th>
                      <th className="py-1.5 pr-3">Baseline</th>
                      <th className="py-1.5">Current</th>
                    </tr>
                  </thead>
                  <tbody className="tnum">
                    <tr className="border-b border-paper-200">
                      <td className="py-1.5 pr-3 text-ink-600">Annual revenue</td>
                      <td className="py-1.5 pr-3">{data.monitor.baseline.annual_revenue ?? '—'}</td>
                      <td className="py-1.5">{data.current.annual_revenue ?? '—'}</td>
                    </tr>
                    <tr className="border-b border-paper-200">
                      <td className="py-1.5 pr-3 text-ink-600">Fully diluted shares</td>
                      <td className="py-1.5 pr-3">{data.monitor.baseline.fully_diluted_shares ?? '—'}</td>
                      <td className="py-1.5">{data.current.fully_diluted_shares ?? '—'}</td>
                    </tr>
                    <tr>
                      <td className="py-1.5 pr-3 text-ink-600">Last funding round</td>
                      <td className="py-1.5 pr-3">{data.monitor.baseline.last_round_date ?? '—'}</td>
                      <td className="py-1.5">{data.current.last_round_date ?? '—'}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </section>
          )}
        </>
      )}
    </div>
  );
}
