import { useEffect, useState } from 'react';
import { api, ApiError, getToken } from '../../lib/api';
import { downloadPdf } from '../../lib/m2';
import { formatDateTime } from '../../lib/format';
import { useWorkspace } from './ValuationWorkspace';
import { ErrorNote, Spinner } from '../../components/ui';

interface ProgressStage {
  key: string;
  label: string;
  description: string;
  status: 'done' | 'current' | 'upcoming';
  entered_at: string | null;
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

interface ProgressResponse {
  state: string;
  halted: boolean;
  waiting_on_client: boolean;
  stages: ProgressStage[];
  checklist: ChecklistItem[];
  documents_uploaded: number;
  report: { available: boolean };
  explanation: { available: boolean };
  timeline: TimelineEntry[];
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
                : 'border-paper-300 bg-white'
          }`}
        >
          <div className="flex items-center gap-2">
            <span
              className={`flex h-5 w-5 items-center justify-center rounded-full text-[11px] font-bold ${
                stage.status === 'done'
                  ? 'bg-emerald-500 text-white'
                  : stage.status === 'current'
                    ? 'bg-bond-600 text-white'
                    : 'bg-paper-200 text-ink-400'
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
  if (!progress) return <Spinner />;

  const missing = progress.checklist.filter((c) => !c.uploaded);

  return (
    <div className="space-y-8">
      {progress.halted && (
        <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          This valuation is not progressing (state: {progress.state}). Contact support if this is
          unexpected.
        </div>
      )}
      {progress.waiting_on_client && !progress.halted && (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          We're waiting on you — check the document checklist below for anything outstanding.
        </div>
      )}

      <StageStepper stages={progress.stages} />

      <div className="grid gap-8 lg:grid-cols-2">
        <section className="rounded-lg border border-paper-300 bg-white p-6 shadow-card">
          <h2 className="overline mb-4 text-ink-400">Document checklist</h2>
          <ul className="space-y-2.5">
            {progress.checklist.map((item) => (
              <li key={item.kind} className="flex items-center gap-2.5 text-sm">
                <span
                  aria-hidden
                  className={`flex h-4.5 w-4.5 items-center justify-center rounded-full text-[10px] font-bold ${
                    item.uploaded ? 'bg-emerald-500 text-white' : 'bg-paper-200 text-ink-400'
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
                void downloadPdf(
                  `/valuations/${valuation.id}/report.pdf`,
                  `${valuation.company_name.replace(/[^\w.-]+/g, '_')}_report.pdf`,
                  getToken(),
                ).catch(() => {})
              }
              className="mt-5 inline-block cursor-pointer rounded-md bg-bond-600 px-4 py-2 text-sm font-semibold text-white hover:bg-bond-700"
            >
              Download your report
            </button>
          )}
        </section>

        <section className="rounded-lg border border-paper-300 bg-white p-6 shadow-card">
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
