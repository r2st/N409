import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError, describeActionFailure } from '../lib/api';
import { formatDateTime, formatNumber } from '../lib/format';
import { Button, EmptyState, LoadError, Spinner, StatCard, useRetry } from '../components/ui';

/**
 * Data remediation (design §7.4).
 *
 * Two stored-data defects that correct themselves for anything re-run and do
 * not correct themselves for anything already published. This page is the list
 * that has to exist before either can be acted on.
 *
 * Published rows are shown and cannot be selected. That is the whole point of
 * the screen: a published 409A is a signed document a client has relied on for
 * a grant price or a tax position, and re-running the engine underneath it does
 * not fix the report — it makes the platform disagree with a document already
 * out in the world. Those need a human decision recorded against the
 * engagement, so the row links to the workspace instead of offering a button.
 */

interface StaleBacksolveRow {
  calculation_id: string;
  valuation_id: string;
  valuation_number: number;
  company_name: string;
  state: string;
  equity_value: string | null;
  fmv_per_share: string | null;
  options_outstanding: number | null;
  calculated_at: string;
  has_rendered_report: boolean;
  published: boolean;
}

interface StaleQaRow {
  review_id: string;
  valuation_id: string;
  valuation_number: number;
  company_name: string;
  state: string;
  dlom_method: string | null;
  applied_dlom: string | null;
  review_status: string;
  reviewed_at: string;
  published: boolean;
}

interface Remediation {
  stale_backsolves: {
    rows: StaleBacksolveRow[];
    total: number;
    published: number;
    rerunnable: number;
    truncated: boolean;
    page_limit: number;
    description: string;
  };
  stale_qa_reviews: {
    rows: StaleQaRow[];
    total: number;
    published: number;
    truncated: boolean;
    page_limit: number;
    description: string;
  };
  max_rerun: number;
}

/**
 * A capped table has to say so, and has to say what the counts above it mean.
 * The stat cards are platform-wide totals counted in SQL; the table is a page.
 * Without this the two disagree and the smaller number reads as the truth.
 */
function QueueTruncationNote({ shown, total, label }: { shown: number; total: number; label: string }) {
  return (
    <p className="border-t border-paper-300 px-4 py-3 text-sm text-ink-600">
      Showing {shown} of {total} {label}. The totals above are the whole queue; the table is a page.
    </p>
  );
}

function PublishedTag() {
  return (
    <span
      className="rounded-full bg-amber-50 px-2 py-0.5 text-[0.65rem] font-semibold text-amber-800 ring-1 ring-amber-200 ring-inset"
      title="Published — never re-run automatically"
    >
      published
    </span>
  );
}

function pct(value: string | null): string {
  const n = Number(value);
  return Number.isFinite(n) ? `${(n * 100).toFixed(1)}%` : '—';
}

