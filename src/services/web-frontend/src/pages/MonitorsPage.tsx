import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, describeLoadFailure } from '../lib/api';
import { HelpIcon } from '../components/HelpIcon';
import { formatDateTime } from '../lib/format';
import { EmptyState, KindBadge, LoadError, Spinner, useRetry } from '../components/ui';
import { MONITOR_TONE } from './valuation/MonitoringTab';

/**
 * Monitoring dashboard (feature 10). Every monitored valuation with its live
 * trigger status (green/yellow/red). Ops-only (route-guarded).
 */

type Level = 'green' | 'yellow' | 'red';
interface MonitorSummary {
  valuation_id: string;
  company_name: string;
  kind: string;
  last_checked_at: string | null;
  status: Level;
  triggers: Array<{ type: string; level: Level; message: string }>;
}

export function MonitorsPage() {
  const [monitors, setMonitors] = useState<MonitorSummary[] | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { token, retryProps } = useRetry(() => setError(null));

  useEffect(() => {
    void api<{ monitors: MonitorSummary[]; truncated: boolean }>('/monitors')
      .then((r) => {
        setMonitors(r.monitors);
        setTruncated(r.truncated);
      })
      .catch((err: unknown) => setError(describeLoadFailure(err, 'Could not load monitored valuations.')));
  }, [token]);

  if (error) return <LoadError message={error} {...retryProps} />;
  if (!monitors) return <Spinner />;

  const attention = monitors.filter((m) => m.status !== 'green').length;

  return (
    <div>
      <div className="mb-6">
        <div className="flex items-center gap-2">
          <h1 className="font-display text-3xl font-semibold text-ink-900">Monitored valuations</h1>
          <HelpIcon article="monitoring-overview" className="h-6 w-6 text-sm" />
        </div>
        <p className="mt-1 text-sm text-ink-400">
          {monitors.length} monitored · {attention} need attention
        </p>
        {/* The count above is the page, not the platform. Saying so matters
            here more than on most lists: "3 need attention" reads as the whole
            answer, and an operator who trusts it stops looking. */}
        {truncated && (
          <p className="mt-1 text-sm text-ink-600">
            Showing the {monitors.length} most recently enabled monitors — more exist than are listed, and the
            attention count covers only these.
          </p>
        )}
      </div>

      {monitors.length === 0 ? (
        <EmptyState title="No valuations are being monitored">
          Enable monitoring from a completed valuation to track revaluation triggers here.
        </EmptyState>
      ) : (
        <div className="space-y-3">
          {monitors.map((m) => (
            <Link
              key={m.valuation_id}
              to={`/valuations/${m.valuation_id}/monitoring`}
              className="block rounded-lg border border-paper-300 bg-surface p-4 shadow-card hover:border-ink-300"
            >
              <div className="flex flex-wrap items-center gap-3">
                <span className="font-semibold text-ink-900">{m.company_name}</span>
                <KindBadge kind={m.kind as never} />
                <span
                  className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-semibold ring-1 ring-inset ${MONITOR_TONE[m.status]}`}
                >
                  <span
                    className={`h-1.5 w-1.5 rounded-full ${m.status === 'green' ? 'bg-bond-500' : m.status === 'yellow' ? 'bg-amber-500' : 'bg-red-500'}`}
                  />
                  {m.status}
                </span>
                {m.triggers.length > 0 && (
                  <span className="text-xs text-ink-500">
                    {m.triggers.length} trigger{m.triggers.length === 1 ? '' : 's'}
                  </span>
                )}
                {m.last_checked_at && (
                  <span className="tnum ml-auto text-xs text-ink-400">
                    checked {formatDateTime(m.last_checked_at)}
                  </span>
                )}
              </div>
              {m.triggers.length > 0 && (
                <ul className="mt-2 space-y-1 text-xs text-ink-600">
                  {m.triggers.slice(0, 3).map((t, i) => (
                    <li key={i}>• {t.message}</li>
                  ))}
                </ul>
              )}
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
