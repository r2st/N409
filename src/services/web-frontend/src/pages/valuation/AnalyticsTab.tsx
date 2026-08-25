import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { formatDate, ordinal } from '../../lib/format';
import { useWorkspace } from './ValuationWorkspace';
import { CHART_COLORS, LineChart } from '../../components/charts';
import { EmptyState, ErrorNote, LoadingBlock, Skeleton, SkeletonText } from '../../components/ui';

interface Point {
  as_of: string;
  valuation_number: string | null;
  fmv_per_share: number | null;
  dlom: number | null;
  volatility: number | null;
  market_multiple: number | null;
}
interface Benchmark {
  count: number;
  min: number | null;
  p25: number | null;
  median: number | null;
  p75: number | null;
  max: number | null;
  company_multiple: number | null;
  percentile: number | null;
}
interface AnalyticsResponse {
  company_name: string;
  analytics: { series: Point[]; benchmark: Benchmark; count: number };
}

const money = (v: number) => `$${v.toFixed(2)}`;
const pct = (v: number) => `${(v * 100).toFixed(1)}%`;
const mult = (v: number) => `${v.toFixed(1)}×`;
const label = (p: Point) => p.valuation_number ?? formatDate(p.as_of);

/**
 * Valuation analytics dashboard (feature 5): FMV / DLOM / volatility / revenue-
 * multiple trends across the company's valuations, plus a comparable-multiple
 * benchmark with the company's percentile.
 */
export function AnalyticsTab() {
  const { valuation } = useWorkspace();
  const [data, setData] = useState<AnalyticsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<AnalyticsResponse>(`/valuations/${valuation.id}/analytics`)
      .then(setData)
      .catch(() => setError('Could not load analytics.'));
  }, [valuation.id]);

  if (error) return <ErrorNote>{error}</ErrorNote>;
  // Four trend charts on a two-column grid, then the benchmark panel.
  if (!data)
    return (
      <LoadingBlock label="Loading analytics…" className="max-w-5xl space-y-6">
        <div aria-hidden>
          <Skeleton className="h-6 w-36" />
          <Skeleton className="mt-2 h-3.5 w-80 max-w-full" />
        </div>
        <div className="grid gap-4 md:grid-cols-2">
          {Array.from({ length: 4 }, (_, i) => (
            <div
              key={i}
              className="rounded-lg border border-paper-300 bg-surface p-5 shadow-card"
              aria-hidden
            >
              <Skeleton className="h-2.5 w-28" />
              <Skeleton className="mt-4 h-36 w-full" />
            </div>
          ))}
        </div>
        <div className="rounded-lg border border-paper-300 bg-surface p-6 shadow-card" aria-hidden>
          <Skeleton className="h-2.5 w-56" />
          <SkeletonText lines={3} className="mt-4" />
        </div>
      </LoadingBlock>
    );

  const { series, benchmark, count } = data.analytics;

  if (count === 0) {
    return (
      <EmptyState title="No completed valuations yet">
        Analytics appear once this company has at least one completed calculation.
      </EmptyState>
    );
  }

  const points = (key: keyof Point) =>
    series.map((p) => ({ label: label(p), value: (p[key] as number | null) ?? null }));

  return (
    <div className="max-w-5xl space-y-6">
      <div>
        <h2 className="font-display text-xl font-semibold text-ink-900">Analytics</h2>
        <p className="mt-1 text-sm text-ink-400">
          Trends across {count} valuation{count === 1 ? '' : 's'} of {data.company_name}.
        </p>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <LineChart
          title="FMV per share"
          points={points('fmv_per_share')}
          format={money}
          color={CHART_COLORS.green}
        />
        <LineChart title="DLOM" points={points('dlom')} format={pct} color={CHART_COLORS.red} />
        <LineChart title="Volatility" points={points('volatility')} format={pct} color={CHART_COLORS.blue} />
        <LineChart
          title="Revenue multiple"
          points={points('market_multiple')}
          format={mult}
          color={CHART_COLORS.brass}
        />
      </div>

      <section className="rounded-lg border border-paper-300 bg-surface p-6 shadow-card">
        <h3 className="overline mb-3 text-ink-400">Comparable-company benchmark</h3>
        {benchmark.count === 0 ? (
          <p className="text-sm text-ink-400">
            No comparable multiples in the latest calculation to benchmark against.
          </p>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-5">
              {(
                [
                  ['Min', benchmark.min],
                  ['25th', benchmark.p25],
                  ['Median', benchmark.median],
                  ['75th', benchmark.p75],
                  ['Max', benchmark.max],
                ] as const
              ).map(([k, v]) => (
                <div key={k} className="rounded-md border border-paper-300 bg-paper-50 px-3 py-2.5">
                  <div className="overline text-ink-400">{k}</div>
                  <div className="tnum mt-1 font-display text-lg font-semibold text-ink-900">
                    {v === null ? '—' : mult(v)}
                  </div>
                </div>
              ))}
            </div>
            {benchmark.company_multiple !== null && (
              <p className="mt-4 text-sm text-ink-600" data-testid="benchmark-percentile">
                This company's applied multiple of <strong>{mult(benchmark.company_multiple)}</strong>
                {benchmark.percentile !== null && (
                  <>
                    {' '}
                    sits at the <strong>
                      {ordinal(Math.round(benchmark.percentile * 100))} percentile
                    </strong>{' '}
                    of the {benchmark.count} comparables.
                  </>
                )}
              </p>
            )}
          </>
        )}
      </section>
    </div>
  );
}
