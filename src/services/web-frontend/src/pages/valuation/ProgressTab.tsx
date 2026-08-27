import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError } from '../../lib/api';
import { filenameStem, useDownload } from '../../lib/useDownload';
import { formatDate, formatDateTime } from '../../lib/format';
import { useWorkspace } from './ValuationWorkspace';
import { ErrorNote, LoadingBlock, Skeleton, SkeletonStatStrip, SkeletonText } from '../../components/ui';

interface ProgressStage {
  key: string;
  label: string;
  description: string;
  status: 'done' | 'current' | 'upcoming';
  entered_at: string | null;
  duration_days: number | null;
  typical_days: number;
}

interface ChecklistItem {
  kind: string;
  label: string;
  uploaded: boolean;
  count: number;
}

interface TimelineEntry {
  type: string;
  label: string;
  detail: string | null;
  occurred_at: string;
}

interface NextAction {
  key: string;
  label: string;
  detail: string;
  tab: string | null;
  client_action_required: boolean;
}

interface ProgressResponse {
  state: string;
  halted: boolean;
  waiting_on_client: boolean;
  percent_complete: number;
  next_action: NextAction;
  estimated_delivery_at: string | null;
  days_in_progress: number;
  last_activity_at: string | null;
  stages: ProgressStage[];
  checklist: ChecklistItem[];
  documents_uploaded: number;
  documents_missing: number;
  report: { available: boolean };
  explanation: { available: boolean };
  timeline: TimelineEntry[];
}

/** Headline bar: one number for "how far along am I?". */
function CompletionBar({ percent, halted }: { percent: number; halted: boolean }) {
  return (
    <div data-testid="progress-bar">
      <div className="mb-1.5 flex items-baseline justify-between">
        <span className="overline text-ink-400">Overall progress</span>
        <span className="tnum text-sm font-semibold text-ink-800">{percent}%</span>
      </div>
      <div
        role="progressbar"
        aria-valuenow={percent}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label="Overall progress"
        className="h-2 w-full overflow-hidden rounded-full bg-paper-200"
      >
        <div
          className={`h-full rounded-full transition-[width] duration-500 ${
            halted ? 'bg-ink-300' : 'bg-bond-600'
          }`}
          style={{ width: `${percent}%` }}
        />
      </div>
    </div>
  );
}

/** The one thing the client should do next, with a link to the right tab. */
function NextActionCard({ action, base }: { action: NextAction; base: string }) {
  const attention = action.client_action_required;
  return (
    <div
      data-testid="next-action"
      className={`rounded-lg border p-5 ${
        attention ? 'border-amber-200 bg-amber-50' : 'border-paper-300 bg-surface'
      }`}
    >
      <p className="overline mb-1 text-ink-400">Next step</p>
      <p className={`text-sm font-semibold ${attention ? 'text-amber-900' : 'text-ink-900'}`}>
        {action.label}
      </p>
      <p className={`mt-1 text-sm ${attention ? 'text-amber-800' : 'text-ink-500'}`}>{action.detail}</p>
      {action.tab && (
        <Link
          to={`${base}/${action.tab}`}
          className="mt-3 inline-block text-sm font-semibold text-bond-700 underline underline-offset-2 hover:text-bond-800"
        >
          Go to {action.tab}
        </Link>
      )}
    </div>
  );
}

function StageStepper({ stages }: { stages: ProgressStage[] }) {
  return (
    <ol className="grid gap-3 sm:grid-cols-5" data-testid="progress-stepper">
      {stages.map((stage, index) => (
        <li
          key={stage.key}
          aria-current={stage.status === 'current' ? 'step' : undefined}
          className={`rounded-lg border p-4 ${
            stage.status === 'current'
              ? 'border-bond-300 bg-bond-50'
              : stage.status === 'done'
                ? 'border-emerald-200 bg-emerald-50/60'
                : 'border-paper-300 bg-surface'
          }`}
        >
          <div className="flex items-center gap-2">
            <span
              className={`flex h-5 w-5 items-center justify-center rounded-full text-[11px] font-bold ${
                stage.status === 'done'
                  ? 'bg-emerald-700 text-bond-fg'
                  : stage.status === 'current'
                    ? 'bg-bond-600 text-bond-fg'
                    : 'bg-paper-200 text-ink-500'
              }`}
            >
              {stage.status === 'done' ? '✓' : index + 1}
            </span>
            <span className="text-sm font-semibold text-ink-900">{stage.label}</span>
          </div>
          <p className="mt-2 text-xs leading-relaxed text-ink-500">{stage.description}</p>
          {stage.entered_at && (
            <p className="tnum mt-2 text-[11px] text-ink-400">{formatDateTime(stage.entered_at)}</p>
          )}
          {stage.duration_days !== null && stage.status !== 'upcoming' && (
            <p className="tnum text-[11px] text-ink-400">
              {stage.duration_days} day{stage.duration_days === 1 ? '' : 's'}
              {stage.status === 'current' && stage.duration_days > stage.typical_days && (
                <span className="ml-1 font-semibold text-amber-700">
                  · longer than usual ({stage.typical_days}d)
                </span>
              )}
            </p>
          )}
        </li>
      ))}
    </ol>
  );
}

/**
 * Client self-service progress tracker (IMPROVEMENTS_RESEARCH §5.6): where the
 * valuation stands, which documents are still needed, and the client-safe
 * timeline — the answers that otherwise arrive by email.
 */
