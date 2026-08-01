import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import { Button, EmptyState, ErrorNote, Field, Select, Spinner } from '../components/ui';
import { HelpIcon } from '../components/HelpIcon';
import { KIND_LABELS, formatDate } from '../lib/format';
import type { Valuation } from '../lib/types';

/**
 * Two valuations, side by side.
 *
 * A board that has just received a new 409A asks one question — why is this
 * different from last time? — and answering it today means opening two PDFs
 * and reading them against each other. The figure that actually moved is
 * rarely the headline: it is a volatility assumption, a DLOM method, or an
 * approach that quietly gained weight.
 *
 * So the default view is *only what changed*. The unchanged rows are still
 * there, one click away, because an auditor needs to see that the rest held
 * still — but they are not what the page opens on.
 */

type CompareFormat = 'currency' | 'currency_precise' | 'percent' | 'integer' | 'number' | 'text';

interface CompareRow {
  key: string;
  label: string;
  format: CompareFormat;
  a: number | string | null;
  b: number | string | null;
  a_display: string | null;
  b_display: string | null;
  delta: number | null;
  delta_display: string | null;
  pct_change: number | null;
  changed: boolean;
}

interface CompareGroup {
  key: string;
  title: string;
  rows: CompareRow[];
}

interface CompareSide {
  valuation_id: string;
  company_name: string;
  kind: string;
  currency: string;
  state: string;
  calculation_id: string | null;
  engine_version: string | null;
  calculated_at: string | null;
  valuation_date: string | null;
}

interface Comparison {
  a: CompareSide;
  b: CompareSide;
  groups: CompareGroup[];
  changed_count: number;
  summary: string | null;
}

/**
 * Direction colouring, and the one metric where it inverts.
 *
 * Up is not good and down is not bad — a rising DLOM pushes the FMV *down*,
 * which is why discounts are read the other way round. Anything we have not
 * reasoned about stays neutral rather than guessing a sentiment.
 */
const INVERTED = new Set(['dloc', 'dlom']);

function deltaTone(row: CompareRow): string {
  if (row.delta === null || row.delta === 0) return 'text-ink-400';
  const up = row.delta > 0;
  const good = INVERTED.has(row.key) ? !up : up;
  return good ? 'text-emerald-700' : 'text-red-700';
}

function optionLabel(v: Valuation): string {
  const kind = KIND_LABELS[v.kind] ?? v.kind;
  const number = v.number ? `#${v.number} · ` : '';
  return `${number}${v.company_name} · ${kind} · ${formatDate(v.created_at)}`;
}

function SideHeader({ side, label }: { side: CompareSide; label: string }) {
  return (
    <div>
      <div className="overline text-ink-400">{label}</div>
      <Link
        to={`/valuations/${side.valuation_id}`}
        className="font-display text-base font-semibold text-ink-900 hover:text-bond-700"
      >
        {side.company_name}
      </Link>
      <p className="mt-0.5 text-xs text-ink-400">
        {KIND_LABELS[side.kind as keyof typeof KIND_LABELS] ?? side.kind}
        {side.valuation_date ? ` · as of ${side.valuation_date}` : ''}
      </p>
      <p className="mt-0.5 text-xs text-ink-400">
        {side.calculated_at
          ? `Computed ${formatDate(side.calculated_at)} · engine ${side.engine_version}`
          : 'No completed calculation yet'}
      </p>
    </div>
  );
}

