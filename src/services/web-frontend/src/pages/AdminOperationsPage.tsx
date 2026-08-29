import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import { useLatestOnly } from '../lib/useLatestOnly';
import { formatDateTime } from '../lib/format';
import {
  Button,
  EmptyState,
  ErrorNote,
  LoadError,
  LoadingBlock,
  SkeletonStatStrip,
  SkeletonTable,
  Spinner,
  StatCard,
  SuccessNote,
  useRetry,
} from '../components/ui';

/**
 * System health — the first minute of an incident, on one screen.
 *
 * Everything here was already served and had nowhere to land. `/admin/system/
 * metrics` says in its own docstring that it exists "for an operator who has
 * not yet been told what is wrong", `/admin/db/slow-queries` ranks the
 * statements the per-request `warn` lines only ever report one at a time, and
 * the webhook dead letter queue computes `replayable` per row precisely "so an
 * operator knows what a replay will actually do before running it". None of
 * the three had a caller: the only way to read any of them was curl with an
 * ops token, which is not a thing anybody does at 3am.
 *
 * Three sections in the order an incident is actually worked:
 *
 *   1. **Is it us?** Error rate, pool saturation, upstream breakers.
 *   2. **What is slow?** The ranked statement table.
 *   3. **What did we drop?** The webhook dead letter queue, with the bulk
 *      replay that is the remedy for an outage on our side.
 *
 * Not polled. Every other ops page here refreshes on a timer because it is
 * read while nothing is wrong; this one is read while something is, where a
 * number that moves under you as you read it is worse than a Refresh button.
 */

interface ErrorRateSnapshot {
  window_minutes: number;
  requests: number;
  client_errors: number;
  server_errors: number;
  error_rate: number;
  worst_routes: Array<{ route: string; requests: number; server_errors: number }>;
  routes_truncated: boolean;
}

interface PoolSnapshot {
  total: number;
  idle: number;
  waiting: number;
  max: number;
  checkedOut: number;
  saturation: number;
  suspectedLeaks: number;
  exhaustedForMs: number;
  oldestCheckoutMs: number;
  leaksDetected: number;
}

type CircuitState = 'closed' | 'open' | 'half_open';

interface CircuitSnapshot {
  name: string;
  state: CircuitState;
  consecutiveFailures: number;
  retryAfterMs: number;
  rejected: number;
  openedBy: string | null;
}

interface WebhookBacklog {
  pending: number;
  due: number;
  /**
   * Both settled counts are over a trailing window, not all time — the server
   * says how long a one in `window_hours`, and the hint below quotes it rather
   * than hard-coding a number that would drift the day the server changed it.
   */
  failed: number;
  delivered: number;
  window_hours: number;
}

interface SystemMetrics {
  service: string;
  build_sha: string | null;
  uptime_s: number;
  /**
   * Absent rather than zeroed when the hook was never installed — the route is
   * explicit about that, so "not measured" must not be drawn as "no errors".
   */
  error_rates: ErrorRateSnapshot | null;
  valuations: Record<string, number>;
  throughput: Array<{ week: string; count: number }>;
  webhooks: WebhookBacklog;
  pool: PoolSnapshot | null;
  circuits: CircuitSnapshot[];
}

interface QueryStat {
  fingerprint: string;
  count: number;
  totalMs: number;
  maxMs: number;
  slowCount: number;
  meanMs: number;
}

interface SlowQueries {
  instrumented: boolean;
  tracked: number;
  queries: QueryStat[];
}

interface FailedDelivery {
  id: string;
  webhook_id: string;
  partner_id: string;
  url: string;
  enabled: boolean;
  event_type: string;
  valuation_id: string | null;
  attempts: number;
  max_attempts: number;
  last_error: string | null;
  created_at: string;
  /** The server's own verdict on whether a replay would be accepted. */
  replayable: boolean;
}

