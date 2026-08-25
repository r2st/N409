import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../../lib/api';
import { formatDateTime } from '../../lib/format';
import { useWorkspace } from './ValuationWorkspace';
import {
  Button,
  EmptyState,
  ErrorNote,
  LoadingBlock,
  Skeleton,
  SkeletonText,
  WriteGate,
} from '../../components/ui';

type QaStatus = 'pass' | 'warn' | 'fail';

interface QaCheck {
  key: string;
  label: string;
  status: QaStatus;
  detail: string;
}

interface AiFinding {
  area: string;
  finding: string;
  severity: 'info' | 'warn' | 'fail';
}

interface QaReview {
  id: string;
  calculation_id: string;
  /** The report version this review graded; null for one filed before it was recorded. */
  report_version: number | null;
  status: QaStatus;
  checks: QaCheck[];
  ai_findings: { findings?: AiFinding[]; assessment?: string; verdict?: string } | null;
  ai_model: string | null;
  created_at: string;
}

interface QaResponse {
  reviews: QaReview[];
  latest_calculation_id: string | null;
  report_version: number | null;
  gate: {
    satisfied: boolean;
    review_id: string | null;
    status: QaStatus | null;
    /** The report body has been saved since the review that would otherwise clear it. */
    body_stale: boolean;
  };
}

const STATUS_STYLES: Record<QaStatus | 'info', string> = {
  pass: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
  warn: 'bg-amber-50 text-amber-800 ring-amber-200',
  fail: 'bg-red-50 text-red-700 ring-red-200',
  info: 'bg-paper-100 text-ink-500 ring-paper-300',
};

function StatusPill({ status }: { status: QaStatus | 'info' }) {
  return (
    <span
      className={`rounded-full px-2 py-0.5 text-xs font-semibold ring-1 ring-inset ${STATUS_STYLES[status]}`}
    >
      {status}
    </span>
  );
}

/**
 * QA gate dashboard (IMPROVEMENTS_RESEARCH §4.3, ops-only): run the
 * deterministic reasonableness checks — optionally with the AI reviewer — and
 * see whether the publish gate is currently satisfied. A recalculation
 * invalidates the previous review, so the banner always refers to the LATEST
 * calculation.
 */