export function ValuationComparePage() {
  const [params, setParams] = useSearchParams();
  const a = params.get('a') ?? '';
  const b = params.get('b') ?? '';

  const [options, setOptions] = useState<Valuation[] | null>(null);
  const [comparison, setComparison] = useState<Comparison | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [onlyChanged, setOnlyChanged] = useState(true);

  useEffect(() => {
    void api<{ valuations: Valuation[] }>('/valuations?per_page=100')
      .then((r) => setOptions(r.valuations))
      .catch(() => setOptions([]));
  }, []);

  const pick = useCallback(
    (side: 'a' | 'b', id: string) => {
      const next = new URLSearchParams(params);
      if (id) next.set(side, id);
      else next.delete(side);
      // Replace, not push: flipping between candidates should not fill the
      // back button with every combination the user tried.
      setParams(next, { replace: true });
    },
    [params, setParams],
  );

  useEffect(() => {
    if (!a || !b) {
      setComparison(null);
      setError(null);
      return;
    }
    setLoading(true);
    setError(null);
    void api<Comparison>(`/valuations/compare?a=${encodeURIComponent(a)}&b=${encodeURIComponent(b)}`)
      .then(setComparison)
      .catch((err: unknown) => {
        setComparison(null);
        setError(err instanceof ApiError ? err.message : 'Could not compare these valuations.');
      })
      .finally(() => setLoading(false));
  }, [a, b]);

  const groups = useMemo(() => {
    if (!comparison) return [];
    if (!onlyChanged) return comparison.groups;
    return comparison.groups
      .map((g) => ({ ...g, rows: g.rows.filter((r) => r.changed) }))
      .filter((g) => g.rows.length > 0);
  }, [comparison, onlyChanged]);

  return (
    <div>
      <div className="overline flex items-center gap-1.5 text-ink-400">
        Compare
        <HelpIcon article="creating-a-valuation" />
      </div>
      <h1 className="mt-1 font-display text-3xl font-semibold text-ink-900">Side-by-side comparison</h1>
      <p className="mt-1 text-sm text-ink-400">
        Pick two valuations to see what moved between them — the conclusion, the discounts, the assumptions
        and the approach weighting.
      </p>

      <div className="mt-6 grid gap-4 sm:grid-cols-2">
        <Field label="Baseline (A)">
          <Select value={a} onChange={(e) => pick('a', e.target.value)} disabled={!options}>
            <option value="">Choose a valuation…</option>
            {options?.map((v) => (
              <option key={v.id} value={v.id} disabled={v.id === b}>
                {optionLabel(v)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Compared with (B)">
          <Select value={b} onChange={(e) => pick('b', e.target.value)} disabled={!options}>
            <option value="">Choose a valuation…</option>
            {options?.map((v) => (
              <option key={v.id} value={v.id} disabled={v.id === a}>
                {optionLabel(v)}
              </option>
            ))}
          </Select>
        </Field>
      </div>

      {error && (
        <div className="mt-6">
          <ErrorNote>{error}</ErrorNote>
        </div>
      )}

      {loading && <Spinner />}

      {!loading && !error && (!a || !b) && (
        <div className="mt-8">
          <EmptyState title="Choose two valuations">
            {options && options.length < 2
              ? 'You need at least two valuations before there is anything to compare.'
              : 'Pick a baseline and something to compare it against.'}
          </EmptyState>
        </div>
      )}

      {comparison && !loading && (
        <div className="mt-8 space-y-6">
          <section className="rounded-lg border border-paper-300 bg-surface p-6 shadow-card">
            <div className="grid gap-6 sm:grid-cols-2">
              <SideHeader side={comparison.a} label="Baseline (A)" />
              <SideHeader side={comparison.b} label="Compared with (B)" />
            </div>
            {comparison.summary && (
              <p className="mt-5 border-t border-paper-200 pt-4 font-display text-lg text-ink-900">
                {comparison.summary}
              </p>
            )}
            <p className="mt-1 text-sm text-ink-400">
              {comparison.changed_count === 0
                ? 'Nothing measured differs between these two.'
                : `${comparison.changed_count} ${comparison.changed_count === 1 ? 'metric' : 'metrics'} changed.`}
            </p>
          </section>

          <div className="flex items-center justify-between gap-3">
            <h2 className="overline text-ink-400">Metrics</h2>
            <Button variant="ghost" onClick={() => setOnlyChanged((v) => !v)}>
              {onlyChanged ? 'Show all metrics' : 'Show only changes'}
            </Button>
          </div>

          {groups.length === 0 ? (
            <EmptyState title="No differences">
              Every metric these two report is identical. Switch to “Show all metrics” to see them.
            </EmptyState>
          ) : (
            groups.map((group) => (
              <section
                key={group.key}
                className="overflow-hidden rounded-lg border border-paper-300 bg-surface shadow-card"
              >
                <h3 className="border-b border-paper-200 bg-paper-50 px-5 py-3 font-display text-sm font-semibold text-ink-800">
                  {group.title}
                </h3>
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[36rem] text-sm">
                    <thead>
                      <tr className="border-b border-paper-200 text-left">
                        <th scope="col" className="px-5 py-2.5 font-medium text-ink-400">
                          Metric
                        </th>
                        <th scope="col" className="px-5 py-2.5 text-right font-medium text-ink-400">
                          A
                        </th>
                        <th scope="col" className="px-5 py-2.5 text-right font-medium text-ink-400">
                          B
                        </th>
                        <th scope="col" className="px-5 py-2.5 text-right font-medium text-ink-400">
                          Change
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {group.rows.map((r) => (
                        <tr
                          key={r.key}
                          className={`border-b border-paper-100 last:border-0 ${
                            r.changed ? 'bg-amber-50/40' : ''
                          }`}
                        >
                          <th scope="row" className="px-5 py-2.5 text-left font-normal text-ink-700">
                            {r.label}
                          </th>
                          <td className="px-5 py-2.5 text-right tabular-nums text-ink-900">
                            {r.a_display ?? '—'}
                          </td>
                          <td className="px-5 py-2.5 text-right tabular-nums text-ink-900">
                            {r.b_display ?? '—'}
                          </td>
                          <td className={`px-5 py-2.5 text-right tabular-nums ${deltaTone(r)}`}>
                            {r.delta_display ?? (r.changed ? 'changed' : '—')}
                            {r.pct_change !== null && r.delta !== 0 && (
                              <span className="ml-1.5 text-xs text-ink-400">
                                {(r.pct_change * 100).toFixed(1)}%
                              </span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            ))
          )}
        </div>
      )}
    </div>
  );
}
