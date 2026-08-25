import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, apiDownload, ApiError } from '../lib/api';
import { Button, EmptyState, ErrorNote, Field, Select, Spinner } from '../components/ui';
import { HelpIcon } from '../components/HelpIcon';
import { KIND_LABELS, formatDate } from '../lib/format';
import type { Valuation } from '../lib/types';
import { useLatestOnly } from '../lib/useLatestOnly';

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

type CompareFormat =
  | 'currency'
  | 'currency_precise'
  | 'percent'
  | 'integer'
  | 'number'
  | 'text'
  /** A specialty engine's own figure, whose unit the comparator does not know. */
  | 'scalar';

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
  /**
   * Metrics the comparison could read at all. Zero means it found nothing to
   * compare — which is not the same statement as "nothing changed", and saying
   * the second when the first is true asserts an agreement nobody checked.
   *
   * Optional so a reply from a build that predates the count is not read as a
   * comparison of zero metrics; `undefined` falls back to the old wording.
   */
  metric_count?: number;
  changed_count: number;
  summary: string | null;
}

/**
 * Direction, and the one family of metrics where it inverts.
 *
 * Up is not good and down is not bad — a rising DLOM pushes the FMV *down*,
 * which is why discounts are read the other way round. Anything we have not
 * reasoned about stays neutral rather than guessing a sentiment.
 */
const INVERTED = new Set(['dloc', 'dlom']);

function favourable(row: CompareRow): boolean | null {
  if (row.delta === null || row.delta === 0) return null;
  const up = row.delta > 0;
  return INVERTED.has(row.key) ? !up : up;
}

function deltaTone(row: CompareRow): string {
  const good = favourable(row);
  if (good === null) return 'text-ink-400';
  return good ? 'text-emerald-700' : 'text-red-700';
}

/**
 * The same judgement the colour carries, in a form that survives without it.
 *
 * Green-vs-red is the only thing that distinguished "the FMV rose" from "the
 * FMV fell" once the reader had the two numbers, and roughly one man in twelve
 * cannot tell those two hues apart — nor can anyone reading this through a
 * screen reader, in a printed board pack, or in high-contrast mode. The arrow
 * is redundant to the sign for a sighted reader and load-bearing for everyone
 * else (WCAG 1.4.1, "Use of Color").
 */
function DeltaDirection({ row }: { row: CompareRow }) {
  // A non-numeric move already renders the literal word "changed" in the cell;
  // there is no direction to add and nothing to restate.
  if (row.delta === null || row.delta === 0) return null;
  const up = row.delta > 0;
  const good = favourable(row);
  const sentiment = good === null ? '' : good ? ', favourable' : ', unfavourable';
  return (
    <>
      <span aria-hidden="true" className="mr-1">
        {up ? '▲' : '▼'}
      </span>
      <span className="sr-only">
        {up ? 'increased' : 'decreased'}
        {sentiment}:{' '}
      </span>
    </>
  );
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

/**
 * Why a comparison came back with no metrics.
 *
 * "Every metric these two report is identical" was printed for this case, and
 * it is a claim about the two runs that nothing established — most often one
 * of them has simply never computed. Names the side that is missing, because
 * that is the sentence that tells the user what to do next.
 */
function nothingToCompare(c: Comparison): string {
  const missing = [c.a, c.b].filter((s) => s.calculation_id === null);
  if (missing.length === 2) return 'Neither of these has produced a calculation yet.';
  const only = missing[0];
  if (only) {
    return `${only.company_name} has not produced a calculation yet, so there is nothing to compare it against.`;
  }
  return 'Both have computed, but neither reported any metric this comparison reads.';
}

export function ValuationComparePage() {
  const [params, setParams] = useSearchParams();
  const a = params.get('a') ?? '';
  const b = params.get('b') ?? '';

  const [options, setOptions] = useState<Valuation[] | null>(null);
  const [optionsError, setOptionsError] = useState<string | null>(null);
  const [comparison, setComparison] = useState<Comparison | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [onlyChanged, setOnlyChanged] = useState(true);
  const [exporting, setExporting] = useState(false);

  const exportCsv = async () => {
    setExporting(true);
    setError(null);
    try {
      await apiDownload(
        `/valuations/compare?a=${encodeURIComponent(a)}&b=${encodeURIComponent(b)}&format=csv`,
        'comparison.csv',
      );
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not export the comparison.');
    } finally {
      setExporting(false);
    }
  };

  useEffect(() => {
    void api<{ valuations: Valuation[] }>('/valuations?per_page=100')
      .then((r) => setOptions(r.valuations))
      // Not `setOptions([])`: two empty pickers plus "You need at least two
      // valuations before there is anything to compare" is a claim about the
      // account, and the account is not what failed.
      .catch((err: unknown) =>
        setOptionsError(err instanceof ApiError ? err.message : 'Could not load the valuations to compare.'),
      );
  }, []);

  const claim = useLatestOnly();

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
    // Both sides are pickers, so a second comparison is one click away while
    // the first is still in flight — and the two replies are not ordered. A
    // late reply for the previous pair renders as the comparison of the pair
    // now named in the dropdowns, which is a table of moved numbers attributed
    // to the wrong two valuations. See `useLatestOnly`.
    const current = claim();
    setLoading(true);
    setError(null);
    void api<Comparison>(`/valuations/compare?a=${encodeURIComponent(a)}&b=${encodeURIComponent(b)}`)
      .then((c) => current() && setComparison(c))
      .catch((err: unknown) => {
        if (!current()) return;
        setComparison(null);
        setError(err instanceof ApiError ? err.message : 'Could not compare these valuations.');
      })
      .finally(() => current() && setLoading(false));
  }, [a, b, claim]);

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

      {optionsError && (
        <div className="mt-6">
          <ErrorNote>{optionsError}</ErrorNote>
        </div>
      )}

      {error && (
        <div className="mt-6">
          <ErrorNote>{error}</ErrorNote>
        </div>
      )}

      {loading && <Spinner />}

      {!loading && !error && !optionsError && (!a || !b) && (
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
              {comparison.metric_count === 0
                ? // The reason is given once, in the empty state below — the
                  // same sentence in both places is noise, and this line is
                  // the count, not the explanation.
                  'No metrics to compare.'
                : comparison.changed_count === 0
                  ? 'Nothing measured differs between these two.'
                  : `${comparison.changed_count} ${comparison.changed_count === 1 ? 'metric' : 'metrics'} changed.`}
            </p>
          </section>

          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="overline text-ink-400">Metrics</h2>
            <div className="flex items-center gap-2">
              <Button variant="ghost" onClick={() => setOnlyChanged((v) => !v)}>
                {onlyChanged ? 'Show all metrics' : 'Show only changes'}
              </Button>
              {/*
               * The board pack is assembled in a spreadsheet, and the only way
               * to get these figures into one was to retype them off the
               * screen. Exports the full comparison, not the filtered view —
               * the file is evidence, and evidence should not depend on which
               * toggle happened to be set when it was taken.
               */}
              <Button variant="secondary" disabled={exporting} onClick={() => void exportCsv()}>
                {exporting ? 'Preparing…' : 'Export CSV'}
              </Button>
            </div>
          </div>

          {comparison.metric_count === 0 ? (
            <EmptyState title="Nothing to compare">{nothingToCompare(comparison)}</EmptyState>
          ) : groups.length === 0 ? (
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
                <div className="overflow-x-auto overscroll-x-contain">
                  <table className="w-full min-w-[36rem] text-sm">
                    <caption className="sr-only">{group.title}</caption>
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
                            <DeltaDirection row={r} />
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