export function QaTab() {
  const { valuation, retired } = useWorkspace();
  const [data, setData] = useState<QaResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState<'checks' | 'ai' | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await api<QaResponse>(`/valuations/${valuation.id}/qa`));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load QA reviews.');
    }
  }, [valuation.id]);

  useEffect(() => {
    void load();
  }, [load]);

  const run = async (ai: boolean) => {
    setRunning(ai ? 'ai' : 'checks');
    setError(null);
    try {
      await api(`/valuations/${valuation.id}/qa`, { method: 'POST', body: { ai } });
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'QA run failed.');
    } finally {
      setRunning(null);
    }
  };

  if (error && !data) return <ErrorNote>{error}</ErrorNote>;
  // Gate banner, the two run buttons, then the latest review panel.
  if (!data)
    return (
      <LoadingBlock label="Loading QA…" className="space-y-6">
        <Skeleton className="h-[46px] w-full rounded-md" />
        <div className="flex gap-2" aria-hidden>
          <Skeleton className="h-[38px] w-32" />
          <Skeleton className="h-[38px] w-52" />
        </div>
        <div className="rounded-lg border border-paper-300 bg-surface p-6 shadow-card" aria-hidden>
          <Skeleton className="h-5 w-48" />
          <SkeletonText lines={4} className="mt-4" />
        </div>
      </LoadingBlock>
    );

  const latest = data.reviews[0] ?? null;

  return (
    <div className="space-y-6">
      <div
        data-testid="qa-gate-banner"
        className={`rounded-md border px-4 py-3 text-sm ${
          data.latest_calculation_id === null
            ? 'border-paper-300 bg-paper-100 text-ink-500'
            : data.gate.satisfied
              ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
              : 'border-amber-200 bg-amber-50 text-amber-800'
        }`}
      >
        {data.latest_calculation_id === null
          ? 'No completed calculation yet — QA opens once the first calculation succeeds.'
          : data.gate.satisfied
            ? `Publish gate satisfied — the latest calculation has a ${data.gate.status} review.`
            : data.gate.body_stale
              ? // The review passed and the calculation has not moved; the report body has.
                // Said separately because "run a QA review" is the wrong instruction here —
                // there is one, it just graded prose that is no longer in the document.
                'Publish gate NOT satisfied — the report body has been edited since the last QA review. Re-run the checks so the review covers the document that would be delivered.'
              : 'Publish gate NOT satisfied — the latest calculation needs a non-failing QA review before this valuation can publish.'}
      </div>

      <div className="flex gap-2">
        <WriteGate closed={retired}>
          <Button
            onClick={() => void run(false)}
            disabled={running !== null || data.latest_calculation_id === null}
          >
            {running === 'checks' ? 'Running…' : 'Run checks'}
          </Button>
          <Button
            variant="secondary"
            onClick={() => void run(true)}
            disabled={running !== null || data.latest_calculation_id === null}
          >
            {running === 'ai' ? 'Running…' : 'Run checks + AI review'}
          </Button>
        </WriteGate>
      </div>
      {error && <ErrorNote>{error}</ErrorNote>}

      {!latest ? (
        <EmptyState title="No QA reviews yet">
          Run the checks to review the latest calculation for reasonableness before delivery.
        </EmptyState>
      ) : (
        <section className="rounded-lg border border-paper-300 bg-surface p-6 shadow-card">
          <div className="mb-4 flex flex-wrap items-center gap-3">
            <h2 className="overline text-ink-400">Latest review</h2>
            <StatusPill status={latest.status} />
            <span className="tnum text-xs text-ink-400">{formatDateTime(latest.created_at)}</span>
            {latest.calculation_id !== data.latest_calculation_id && (
              <span className="rounded-full bg-amber-50 px-2 py-0.5 text-xs font-semibold text-amber-800 ring-1 ring-amber-200 ring-inset">
                stale — reviews an older calculation
              </span>
            )}
            {data.report_version !== null &&
              (latest.report_version === null || data.report_version > latest.report_version) && (
                <span className="rounded-full bg-amber-50 px-2 py-0.5 text-xs font-semibold text-amber-800 ring-1 ring-amber-200 ring-inset">
                  stale — reviews an older report body
                </span>
              )}
          </div>

          <table className="w-full text-left text-sm">
            <caption className="sr-only">Health checks</caption>
            <thead>
              <tr className="border-b border-paper-300 text-xs text-ink-400">
                <th className="py-2 pr-4 font-semibold">Check</th>
                <th className="py-2 pr-4 font-semibold">Status</th>
                <th className="py-2 font-semibold">Detail</th>
              </tr>
            </thead>
            <tbody>
              {latest.checks.map((check) => (
                <tr key={check.key} className="border-b border-paper-200 last:border-0">
                  <td className="py-2 pr-4 font-medium text-ink-800">{check.label}</td>
                  <td className="py-2 pr-4">
                    <StatusPill status={check.status} />
                  </td>
                  <td className="py-2 text-ink-600">{check.detail}</td>
                </tr>
              ))}
            </tbody>
          </table>

          {latest.ai_findings && (
            <div className="mt-6 border-t border-paper-200 pt-5">
              <div className="flex items-center gap-2">
                <h3 className="text-sm font-semibold text-ink-900">AI reviewer</h3>
                {latest.ai_model && (
                  <span className="rounded border border-ink-200 bg-surface px-1.5 py-0.5 font-mono text-[11px] text-ink-500">
                    {latest.ai_model}
                  </span>
                )}
              </div>
              {latest.ai_findings.assessment && (
                <p className="mt-2 text-sm text-ink-600">{latest.ai_findings.assessment}</p>
              )}
              <ul className="mt-3 space-y-2">
                {(latest.ai_findings.findings ?? []).map((finding, i) => (
                  <li key={i} className="flex items-start gap-2 text-sm">
                    <StatusPill status={finding.severity === 'info' ? 'info' : finding.severity} />
                    <span className="text-ink-700">
                      <span className="text-xs font-semibold text-ink-400 uppercase">{finding.area}</span>{' '}
                      {finding.finding}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>
      )}

      {data.reviews.length > 1 && (
        <section>
          <h2 className="overline mb-3 text-ink-400">History</h2>
          <ol className="space-y-2">
            {data.reviews.slice(1).map((review) => (
              <li
                key={review.id}
                className="flex items-center gap-3 rounded-md border border-paper-300 bg-surface px-3.5 py-2 text-sm"
              >
                <StatusPill status={review.status} />
                <span className="text-ink-600">
                  {review.checks.length} checks{review.ai_findings ? ' + AI review' : ''}
                </span>
                <span className="tnum ml-auto text-xs text-ink-400">{formatDateTime(review.created_at)}</span>
              </li>
            ))}
          </ol>
        </section>
      )}
    </div>
  );
}
