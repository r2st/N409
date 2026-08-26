import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import { useLatestOnly } from '../lib/useLatestOnly';
import { formatDateTime } from '../lib/format';
import {
  Button,
  EmptyState,
  ErrorNote,
  Pagination,
  ResultCount,
  Spinner,
  StatCard,
  pageCountOf,
} from '../components/ui';

/**
 * The background job monitor (409.ai's Published Tasks page).
 *
 * Five queues that each invented their own words for the same four outcomes,
 * read as one feed. Each row shows both: the common status it was normalised
 * to, and — where they differ — the queue's own word for it, because
 * "extracting" is genuinely more informative than "running" once you have
 * found the row you were looking for.
 *
 * Read-only by design. Each queue already has its own retry path that knows
 * what re-running that kind of work means; a generic button here would have to
 * guess, and guessing wrong on an outbox row sends a client a second copy of
 * an email.
 */

type JobSource = 'pipeline_run' | 'ai_job' | 'calculation' | 'email' | 'webhook_delivery';
type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'skipped';

interface Job {
  id: string;
  source: JobSource;
  status: JobStatus;
  detail: string;
  name: string;
  valuation_id: string | null;
  valuation_number: string | null;
  company_name: string | null;
  error: string | null;
  attempts: number | null;
  created_at: string;
  /** Earliest moment a worker may take this row — the retry ladder's next step. */
  due_at: string;
  finished_at: string | null;
  duration_ms: number | null;
}

interface JobStats {
  since_hours: number;
  totals: { active: number; failed: number; succeeded: number; skipped: number };
  by_source: Array<{
    source: JobSource;
    label: string;
    active: number;
    failed: number;
    succeeded: number;
    skipped: number;
    oldest_active_at: string | null;
  }>;
}

type AlertKind = 'stalled' | 'failing';

interface JobAlert {
  id: string;
  source: JobSource;
  kind: AlertKind;
  detail: string;
  observed: number;
  threshold: number;
  opened_at: string;
  last_seen_at: string;
  resolved_at: string | null;
}

interface JobAlertRule {
  source: JobSource;
  enabled: boolean;
  stall_minutes: number;
  failure_count: number;
  failure_window_hours: number;
}

interface JobAlertsResponse {
  alerts: JobAlert[];
  rules: JobAlertRule[];
  open: number;
}

const SOURCE_LABELS: Record<JobSource, string> = {
  pipeline_run: 'Pipeline run',
  ai_job: 'AI job',
  calculation: 'Calculation',
  email: 'Outbound message',
  webhook_delivery: 'Webhook delivery',
};

const STATUS_STYLES: Record<JobStatus, string> = {
  queued: 'bg-amber-50 text-amber-800 border-amber-200',
  running: 'bg-bond-50 text-bond-800 border-bond-200',
  succeeded: 'bg-emerald-50 text-emerald-800 border-emerald-200',
  failed: 'bg-red-50 text-red-700 border-red-200',
  skipped: 'bg-paper-200 text-ink-600 border-paper-300',
};

const PER_PAGE = 25;