export function AdminDataRemediationPage() {
  const [data, setData] = useState<Remediation | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { token, retryProps } = useRetry(() => setError(null));
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await api<Remediation>('/admin/data-remediation'));
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 403
          ? 'Data remediation is operations-only.'
          : 'Could not load the remediation queues.',
      );
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, token]);

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const rerun = async () => {
    setBusy(true);
    setNote(null);
    try {
      const result = await api<{ succeeded: number; failed: number; results: Array<{ error?: string }> }>(
        '/admin/data-remediation/rerun',
        { method: 'POST', body: { valuation_ids: [...selected] } },
      );
      setNote(
        result.failed === 0
          ? `Re-ran ${result.succeeded} engagement${result.succeeded === 1 ? '' : 's'}.`
          : `${result.succeeded} re-ran, ${result.failed} failed (${
              result.results.find((r) => r.error)?.error ?? 'see log'
            }).`,
      );
      setSelected(new Set());
      await load();
    } catch (err) {
      setNote(describeActionFailure(err, 'The re-run failed.'));
    } finally {
      setBusy(false);
    }
  };

  if (error) return <LoadError message={error} {...retryProps} />;
  if (!data) return <Spinner />;

  const backsolves = data.stale_backsolves;
  const reviews = data.stale_qa_reviews;
  const rerunnable = backsolves.rows.filter((r) => !r.published);
  const overLimit = selected.size > data.max_rerun;

  return (
    <div>
      <h1 className="font-display text-3xl font-semibold text-ink-900">Data remediation</h1>
      <p className="mt-2 max-w-3xl text-sm text-ink-500">
        Stored results computed before an engine or a check changed. Unpublished engagements can be re-run
        here. Published ones are listed and never re-run automatically — a published opinion is a signed
        document, and correcting it is a decision to record against the engagement, not a sweep.
      </p>

      <div className="mt-6 grid gap-4 sm:grid-cols-3">
        <StatCard label="Stale backsolves" value={String(backsolves.total)} />
        <StatCard label="Re-runnable" value={String(backsolves.rerunnable)} />
        <StatCard label="Stale QA reviews" value={String(reviews.total)} />
      </div>

      {/* ── Stale backsolves ─────────────────────────────────────────────── */}
      <section className="mt-10">
        <h2 className="font-display text-xl font-semibold text-ink-900">Stale backsolved equity values</h2>
        <p className="mt-1 max-w-3xl text-sm text-ink-500">{backsolves.description}</p>

        {note && (
          <p role="status" className="mt-3 text-sm font-medium text-bond-700">
            {note}
          </p>
        )}

        {rerunnable.length > 0 && (
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <Button onClick={() => void rerun()} disabled={busy || selected.size === 0 || overLimit}>
              {busy
                ? 'Re-running…'
                : `Re-run ${selected.size} selected engagement${selected.size === 1 ? '' : 's'}`}
            </Button>
            <button
              onClick={() =>
                setSelected(new Set(rerunnable.slice(0, data.max_rerun).map((r) => r.valuation_id)))
              }
              className="cursor-pointer text-sm font-semibold text-bond-600 hover:text-bond-700"
            >
              Select all re-runnable
            </button>
            {overLimit && (
              <span className="text-sm text-red-700">
                At most {data.max_rerun} at a time — each is a full engine run.
              </span>
            )}
          </div>
        )}

        {backsolves.rows.length === 0 ? (
          <div className="mt-4">
            <EmptyState title="Nothing affected">
              No stored calculation took the single-breakpoint backsolve with a live option pool.
            </EmptyState>
          </div>
        ) : (
          <div className="mt-4 overflow-x-auto overscroll-x-contain rounded-lg border border-paper-300 bg-surface shadow-card">
            <table className="w-full text-left text-sm">
              <caption className="sr-only">Affected backsolve calculations</caption>
              <thead>
                <tr className="border-b border-paper-300 text-xs text-ink-400">
                  <th className="w-10 py-2 pl-4" />
                  <th className="py-2 pr-4 font-semibold">Engagement</th>
                  <th className="py-2 pr-4 font-semibold">State</th>
                  <th className="py-2 pr-4 text-right font-semibold">Stored equity</th>
                  <th className="py-2 pr-4 text-right font-semibold">Option pool</th>
                  <th className="py-2 pr-4 font-semibold">Report rendered</th>
                  <th className="py-2 pr-4 font-semibold">Calculated</th>
                </tr>
              </thead>
              <tbody>
                {backsolves.rows.map((row) => (
                  <tr key={row.calculation_id} className="border-b border-paper-200 last:border-0">
                    <td className="py-2 pl-4">
                      <input
                        type="checkbox"
                        aria-label={`Select ${row.company_name}`}
                        disabled={row.published}
                        checked={selected.has(row.valuation_id)}
                        onChange={() => toggle(row.valuation_id)}
                      />
                    </td>
                    <td className="py-2 pr-4">
                      <Link
                        to={`/valuations/${row.valuation_id}/calculations`}
                        className="font-medium text-bond-600 hover:text-bond-700"
                      >
                        #{row.valuation_number} {row.company_name}
                      </Link>
                    </td>
                    <td className="py-2 pr-4">
                      <div className="flex items-center gap-2">
                        <span className="text-ink-600">{row.state.replace(/_/g, ' ')}</span>
                        {row.published && <PublishedTag />}
                      </div>
                    </td>
                    <td className="tnum py-2 pr-4 text-right text-ink-800">
                      {formatNumber(row.equity_value)}
                    </td>
                    <td className="tnum py-2 pr-4 text-right text-ink-600">
                      {formatNumber(row.options_outstanding)}
                    </td>
                    <td className="py-2 pr-4 text-ink-600">
                      {/* The column that decides how much the row matters: an
                          affected calculation nobody rendered is a number in a
                          table; one behind a rendered PDF is a statement made. */}
                      {row.has_rendered_report ? 'yes' : 'no'}
                    </td>
                    <td className="tnum py-2 pr-4 text-xs text-ink-400">
                      {formatDateTime(row.calculated_at)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {backsolves.truncated && (
              <QueueTruncationNote
                shown={backsolves.rows.length}
                total={backsolves.total}
                label="affected calculations"
              />
            )}
          </div>
        )}
      </section>

      {/* ── Stale QA reviews ─────────────────────────────────────────────── */}
      <section className="mt-12">
        <h2 id="stale-qa-reviews-heading" className="font-display text-xl font-semibold text-ink-900">
          Stale QA reviews
        </h2>
        <p className="mt-1 max-w-3xl text-sm text-ink-500">{reviews.description}</p>

        {reviews.rows.length === 0 ? (
          <div className="mt-4">
            <EmptyState title="Nothing affected">
              Every model-DLOM run’s latest review carries a DLOM-range check.
            </EmptyState>
          </div>
        ) : (
          <div className="mt-4 overflow-x-auto overscroll-x-contain rounded-lg border border-paper-300 bg-surface shadow-card">
            <table className="w-full text-left text-sm" aria-labelledby="stale-qa-reviews-heading">
              <thead>
                <tr className="border-b border-paper-300 text-xs text-ink-400">
                  <th className="py-2 pl-4 pr-4 font-semibold">Engagement</th>
                  <th className="py-2 pr-4 font-semibold">State</th>
                  <th className="py-2 pr-4 font-semibold">DLOM method</th>
                  <th className="py-2 pr-4 text-right font-semibold">Applied DLOM</th>
                  <th className="py-2 pr-4 font-semibold">Review</th>
                  <th className="py-2 pr-4 font-semibold">Reviewed</th>
                </tr>
              </thead>
              <tbody>
                {reviews.rows.map((row) => (
                  <tr key={row.review_id} className="border-b border-paper-200 last:border-0">
                    <td className="py-2 pl-4 pr-4">
                      <Link
                        to={`/valuations/${row.valuation_id}/qa`}
                        className="font-medium text-bond-600 hover:text-bond-700"
                      >
                        #{row.valuation_number} {row.company_name}
                      </Link>
                    </td>
                    <td className="py-2 pr-4">
                      <div className="flex items-center gap-2">
                        <span className="text-ink-600">{row.state.replace(/_/g, ' ')}</span>
                        {row.published && <PublishedTag />}
                      </div>
                    </td>
                    <td className="py-2 pr-4 text-ink-600">{row.dlom_method ?? '—'}</td>
                    <td
                      className={`tnum py-2 pr-4 text-right ${
                        Number(row.applied_dlom) > 0.35 ? 'font-semibold text-amber-700' : 'text-ink-800'
                      }`}
                    >
                      {pct(row.applied_dlom)}
                    </td>
                    <td className="py-2 pr-4 text-ink-600">{row.review_status}</td>
                    <td className="tnum py-2 pr-4 text-xs text-ink-400">{formatDateTime(row.reviewed_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {reviews.truncated && (
              <QueueTruncationNote
                shown={reviews.rows.length}
                total={reviews.total}
                label="affected reviews"
              />
            )}
          </div>
        )}
        <p className="mt-3 max-w-3xl text-xs text-ink-400">
          Re-running the QA checks on an unpublished engagement clears its row. A published one needs the
          discount re-examined and the outcome recorded on the engagement’s decision log — the gate cannot be
          re-opened retrospectively.
        </p>
      </section>
    </div>
  );
}
