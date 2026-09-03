import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, describeActionFailure } from '../../lib/api';
import { formatDateTime } from '../../lib/format';
import { useWorkspace } from './ValuationWorkspace';
import { Button, EmptyState, ErrorNote, LoadError, Spinner, WriteGate, useRetry } from '../../components/ui';

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
  /**
   * Whether the scan actually reaches this engagement (R401).
   *
   * The monitor row stays enabled when an engagement is retired or called off —
   * the decision is reversible, and restoring it resumes the watch — but the
   * scan skips it, so nothing evaluates the triggers and nobody is emailed. The
   * panel showed a live status badge and a `checked` stamp regardless, which is
   * the one claim this screen exists to make and the one it was making wrongly.
   *
   * Optional so an older server that does not send it reads as watched, which
   * is what this panel assumed before the field existed.
   */
  watched?: boolean;
  unwatched_reason?: 'retired' | 'closed';
}

/** Why the watch is dormant, in the words the client uses for each. */
const UNWATCHED_NOTE: Record<'retired' | 'closed', string> = {
  retired: 'This engagement has been retired, so monitoring is paused.',
  closed: 'This engagement has been closed, so monitoring is paused.',
};

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
  const { valuation, retired } = useWorkspace();
  const navigate = useNavigate();
  const [data, setData] = useState<MonitorResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { token, retryProps } = useRetry(() => setError(null));
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setData(await api<MonitorResponse>(`/valuations/${valuation.id}/monitor`));
    } catch (err) {
      setError(describeActionFailure(err, 'Could not load monitoring.'));
    }
  }, [valuation.id]);

  useEffect(() => {
    void load();
  }, [load, token]);

  /*
   * Starting and stopping a watch are opposite requests and shared one word.
   * "Action failed." leaves the reader looking at a control whose label is the
   * only clue to what they just asked for, which is the state the message
   * exists to resolve.
   */
  const act = async (operation: string, fn: () => Promise<unknown>) => {
    setError(null);
    setBusy(true);
    try {
      await fn();
      await load();
    } catch (err) {
      setError(describeActionFailure(err, operation));
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
      setError(describeActionFailure(err, 'Could not start a new valuation.'));
      setBusy(false);
    }
  };

  if (!data && !error) return <Spinner />;
  if (!data) return <LoadError message={error} {...retryProps} />;

  const monitored = data.monitor?.enabled;

  return (
    <div className="max-w-2xl space-y-5">
      {error && <ErrorNote>{error}</ErrorNote>}

      {!monitored ? (
        <section className="rounded-lg border border-paper-300 bg-surface p-6 shadow-card">
          <h2 className="font-display text-lg font-semibold text-ink-900">Monitoring</h2>
          <p className="mt-2 mb-4 text-sm text-ink-500">
            Track this valuation for events that suggest a fresh 409A is due — a new funding round, a material
            revenue change, a cap-table change, or the 12-month safe-harbor expiry.
          </p>
          {data.monitorable === false ? (
            <EmptyState title="Not ready to monitor">
              A valuation can be monitored once it is completed.
            </EmptyState>
          ) : (
            <WriteGate closed={retired}>
              <Button
                disabled={busy}
                onClick={() =>
                  void act('Could not start monitoring this valuation.', () =>
                    api(`/valuations/${valuation.id}/monitor`, { method: 'POST', body: {} }),
                  )
                }
              >
                Enable monitoring
              </Button>
            </WriteGate>
          )}
        </section>
      ) : (
        <>
          <section className="rounded-lg border border-paper-300 bg-surface p-6 shadow-card">
            <div className="flex flex-wrap items-center gap-3">
              <h2 className="font-display text-lg font-semibold text-ink-900">Monitoring</h2>
              <span
                className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-semibold ring-1 ring-inset ${MONITOR_TONE[data.status]}`}
              >
                <span
                  className={`h-1.5 w-1.5 rounded-full ${data.status === 'green' ? 'bg-bond-500' : data.status === 'yellow' ? 'bg-amber-500' : 'bg-red-500'}`}
                />
                {STATUS_LABEL[data.status]}
              </span>
              {data.monitor?.last_checked_at && (
                <span className="tnum text-xs text-ink-400">
                  checked {formatDateTime(data.monitor.last_checked_at)}
                </span>
              )}
            </div>

            {data.watched === false && (
              <p
                role="status"
                className="mt-4 rounded-md border border-amber-200 bg-amber-50 px-3.5 py-2.5 text-sm text-amber-800"
              >
                {UNWATCHED_NOTE[data.unwatched_reason ?? 'closed']} The triggers below are still current, but
                nothing is checking them and no alerts will be sent until the engagement is reopened.
              </p>
            )}

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
                      t.level === 'red'
                        ? 'border-red-200 bg-red-50 text-red-800'
                        : 'border-amber-200 bg-amber-50 text-amber-800'
                    }`}
                  >
                    <span className="font-semibold capitalize">{t.type.replace(/_/g, ' ')}:</span> {t.message}
                  </li>
                ))}
              </ul>
            )}

            <WriteGate closed={retired}>
              <div className="mt-5 flex flex-wrap gap-3">
                {data.status !== 'green' && (
                  <Button disabled={busy} onClick={() => void rollForward()}>
                    Start new valuation (roll forward)
                  </Button>
                )}
                <Button
                  variant="secondary"
                  disabled={busy}
                  onClick={() =>
                    void act('Could not stop monitoring this valuation.', () =>
                      api(`/valuations/${valuation.id}/monitor`, { method: 'DELETE' }),
                    )
                  }
                >
                  Disable monitoring
                </Button>
              </div>
            </WriteGate>
          </section>

          {data.current && data.monitor && (
            <section className="rounded-lg border border-paper-300 bg-surface p-6 shadow-card">
              <h3 id="baseline-vs-current-heading" className="overline mb-3 text-ink-400">
                Baseline vs current
              </h3>
              <div className="overflow-x-auto overscroll-x-contain">
                <table className="w-full text-sm" aria-labelledby="baseline-vs-current-heading">
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
