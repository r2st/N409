import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../../lib/api';
import { useWorkspace } from './ValuationWorkspace';
import { Button, EmptyState, ErrorNote, LoadingBlock, Skeleton, SkeletonText } from '../../components/ui';

type GapSeverity = 'blocking' | 'important' | 'optional';
type GapCategory = 'questionnaire' | 'documents' | 'financials' | 'cap_table' | 'parameters';
type Grade = 'ready' | 'nearly' | 'partial' | 'insufficient';

interface Gap {
  key: string;
  category: GapCategory;
  severity: GapSeverity;
  label: string;
  detail: string;
  remedy: string;
}

interface CompletenessReport {
  score: number;
  grade: Grade;
  ready: boolean;
  gaps: Gap[];
  counts: Record<GapSeverity, number>;
  byCategory: Record<GapCategory, number>;
  questionnaire: {
    percentComplete: number;
    requiredAnswered: number;
    requiredTotal: number;
    ready: boolean;
  };
}

const SEVERITY_STYLES: Record<GapSeverity, string> = {
  blocking: 'bg-red-50 text-red-700 ring-red-200',
  important: 'bg-amber-50 text-amber-800 ring-amber-200',
  optional: 'bg-paper-100 text-ink-500 ring-paper-300',
};

const SEVERITY_LABELS: Record<GapSeverity, string> = {
  blocking: 'blocking',
  important: 'important',
  optional: 'optional',
};

const CATEGORY_LABELS: Record<GapCategory, string> = {
  parameters: 'Valuation setup',
  cap_table: 'Cap table',
  financials: 'Financials',
  documents: 'Documents',
  questionnaire: 'Questionnaire',
};

const CATEGORY_ORDER: GapCategory[] = [
  'parameters',
  'cap_table',
  'financials',
  'documents',
  'questionnaire',
];

function SeverityPill({ severity }: { severity: GapSeverity }) {
  return (
    <span
      className={`rounded-full px-2 py-0.5 text-xs font-semibold ring-1 ring-inset ${SEVERITY_STYLES[severity]}`}
    >
      {SEVERITY_LABELS[severity]}
    </span>
  );
}

/**
 * Missing-data completeness (domain/dataCompleteness.ts) — what this engagement
 * still needs before a valuation can run.
 *
 * The banner reports `ready`, never `score`. They are separate on the wire for
 * the reason they are separate here: a percentage used as a gate is how "95%
 * complete" comes to mean "unusable", because the missing 5% is not a random
 * 5%. The score is shown beside it as a progress figure and is deliberately
 * the smaller of the two numbers on the page.
 */
export function CompletenessTab() {
  const { valuation } = useWorkspace();
  const [data, setData] = useState<CompletenessReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await api<{ completeness: CompletenessReport }>(
        `/valuations/${valuation.id}/completeness`,
      );
      setData(res.completeness);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load completeness.');
    }
  }, [valuation.id]);

  useEffect(() => {
    void load();
  }, [load]);

  const refresh = async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  };

  if (error && !data) return <ErrorNote>{error}</ErrorNote>;
  if (!data)
    return (
      <LoadingBlock label="Checking what's still needed…" className="space-y-6">
        <Skeleton className="h-[46px] w-full rounded-md" />
        <div className="rounded-lg border border-paper-300 bg-surface p-6 shadow-card" aria-hidden>
          <Skeleton className="h-5 w-48" />
          <SkeletonText lines={4} className="mt-4" />
        </div>
      </LoadingBlock>
    );

  const grouped = CATEGORY_ORDER.map((category) => ({
    category,
    gaps: data.gaps.filter((g) => g.category === category),
  })).filter((group) => group.gaps.length > 0);

  return (
    <div className="space-y-6">
      <div
        data-testid="completeness-banner"
        className={`rounded-md border px-4 py-3 text-sm ${
          data.ready
            ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
            : 'border-red-200 bg-red-50 text-red-800'
        }`}
      >
        {data.ready
          ? data.gaps.length === 0
            ? 'Ready to value — nothing outstanding.'
            : `Ready to value — ${data.gaps.length} non-blocking item${data.gaps.length === 1 ? '' : 's'} outstanding.`
          : `Not ready to value — ${data.counts.blocking} blocking gap${data.counts.blocking === 1 ? '' : 's'} to resolve first.`}
      </div>

      <div className="flex flex-wrap items-center gap-6">
        <div>
          <div className="text-3xl font-semibold text-ink-900" data-testid="completeness-score">
            {data.score}%
          </div>
          <div className="text-xs uppercase tracking-wide text-ink-500">Evidence complete</div>
        </div>
        <div>
          <div className="text-3xl font-semibold text-ink-900">
            {data.questionnaire.requiredAnswered}/{data.questionnaire.requiredTotal}
          </div>
          <div className="text-xs uppercase tracking-wide text-ink-500">Questionnaire answers</div>
        </div>
        <div className="ml-auto">
          <Button onClick={() => void refresh()} disabled={refreshing}>
            {refreshing ? 'Refreshing…' : 'Refresh'}
          </Button>
        </div>
      </div>

      {error ? <ErrorNote>{error}</ErrorNote> : null}

      {grouped.length === 0 ? (
        <EmptyState title="Nothing outstanding">
          Every check this engagement's configuration calls for is satisfied.
        </EmptyState>
      ) : (
        grouped.map(({ category, gaps }) => (
          <section key={category} className="rounded-lg border border-paper-300 bg-surface shadow-card">
            <header className="border-b border-paper-200 px-6 py-3">
              <h3 className="text-sm font-semibold text-ink-900">
                {CATEGORY_LABELS[category]}{' '}
                <span className="font-normal text-ink-500">({gaps.length})</span>
              </h3>
            </header>
            <ul className="divide-y divide-paper-200">
              {gaps.map((gap) => (
                <li key={gap.key} className="px-6 py-4" data-testid={`gap-${gap.key}`}>
                  <div className="flex items-start justify-between gap-4">
                    <p className="text-sm font-medium text-ink-900">{gap.label}</p>
                    <SeverityPill severity={gap.severity} />
                  </div>
                  <p className="mt-1 text-sm text-ink-600">{gap.detail}</p>
                  <p className="mt-2 text-sm text-ink-500">
                    <span className="font-medium text-ink-700">Next:</span> {gap.remedy}
                  </p>
                </li>
              ))}
            </ul>
          </section>
        ))
      )}
    </div>
  );
}