const CIRCUIT_STYLES: Record<CircuitState, string> = {
  closed: 'bg-emerald-50 text-emerald-800 border-emerald-200',
  half_open: 'bg-amber-50 text-amber-800 border-amber-200',
  open: 'bg-red-50 text-red-700 border-red-200',
};

const CIRCUIT_TITLES: Record<CircuitState, string> = {
  closed: 'Calls are going through.',
  half_open: 'Trialling one call to see whether the upstream is back.',
  open: 'Calls are being refused without dialling. Nothing is reaching this upstream.',
};

/** Seconds → the coarse duration an operator reads, not a figure they parse. */
function uptime(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

function ms(value: number): string {
  if (value < 1000) return `${Math.round(value)} ms`;
  if (value < 60_000) return `${(value / 1000).toFixed(1)} s`;
  return `${Math.round(value / 60_000)} min`;
}

export function AdminOperationsPage() {
  const [metrics, setMetrics] = useState<SystemMetrics | null>(null);
  const [slow, setSlow] = useState<SlowQueries | null>(null);
  const [dlq, setDlq] = useState<FailedDelivery[] | null>(null);
  const [replayMaxAgeHours, setReplayMaxAgeHours] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<'replay' | 'sweep' | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const { token, retryProps } = useRetry(() => setError(null));

  // Refresh is a button here, but it is still a second request that can land
  // behind the first one a slow network reordered.
  const claim = useLatestOnly();

  const load = useCallback(async () => {
    const current = claim();
    try {
      const [system, queries, failed] = await Promise.all([
        api<SystemMetrics>('/admin/system/metrics'),
        api<SlowQueries>('/admin/db/slow-queries?limit=20'),
        api<{ deliveries: FailedDelivery[]; replay_max_age_hours: number }>(
          '/admin/webhooks/deliveries/failed?limit=100',
        ),
      ]);
      if (!current()) return;
      setMetrics(system);
      setSlow(queries);
      setDlq(failed.deliveries);
      setReplayMaxAgeHours(failed.replay_max_age_hours);
      // A row that is no longer in the listing must not stay ticked, or a
      // replay would be sent for a delivery the operator can no longer see.
      setSelected((prev) => new Set(failed.deliveries.filter((d) => prev.has(d.id)).map((d) => d.id)));
      setError(null);
    } catch (err) {
      if (!current()) return;
      setError(
        err instanceof ApiError && err.status === 403
          ? 'System health is operations-only.'
          : 'Could not load system health.',
      );
    }
  }, [claim]);

  useEffect(() => {
    void load();
  }, [load, token]);

  const replayable = (dlq ?? []).filter((d) => d.replayable);
  const chosen = [...selected];

  /**
   * Replay the ticked deliveries.
   *
   * Ids rather than "everything eligible": the route accepts both, and an
   * operator who has just read a page of failures has a set in mind. The reply
   * carries the ids it actually re-opened, so a partial match — the server
   * refusing a row that had aged out between the listing and the click — is
   * reported as the number it is rather than assumed to be what was asked for.
   */
  const replay = async () => {
    setBusy('replay');
    setNote(null);
    setActionError(null);
    try {
      const res = await api<{ replayed: number; ids: string[] }>('/admin/webhooks/deliveries/replay', {
        method: 'POST',
        body: { ids: chosen },
      });
      setNote(
        res.replayed === chosen.length
          ? `Re-queued ${res.replayed} deliver${res.replayed === 1 ? 'y' : 'ies'}.`
          : `Re-queued ${res.replayed} of the ${chosen.length} selected — the rest were refused as no longer eligible.`,
      );
      setSelected(new Set());
      await load();
    } catch (err) {
      setActionError(
        err instanceof ApiError && err.status === 403
          ? 'Replaying deliveries is operations-only.'
          : 'Could not replay the selected deliveries.',
      );
    } finally {
      setBusy(null);
    }
  };

  /** The retry sweep, now — the same pass the interval runs. */
  const sweep = async () => {
    setBusy('sweep');
    setNote(null);
    setActionError(null);
    try {
      const res = await api<{ attempted?: number; delivered?: number }>('/admin/webhooks/retry', {
        method: 'POST',
      });
      setNote(`Retry sweep ran — ${res.attempted ?? 0} attempted, ${res.delivered ?? 0} delivered.`);
      await load();
    } catch (err) {
      setActionError(
        err instanceof ApiError && err.status === 403
          ? 'Running the retry sweep is operations-only.'
          : 'Could not run the retry sweep.',
      );
    } finally {
      setBusy(null);
    }
  };

  if (!metrics) return error ? <LoadError message={error} {...retryProps} /> : <Spinner />;

  const rates = metrics.error_rates;
  const pool = metrics.pool;
  const openCircuits = metrics.circuits.filter((c) => c.state !== 'closed');

  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="overline text-ink-400">Operations</div>
          <h1 className="mt-1 font-display text-3xl font-semibold text-ink-900">System health</h1>
          <p className="mt-1 max-w-3xl text-sm text-ink-400">
            Error rates, connection pool, upstream breakers, the slowest statements this build has run, and
            the webhook deliveries that gave up. Read on demand rather than polled — a figure that moves while
            you are reading it is the wrong thing to hand somebody mid-incident.
          </p>
        </div>
        <Button variant="secondary" onClick={() => void load()}>
          Refresh
        </Button>
      </div>

      {error && (
        <div className="mt-4">
          <ErrorNote>{error}</ErrorNote>
        </div>
      )}

      <p className="mt-4 text-xs text-ink-400">
        <span className="font-semibold text-ink-500">{metrics.service}</span> · build{' '}
        <span className="font-mono">{metrics.build_sha ?? 'unknown'}</span> · up {uptime(metrics.uptime_s)}
      </p>

      {/* ── 1. Is it us? ─────────────────────────────────────────────────── */}
      <section className="mt-6" aria-label="Error rates and capacity">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <StatCard
            label={rates ? `5xx rate (${rates.window_minutes}m)` : '5xx rate'}
            accent={Boolean(rates && rates.error_rate > 0)}
            // Never "0.0%" when nothing was measured: the route returns null
            // rather than a zeroed snapshot exactly so a wiring mistake reads
            // as "not measured" instead of "no errors".
            value={rates ? `${(rates.error_rate * 100).toFixed(2)}%` : 'Not measured'}
            hint={
              rates
                ? `${rates.server_errors} of ${rates.requests} requests · ${rates.client_errors} 4xx`
                : 'The HTTP metrics hook is not installed on this process.'
            }
          />
          <StatCard
            label="Pool saturation"
            value={pool ? `${Math.round(pool.saturation * 100)}%` : 'Not monitored'}
            hint={
              pool
                ? `${pool.checkedOut} of ${pool.max} checked out · ${pool.waiting} waiting`
                : 'Pool instrumentation is not wired on this process.'
            }
          />
          <StatCard
            label="Suspected leaks"
            value={pool ? String(pool.suspectedLeaks) : '—'}
            hint={
              pool
                ? `Oldest checkout ${ms(pool.oldestCheckoutMs)} · ${pool.leaksDetected} reported since boot`
                : undefined
            }
          />
          <StatCard
            label="Webhook backlog"
            value={String(metrics.webhooks.pending)}
            hint={`${metrics.webhooks.due} due now · ${metrics.webhooks.failed} failed · ${metrics.webhooks.delivered} delivered · last ${metrics.webhooks.window_hours}h`}
          />
        </div>

        <div className="mt-4 rounded-lg border border-paper-300 bg-surface p-5 shadow-card">
          <h2 className="overline text-ink-400">Upstream circuits</h2>
          {metrics.circuits.length === 0 ? (
            <p className="mt-2 text-sm text-ink-400">No upstream breaker has been exercised yet.</p>
          ) : (
            <>
              <ul className="mt-3 flex flex-wrap gap-2">
                {metrics.circuits.map((c) => (
                  <li key={c.name}>
                    <span
                      title={CIRCUIT_TITLES[c.state]}
                      className={`inline-block rounded-full border px-2.5 py-0.5 text-xs font-semibold ${CIRCUIT_STYLES[c.state]}`}
                    >
                      {c.name} · {c.state.replace('_', ' ')}
                    </span>
                  </li>
                ))}
              </ul>
              {openCircuits.length > 0 && (
                <ul className="mt-3 space-y-1">
                  {openCircuits.map((c) => (
                    <li key={c.name} className="text-xs text-ink-500">
                      <span className="font-semibold text-ink-700">{c.name}</span> — opened by{' '}
                      {c.openedBy ?? 'an unnamed failure'} after {c.consecutiveFailures} failures,{' '}
                      {c.rejected} calls refused, next trial in {ms(c.retryAfterMs)}.
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </div>

        {rates && rates.worst_routes.length > 0 && (
          <div className="mt-4 rounded-lg border border-paper-300 bg-surface p-5 shadow-card">
            <h2 className="overline text-ink-400">Worst routes</h2>
            <div className="mt-3 overflow-x-auto overscroll-x-contain">
              <table className="w-full min-w-[520px] text-sm" aria-label="Routes by server errors">
                <thead>
                  <tr className="border-b border-paper-300 text-left">
                    <th className="overline px-2 py-2 font-semibold text-ink-400">Route</th>
                    <th className="overline px-2 py-2 text-right font-semibold text-ink-400">Requests</th>
                    <th className="overline px-2 py-2 text-right font-semibold text-ink-400">5xx</th>
                  </tr>
                </thead>
                <tbody>
                  {rates.worst_routes.map((r) => (
                    <tr key={r.route} className="border-b border-paper-200 last:border-0">
                      <td className="px-2 py-2 font-mono text-xs text-ink-600">{r.route}</td>
                      <td className="tnum px-2 py-2 text-right text-ink-600">{r.requests}</td>
                      <td className="tnum px-2 py-2 text-right text-ink-600">{r.server_errors}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {rates.routes_truncated && (
              <p className="mt-2 text-xs text-ink-500" data-testid="list-truncated">
                The route table hit its cap, so these are the worst of what was tracked rather than of every
                route served.
              </p>
            )}
          </div>
        )}
      </section>

      {/* ── 2. What is slow? ─────────────────────────────────────────────── */}
      <section className="mt-10" aria-label="Slowest statements">
        <h2 className="font-display text-xl font-semibold text-ink-900">Slowest statements</h2>
        <p className="mt-1 max-w-3xl text-sm text-ink-500">
          Ranked by total time, not by the worst single run — a 40ms query run 900 times costs more than one
          that took four seconds once. Process-local and reset on deploy, so this is the build that is running
          now.
        </p>
        {!slow ? (
          <div className="mt-4">
            <LoadingBlock label="Loading slow statements…">
              <SkeletonTable columns={5} rows={5} />
            </LoadingBlock>
          </div>
        ) : !slow.instrumented ? (
          <div className="mt-4">
            <EmptyState title="Statement timing is not instrumented">
              This process was started without query instrumentation, so there is nothing to rank.
            </EmptyState>
          </div>
        ) : slow.queries.length === 0 ? (
          <div className="mt-4">
            <EmptyState title="Nothing recorded yet">
              No statement has run since this build started.
            </EmptyState>
          </div>
        ) : (
          <div className="mt-4 overflow-x-auto overscroll-x-contain rounded-lg border border-paper-300 bg-surface shadow-card">
            <table className="w-full min-w-[760px] text-sm" aria-label="Slowest statements">
              <thead>
                <tr className="border-b border-paper-300 text-left">
                  <th className="overline px-5 py-3 font-semibold text-ink-400">Statement</th>
                  <th className="overline px-4 py-3 text-right font-semibold text-ink-400">Runs</th>
                  <th className="overline px-4 py-3 text-right font-semibold text-ink-400">Total</th>
                  <th className="overline px-4 py-3 text-right font-semibold text-ink-400">Mean</th>
                  <th className="overline px-4 py-3 text-right font-semibold text-ink-400">Worst</th>
                </tr>
              </thead>
              <tbody>
                {slow.queries.map((q) => (
                  <tr key={q.fingerprint} className="border-b border-paper-200 align-top last:border-0">
                    <td className="max-w-[28rem] px-5 py-3 font-mono text-xs text-ink-600">
                      <span className="line-clamp-2" title={q.fingerprint}>
                        {q.fingerprint}
                      </span>
                      {q.slowCount > 0 && (
                        <span className="mt-1 block text-ink-400">{q.slowCount} over the slow threshold</span>
                      )}
                    </td>
                    <td className="tnum px-4 py-3 text-right text-ink-600">{q.count}</td>
                    <td className="tnum px-4 py-3 text-right text-ink-900">{ms(q.totalMs)}</td>
                    <td className="tnum px-4 py-3 text-right text-ink-600">{ms(q.meanMs)}</td>
                    <td className="tnum px-4 py-3 text-right text-ink-600">{ms(q.maxMs)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {slow?.instrumented && (
          <p className="mt-2 text-xs text-ink-400">
            {slow.tracked} distinct statements tracked; the {slow.queries.length} worst are shown.
          </p>
        )}
      </section>

      {/* ── 3. What did we drop? ─────────────────────────────────────────── */}
      <section className="mt-10" aria-label="Webhook dead letter queue">
        <h2 className="font-display text-xl font-semibold text-ink-900">Webhook dead letter queue</h2>
        <p className="mt-1 max-w-3xl text-sm text-ink-500">
          Deliveries that gave up. A failed row is terminal — nothing but a replay brings it back. Rows the
          server will refuse are marked: too old
          {replayMaxAgeHours !== null ? ` (over ${replayMaxAgeHours}h)` : ''}, retired before retries existed,
          or on an endpoint the partner has disabled.
        </p>

        {note && (
          <div className="mt-4">
            <SuccessNote>{note}</SuccessNote>
          </div>
        )}
        {actionError && (
          <div className="mt-4">
            <ErrorNote>{actionError}</ErrorNote>
          </div>
        )}

        <div className="mt-4 flex flex-wrap items-center gap-3">
          <Button
            disabled={busy !== null || chosen.length === 0}
            title={
              chosen.length === 0
                ? 'Tick the deliveries to replay. Only rows the server will accept can be ticked.'
                : undefined
            }
            onClick={() => void replay()}
          >
            {busy === 'replay'
              ? 'Replaying…'
              : `Replay ${chosen.length} deliver${chosen.length === 1 ? 'y' : 'ies'}`}
          </Button>
          <button
            type="button"
            disabled={replayable.length === 0}
            title={
              replayable.length === 0
                ? 'Every failed delivery here is one the server would refuse to replay.'
                : 'Tick every row the server would accept.'
            }
            onClick={() => setSelected(new Set(replayable.map((d) => d.id)))}
            className="tap-area cursor-pointer text-sm font-semibold text-bond-600 hover:text-bond-700 disabled:cursor-not-allowed disabled:text-ink-300"
          >
            Select every replayable row ({replayable.length})
          </button>
          {/* The pending queue's own sweep, not the dead letter queue's: this
              moves rows that are still retrying, which is the other half of
              "nothing is getting through". */}
          <Button
            variant="secondary"
            disabled={busy !== null}
            title="Run the pending-delivery retry sweep now instead of waiting for the interval."
            onClick={() => void sweep()}
          >
            {busy === 'sweep' ? 'Sweeping…' : 'Run retry sweep'}
          </Button>
        </div>

        {!dlq ? (
          <div className="mt-4">
            <LoadingBlock label="Loading failed deliveries…">
              <SkeletonTable columns={6} rows={5} />
            </LoadingBlock>
          </div>
        ) : dlq.length === 0 ? (
          <div className="mt-4">
            <EmptyState title="Nothing has been dropped">
              Every partner webhook delivery has either landed or is still retrying.
            </EmptyState>
          </div>
        ) : (
          <div className="mt-4 overflow-x-auto overscroll-x-contain rounded-lg border border-paper-300 bg-surface shadow-card">
            <table className="w-full min-w-[900px] text-sm" aria-label="Failed webhook deliveries">
              <thead>
                <tr className="border-b border-paper-300 text-left">
                  <th className="overline px-5 py-3 font-semibold text-ink-400">
                    <span className="sr-only">Select</span>
                  </th>
                  <th className="overline px-4 py-3 font-semibold text-ink-400">Event</th>
                  <th className="overline px-4 py-3 font-semibold text-ink-400">Endpoint</th>
                  <th className="overline px-4 py-3 font-semibold text-ink-400">Failed with</th>
                  <th className="overline px-4 py-3 text-right font-semibold text-ink-400">Attempts</th>
                  <th className="overline px-4 py-3 font-semibold text-ink-400">Queued</th>
                </tr>
              </thead>
              <tbody>
                {dlq.map((d) => (
                  <tr key={d.id} className="border-b border-paper-200 align-top last:border-0">
                    <td className="px-5 py-3.5">
                      <input
                        type="checkbox"
                        className="tap-area h-4 w-4 cursor-pointer accent-bond-600 disabled:cursor-not-allowed"
                        checked={selected.has(d.id)}
                        disabled={!d.replayable}
                        // The server computed this verdict; the tooltip is the
                        // only place it reaches the person clicking.
                        title={
                          d.replayable
                            ? 'Select for replay'
                            : d.enabled
                              ? 'The server will refuse this one — it is past the replay window, or it predates delivery retries.'
                              : 'The partner has disabled this endpoint, so a replay would be refused.'
                        }
                        aria-label={`Select the ${d.event_type} delivery to ${d.url}`}
                        onChange={(e) =>
                          setSelected((prev) => {
                            const next = new Set(prev);
                            if (e.target.checked) next.add(d.id);
                            else next.delete(d.id);
                            return next;
                          })
                        }
                      />
                    </td>
                    <td className="px-4 py-3.5">
                      <span className="font-mono text-xs text-ink-700">{d.event_type}</span>
                      {d.valuation_id && (
                        <div className="mt-1">
                          <Link
                            to={`/valuations/${d.valuation_id}`}
                            className="text-xs font-semibold text-bond-600 hover:text-bond-700"
                          >
                            View valuation →
                          </Link>
                        </div>
                      )}
                    </td>
                    <td className="max-w-64 px-4 py-3.5">
                      <div className="truncate font-mono text-xs text-ink-600" title={d.url}>
                        {d.url}
                      </div>
                      <Link
                        to={`/admin/partners/${d.partner_id}`}
                        className="mt-1 block text-xs font-semibold text-bond-600 hover:text-bond-700"
                      >
                        {d.partner_id} →
                      </Link>
                      {!d.enabled && (
                        <span className="mt-1 inline-block rounded-full border border-paper-300 bg-paper-200 px-2 py-0.5 text-xs font-semibold text-ink-600">
                          endpoint disabled
                        </span>
                      )}
                    </td>
                    <td className="max-w-64 px-4 py-3.5 text-xs text-red-600">
                      <span className="line-clamp-2" title={d.last_error ?? undefined}>
                        {d.last_error ?? '—'}
                      </span>
                    </td>
                    <td className="tnum px-4 py-3.5 text-right text-ink-600">
                      {d.attempts}/{d.max_attempts}
                    </td>
                    <td className="tnum px-4 py-3.5 text-ink-600">{formatDateTime(d.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Loaded with the page, so a skeleton here would only ever flash — kept
          for the case where the metrics arrive first on a slow link. */}
      {!slow && !dlq && <SkeletonStatStrip count={4} className="mt-6" />}
    </div>
  );
}