/** ms → a duration a person reads at a glance, not a figure they parse. */
function duration(ms: number | null): string {
  if (ms === null) return '—';
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

/** How long the oldest outstanding item has been waiting. */
function waitingFor(iso: string | null): string {
  if (!iso) return '—';
  return duration(Date.now() - new Date(iso).getTime());
}

/**
 * How long until a queued row becomes claimable, or null if it already is.
 *
 * An outbox row and a webhook delivery both spend their retry ladder sitting at
 * the status they arrived at, so a backlog of deliveries backing off politely
 * and a queue whose worker has died look identical on this page. They need
 * opposite responses, and the difference is only ever this one field.
 */
function retryDueIn(job: Job): string | null {
  if (job.status !== 'queued') return null;
  const ms = new Date(job.due_at).getTime() - Date.now();
  return ms > 0 ? duration(ms) : null;
}

function StatusBadge({ job }: { job: Job }) {
  // The queue's own word is shown alongside only when it says more than the
  // normalised one — otherwise it is the same string twice.
  const showsDetail = job.detail !== job.status;
  const dueIn = retryDueIn(job);
  return (
    <span className="inline-flex items-center gap-1.5">
      <span
        className={`inline-block rounded-full border px-2.5 py-0.5 text-xs font-semibold ${STATUS_STYLES[job.status]}`}
      >
        {job.status[0]!.toUpperCase() + job.status.slice(1)}
      </span>
      {showsDetail && <span className="text-xs text-ink-400">{job.detail}</span>}
      {dueIn && (
        <span className="text-xs text-ink-400" title="Waiting out its retry backoff — not stuck.">
          retry in {dueIn}
        </span>
      )}
    </span>
  );
}

export function AdminJobsPage() {
  const [jobs, setJobs] = useState<Job[] | null>(null);
  const [total, setTotal] = useState(0);
  const [stats, setStats] = useState<JobStats | null>(null);
  const [alerts, setAlerts] = useState<JobAlertsResponse | null>(null);
  const [scanning, setScanning] = useState(false);
  const [source, setSource] = useState<'all' | JobSource>('all');
  const [status, setStatus] = useState<'all' | JobStatus>('all');
  const [page, setPage] = useState(1);
  const [error, setError] = useState<string | null>(null);

  /*
   * Two loads overlap here more readily than anywhere else on the platform,
   * because one of them is not the reader's: the fifteen-second poll below
   * keeps a request in flight whether or not anybody touched a control. Change
   * the source filter while a poll is outstanding and the poll's reply — the
   * previous filter's jobs, with the previous filter's total — lands last and
   * repaints the table under the new filter, where it stays until the next
   * poll happens to correct it. See `useLatestOnly`.
   */
  const claim = useLatestOnly();

  const load = useCallback(async () => {
    const current = claim();
    const params = new URLSearchParams({ page: String(page), per_page: String(PER_PAGE) });
    if (source !== 'all') params.set('source', source);
    if (status !== 'all') params.set('status', status);
    try {
      const [list, summary, alerting] = await Promise.all([
        api<{ jobs: Job[]; total: number }>(`/admin/jobs?${params}`),
        api<JobStats>('/admin/jobs/stats'),
        api<JobAlertsResponse>('/admin/jobs/alerts?limit=20'),
      ]);
      if (!current()) return;
      setJobs(list.jobs);
      setTotal(list.total);
      setStats(summary);
      setAlerts(alerting);
      setError(null);
    } catch (err) {
      if (!current()) return;
      setError(
        err instanceof ApiError && err.status === 403
          ? 'The job monitor is operations-only.'
          : 'Could not load background jobs.',
      );
    }
  }, [source, status, page, claim]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    setPage(1);
  }, [source, status]);

  // A job page that does not move is indistinguishable from a queue that has
  // stopped, which is the one thing it exists to tell you apart.
  useEffect(() => {
    const timer = setInterval(() => void load(), 15_000);
    return () => clearInterval(timer);
  }, [load]);

  if (error && !jobs) return <ErrorNote>{error}</ErrorNote>;
  if (!jobs || !stats) return <Spinner />;

  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="overline text-ink-400">Operations</div>
          <h1 className="mt-1 font-display text-3xl font-semibold text-ink-900">Background jobs</h1>
          <p className="mt-1 text-sm text-ink-400">
            Pipeline runs, AI jobs, engine calculations, outbound messages and webhook deliveries — one feed.
            Refreshes every 15 seconds.
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="secondary" onClick={() => void load()}>
            Refresh
          </Button>
          {/* Re-evaluate now, for an operator who has just restarted something
              and does not want to wait out the five-minute sweep. */}
          <Button
            variant="secondary"
            disabled={scanning}
            onClick={async () => {
              setScanning(true);
              try {
                await api('/admin/jobs/alerts/scan', { method: 'POST' });
                await load();
              } catch {
                setError('Could not re-check the queues.');
              } finally {
                setScanning(false);
              }
            }}
          >
            {scanning ? 'Checking…' : 'Check queues now'}
          </Button>
        </div>
      </div>

      {/* ── Alerts (design §17.1 item 13) ────────────────────────────────────
          The monitor reported and nothing alerted. An open alert goes above
          every count on the page: the counts are what an operator reads when
          they have come looking, and this is what should have found them. */}
      {alerts && alerts.open > 0 && (
        <div className="mt-6 space-y-3">
          {alerts.alerts
            .filter((a) => a.resolved_at === null)
            .map((alert) => (
              <div
                key={alert.id}
                className={`rounded-lg border px-5 py-4 ${
                  alert.kind === 'stalled' ? 'border-red-200 bg-red-50' : 'border-amber-200 bg-amber-50'
                }`}
                role="alert"
              >
                <div className="flex flex-wrap items-baseline justify-between gap-3">
                  <span className="font-semibold text-ink-900">
                    {SOURCE_LABELS[alert.source]} — {alert.kind === 'stalled' ? 'stalled' : 'failing'}
                  </span>
                  <span className="text-xs text-ink-500">Since {formatDateTime(alert.opened_at)}</span>
                </div>
                <p className="mt-1 text-sm text-ink-700">{alert.detail}</p>
              </div>
            ))}
        </div>
      )}

      {alerts && alerts.open === 0 && (
        <p className="mt-6 rounded-lg border border-paper-300 bg-surface px-5 py-3 text-sm text-ink-500">
          No queue alerts open. Thresholds:{' '}
          {alerts.rules
            .filter((r) => r.enabled)
            .map((r) => `${SOURCE_LABELS[r.source]} ${r.stall_minutes}m / ${r.failure_count} failures`)
            .join(' · ')}
        </p>
      )}

      <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Outstanding" value={String(stats.totals.active)} />
        <StatCard label={`Failed (${stats.since_hours}h)`} value={String(stats.totals.failed)} />
        <StatCard label={`Succeeded (${stats.since_hours}h)`} value={String(stats.totals.succeeded)} />
        {/* Not a failure and not a success: a message is skipped when the
            recipient's notification preferences say not to send it. */}
        <StatCard label={`Skipped (${stats.since_hours}h)`} value={String(stats.totals.skipped)} />
      </div>

      <div className="mt-6 overflow-x-auto overscroll-x-contain rounded-lg border border-paper-300 bg-surface shadow-card">
        <table className="w-full min-w-[720px] text-sm" aria-label="Queue health">
          <thead>
            <tr className="border-b border-paper-300 text-left">
              <th className="overline px-5 py-3 font-semibold text-ink-400">Queue</th>
              <th className="overline px-4 py-3 text-right font-semibold text-ink-400">Outstanding</th>
              <th className="overline px-4 py-3 text-right font-semibold text-ink-400">Failed</th>
              <th className="overline px-4 py-3 text-right font-semibold text-ink-400">Succeeded</th>
              {/* A count cannot tell a busy queue from a stopped one; the age
                  of the oldest outstanding item can. */}
              <th className="overline px-4 py-3 font-semibold text-ink-400">Oldest waiting</th>
            </tr>
          </thead>
          <tbody>
            {stats.by_source.map((row) => (
              <tr key={row.source} className="border-b border-paper-200 last:border-0">
                <td className="px-5 py-2.5 font-semibold text-ink-800">{row.label}</td>
                <td className="tnum px-4 py-2.5 text-right text-ink-600">{row.active}</td>
                <td
                  className={`tnum px-4 py-2.5 text-right ${row.failed > 0 ? 'text-red-700' : 'text-ink-600'}`}
                >
                  {row.failed}
                </td>
                <td className="tnum px-4 py-2.5 text-right text-ink-600">{row.succeeded}</td>
                <td className="px-4 py-2.5 text-ink-500">{waitingFor(row.oldest_active_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="mt-6 flex flex-wrap gap-2">
        {(['all', 'queued', 'running', 'failed', 'succeeded', 'skipped'] as const).map((s) => (
          <button
            key={s}
            onClick={() => setStatus(s)}
            aria-pressed={status === s}
            className={`tap-area cursor-pointer rounded-full px-3.5 py-1.5 text-xs font-semibold transition-colors ${
              status === s
                ? 'bg-ink-900 text-paper-50'
                : 'border border-ink-200 bg-surface text-ink-600 hover:border-ink-400'
            }`}
          >
            {s[0]!.toUpperCase() + s.slice(1)}
          </button>
        ))}
        <select
          value={source}
          onChange={(e) => setSource(e.target.value as typeof source)}
          aria-label="Filter by queue"
          className="ml-auto cursor-pointer rounded-md border border-ink-200 bg-surface px-3 py-1.5 text-xs font-semibold text-ink-600"
        >
          <option value="all">All queues</option>
          {(Object.keys(SOURCE_LABELS) as JobSource[]).map((s) => (
            <option key={s} value={s}>
              {SOURCE_LABELS[s]}
            </option>
          ))}
        </select>
        <ResultCount count={total} noun="job" />
      </div>

      {error && (
        <div className="mt-4">
          <ErrorNote>{error}</ErrorNote>
        </div>
      )}

      {jobs.length === 0 ? (
        <div className="mt-6">
          <EmptyState title="No matching jobs">
            Background work appears here as it is queued, run and finished.
          </EmptyState>
        </div>
      ) : (
        <div className="mt-6 overflow-x-auto overscroll-x-contain rounded-lg border border-paper-300 bg-surface shadow-card">
          <table className="w-full min-w-[960px] text-sm" aria-label="Background jobs">
            <thead>
              <tr className="border-b border-paper-300 text-left">
                <th className="overline px-5 py-3 font-semibold text-ink-400">Queue</th>
                <th className="overline px-4 py-3 font-semibold text-ink-400">Work</th>
                <th className="overline px-4 py-3 font-semibold text-ink-400">Engagement</th>
                <th className="overline px-4 py-3 font-semibold text-ink-400">Status</th>
                <th className="overline px-4 py-3 text-right font-semibold text-ink-400">Attempts</th>
                <th className="overline px-4 py-3 font-semibold text-ink-400">Started</th>
                <th className="overline px-4 py-3 font-semibold text-ink-400">Took</th>
              </tr>
            </thead>
            <tbody>
              {jobs.map((job) => (
                <tr key={`${job.source}:${job.id}`} className="border-b border-paper-200 last:border-0">
                  <td className="px-5 py-3 text-ink-500">{SOURCE_LABELS[job.source]}</td>
                  <td className="px-4 py-3">
                    <span className="font-semibold text-ink-800">{job.name}</span>
                    {job.error && (
                      <div className="mt-0.5 max-w-md truncate text-xs text-red-700" title={job.error}>
                        {job.error}
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    {job.valuation_id ? (
                      <Link
                        to={`/valuations/${job.valuation_id}`}
                        className="text-bond-700 hover:text-bond-900"
                      >
                        {job.company_name ?? job.valuation_number}
                      </Link>
                    ) : (
                      <span className="text-ink-400">—</span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <StatusBadge job={job} />
                  </td>
                  <td className="tnum px-4 py-3 text-right text-ink-500">{job.attempts ?? '—'}</td>
                  <td className="px-4 py-3 text-ink-500">{formatDateTime(job.created_at)}</td>
                  <td className="px-4 py-3 text-ink-500">{duration(job.duration_ms)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Pagination page={page} pageCount={pageCountOf(total, PER_PAGE)} onPage={setPage} className="mt-6" />
    </div>
  );
}