export function ProgressTab() {
  const { valuation } = useWorkspace();
  const [progress, setProgress] = useState<ProgressResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Separate from `error`, which replaces the whole tab: a download that failed
  // is no reason to take the progress the client came here to read away.
  const download = useDownload();

  useEffect(() => {
    void (async () => {
      try {
        setProgress(await api<ProgressResponse>(`/valuations/${valuation.id}/progress`));
      } catch (err) {
        setError(err instanceof ApiError ? err.message : 'Could not load progress.');
      }
    })();
  }, [valuation.id]);

  if (error) return <ErrorNote>{error}</ErrorNote>;
  if (!progress)
    return (
      <LoadingBlock label="Loading progress…" className="space-y-8">
        <div className="grid gap-6 lg:grid-cols-[2fr_1fr] lg:items-start">
          <div className="space-y-5" aria-hidden>
            <Skeleton className="h-3 w-full rounded-full" />
            <SkeletonStatStrip count={3} className="sm:grid-cols-3" />
          </div>
          <Skeleton className="h-32 w-full rounded-lg" />
        </div>
        <Skeleton className="h-16 w-full rounded-lg" />
        <div className="grid gap-8 lg:grid-cols-2">
          {Array.from({ length: 2 }, (_, i) => (
            <div
              key={i}
              className="rounded-lg border border-paper-300 bg-surface p-6 shadow-card"
              aria-hidden
            >
              <Skeleton className="h-2.5 w-36" />
              <SkeletonText lines={5} className="mt-4" />
            </div>
          ))}
        </div>
      </LoadingBlock>
    );

  const missing = progress.checklist.filter((c) => !c.uploaded);
  const base = `/valuations/${valuation.id}`;

  return (
    <div className="space-y-8">
      {progress.halted && (
        <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          This valuation is not progressing (state: {progress.state}). Contact support if this is unexpected.
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-[2fr_1fr] lg:items-start">
        <div className="space-y-5">
          <CompletionBar percent={progress.percent_complete} halted={progress.halted} />
          {/* Matches the skeleton above (grid-cols-2 sm:grid-cols-3): a bare
              grid-cols-3 crushed three date labels into ~95px each on a phone,
              and reflowed the strip the moment the data replaced the skeleton. */}
          <dl className="grid grid-cols-2 gap-4 sm:grid-cols-3" data-testid="progress-stats">
            <div>
              <dt className="overline text-ink-400">Days in progress</dt>
              <dd className="tnum text-lg font-semibold text-ink-900">{progress.days_in_progress}</dd>
            </div>
            <div>
              <dt className="overline text-ink-400">Estimated delivery</dt>
              <dd className="tnum text-lg font-semibold text-ink-900">
                {progress.estimated_delivery_at ? formatDate(progress.estimated_delivery_at) : '—'}
              </dd>
            </div>
            <div>
              <dt className="overline text-ink-400">Last activity</dt>
              <dd className="tnum text-lg font-semibold text-ink-900">
                {progress.last_activity_at ? formatDate(progress.last_activity_at) : '—'}
              </dd>
            </div>
          </dl>
        </div>
        <NextActionCard action={progress.next_action} base={base} />
      </div>

      <StageStepper stages={progress.stages} />

      <div className="grid gap-8 lg:grid-cols-2">
        <section className="rounded-lg border border-paper-300 bg-surface p-6 shadow-card">
          <h2 className="overline mb-4 text-ink-400">Document checklist</h2>
          <ul className="space-y-2.5">
            {progress.checklist.map((item) => (
              <li key={item.kind} className="flex items-center gap-2.5 text-sm">
                <span
                  aria-hidden
                  className={`flex h-4.5 w-4.5 items-center justify-center rounded-full text-[10px] font-bold ${
                    item.uploaded ? 'bg-emerald-700 text-bond-fg' : 'bg-paper-200 text-ink-500'
                  }`}
                >
                  {item.uploaded ? '✓' : '·'}
                </span>
                <span className={item.uploaded ? 'text-ink-700' : 'text-ink-500'}>
                  {item.label}
                  {item.count > 1 && <span className="ml-1 text-xs text-ink-400">×{item.count}</span>}
                </span>
              </li>
            ))}
          </ul>
          <p className="mt-4 text-xs text-ink-400">
            {missing.length === 0
              ? 'Everything we need is in — thank you.'
              : `${missing.length} item${missing.length === 1 ? '' : 's'} still needed. Upload them on the Documents tab.`}
          </p>
          {progress.report.available && (
            <button
              onClick={() =>
                download.start(
                  `/valuations/${valuation.id}/report.pdf`,
                  `${filenameStem(valuation.company_name)}_report.pdf`,
                )
              }
              disabled={download.busy}
              className="tap-area mt-5 inline-block cursor-pointer rounded-md bg-bond-600 px-4 py-2 text-sm font-semibold text-bond-fg hover:bg-bond-700 disabled:cursor-default disabled:opacity-60"
            >
              {download.busy ? 'Preparing your report…' : 'Download your report'}
            </button>
          )}
          {download.error && (
            <p role="alert" className="mt-3 text-sm font-medium text-red-600">
              {download.error}
            </p>
          )}
        </section>

        <section className="rounded-lg border border-paper-300 bg-surface p-6 shadow-card">
          <h2 className="overline mb-4 text-ink-400">Timeline</h2>
          {progress.timeline.length === 0 && <p className="text-sm text-ink-400">Nothing yet.</p>}
          <ol className="space-y-3">
            {progress.timeline.slice(0, 30).map((entry, i) => (
              <li key={`${entry.type}-${entry.occurred_at}-${i}`} className="flex gap-3 text-sm">
                <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-bond-400" aria-hidden />
                <div>
                  <span className="font-medium text-ink-800">{entry.label}</span>
                  {entry.detail && <span className="text-ink-500"> — {entry.detail}</span>}
                  <div className="tnum text-xs text-ink-400">{formatDateTime(entry.occurred_at)}</div>
                </div>
              </li>
            ))}
          </ol>
        </section>
      </div>
    </div>
  );
}
