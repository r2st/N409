import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api, ApiError } from '../../lib/api';
import { useWorkspace } from './ValuationWorkspace';
import { Button, EmptyState, ErrorNote, Field, Spinner, TextInput } from '../../components/ui';

/**
 * Network Items — the guideline-company peer set (design §4.5).
 *
 * The set was always computed and never kept: the sixteen `market_comparables`
 * overwrite fields held the aggregate, and the individual companies an analyst
 * screened to get there existed nowhere. This tab is the record. The column
 * that earns it is not the multiple — it is the exclusion reason, because
 * "which companies did you consider and why is Acme not in here" is the first
 * question a market approach is challenged on.
 */

type MultipleKey = 'ev_revenue_ltm' | 'ev_revenue_ntm' | 'ev_ebitda_ltm' | 'ev_ebitda_ntm';

const MULTIPLE_LABELS: Record<MultipleKey, string> = {
  ev_revenue_ltm: 'EV/LTM Rev',
  ev_revenue_ntm: 'EV/NTM Rev',
  ev_ebitda_ltm: 'EV/LTM EBITDA',
  ev_ebitda_ntm: 'EV/NTM EBITDA',
};

const SOURCE_LABELS: Record<string, string> = {
  ai: 'AI',
  analyst: 'Analyst',
  market_feed: 'Screen',
};

interface Comparable {
  id: string;
  ticker: string | null;
  name: string;
  sic: string | null;
  source: string;
  included: boolean;
  exclude_reason: string | null;
  ev: number | null;
  revenue_ltm: number | null;
  revenue_ntm: number | null;
  ebitda_ltm: number | null;
  ebitda_ntm: number | null;
  score: number | null;
  multiples: Record<MultipleKey, number | null>;
}

interface MultipleSummary {
  key: MultipleKey;
  label: string;
  count: number;
  median: number | null;
  min: number | null;
  max: number | null;
}

interface ComparablesResponse {
  comparables: Comparable[];
  statistics: Record<MultipleKey, MultipleSummary>;
  primary_multiple: MultipleKey;
  market_method: string | null;
  market_horizon: string | null;
  can_edit: boolean;
}

const MULTIPLE_ORDER: MultipleKey[] = ['ev_revenue_ltm', 'ev_revenue_ntm', 'ev_ebitda_ltm', 'ev_ebitda_ntm'];

function multiple(value: number | null | undefined): string {
  return typeof value === 'number' ? `${value.toFixed(2)}x` : '—';
}

/** Optional money input → a number or null; a blank field means "not known". */
function money(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  const n = Number(trimmed.replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

function SourceBadge({ source }: { source: string }) {
  const tone =
    source === 'analyst'
      ? 'bg-bond-50 text-bond-700 ring-bond-200'
      : 'bg-paper-100 text-ink-500 ring-paper-300';
  return (
    <span className={`rounded-full px-2 py-0.5 text-[0.7rem] font-semibold ring-1 ring-inset ${tone}`}>
      {SOURCE_LABELS[source] ?? source}
    </span>
  );
}

export function ComparablesTab() {
  const { valuation } = useWorkspace();
  const [data, setData] = useState<ComparablesResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** The row whose exclusion reason is being collected, if any. */
  const [excluding, setExcluding] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState({ ticker: '', name: '', sic: '', ev: '', revenue: '', ebitda: '' });

  const load = useCallback(async () => {
    try {
      setData(await api<ComparablesResponse>(`/valuations/${valuation.id}/comparables`));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load the comparable set.');
    }
  }, [valuation.id]);

  useEffect(() => {
    void load();
  }, [load]);

  const run = async (work: () => Promise<unknown>, failure: string) => {
    setBusy(true);
    setError(null);
    try {
      await work();
      await load();
      return true;
    } catch (err) {
      setError(err instanceof ApiError ? err.message : failure);
      return false;
    } finally {
      setBusy(false);
    }
  };

  const include = (row: Comparable) =>
    run(
      () =>
        api(`/valuations/${valuation.id}/comparables/${row.id}`, {
          method: 'PATCH',
          body: { included: true },
        }),
      'Could not include the comparable.',
    );

  const exclude = async (e: FormEvent) => {
    e.preventDefault();
    if (!excluding) return;
    const ok = await run(
      () =>
        api(`/valuations/${valuation.id}/comparables/${excluding}`, {
          method: 'PATCH',
          body: { included: false, exclude_reason: reason.trim() },
        }),
      'Could not exclude the comparable.',
    );
    if (ok) {
      setExcluding(null);
      setReason('');
    }
  };

  const remove = (row: Comparable) =>
    run(
      () => api(`/valuations/${valuation.id}/comparables/${row.id}`, { method: 'DELETE' }),
      'Could not remove the comparable.',
    );

  const screen = () =>
    run(
      () => api(`/valuations/${valuation.id}/comparables/screen`, { method: 'POST', body: {} }),
      'Could not re-screen the comparable set.',
    );

  const addPeer = async (e: FormEvent) => {
    e.preventDefault();
    const ok = await run(
      () =>
        api(`/valuations/${valuation.id}/comparables`, {
          method: 'POST',
          body: {
            ticker: draft.ticker.trim() || null,
            name: draft.name.trim(),
            sic: draft.sic.trim() || null,
            ev: money(draft.ev),
            revenue_ltm: money(draft.revenue),
            ebitda_ltm: money(draft.ebitda),
          },
        }),
      'Could not add the comparable.',
    );
    if (ok) {
      setDraft({ ticker: '', name: '', sic: '', ev: '', revenue: '', ebitda: '' });
      setAdding(false);
    }
  };

  if (error && !data) return <ErrorNote>{error}</ErrorNote>;
  if (!data) return <Spinner />;

  const included = data.comparables.filter((c) => c.included);
  const primary = data.statistics[data.primary_multiple];
  // Only the multiples some retained comp actually has: a column of dashes
  // says nothing about the set.
  const columns = MULTIPLE_ORDER.filter((key) => included.some((c) => typeof c.multiples[key] === 'number'));

  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h2 className="overline text-ink-400">Guideline company set</h2>
          <p className="mt-1 max-w-2xl text-sm text-ink-400">
            The peer set behind the market approach. Excluded companies stay on the list with the reason they
            were set aside — that record is what the exhibit and the evidence bundle carry.
          </p>
        </div>
        {data.can_edit && (
          <div className="flex gap-2">
            <Button variant="ghost" onClick={() => setAdding((v) => !v)} disabled={busy}>
              {adding ? 'Cancel' : '+ Add peer'}
            </Button>
            <Button onClick={screen} disabled={busy}>
              Re-screen
            </Button>
          </div>
        )}
      </div>

      {error && (
        <div className="mt-4">
          <ErrorNote>{error}</ErrorNote>
        </div>
      )}

      {/* The figure the engine will select, stated rather than left to inference:
          which of the four multiples applies depends on two params fields that
          live on another tab. */}
      <div className="mt-6 flex flex-wrap gap-4">
        <div className="rounded-lg border border-paper-300 bg-surface px-5 py-4 shadow-card">
          <div className="overline text-ink-400">{primary?.label ?? 'Primary multiple'} — median</div>
          <div className="tnum mt-1 font-display text-2xl font-semibold text-ink-900">
            {multiple(primary?.median)}
          </div>
          <div className="mt-1 text-xs text-ink-400">
            {primary?.count ?? 0} of {data.comparables.length} companies
            {primary && primary.count > 0 && (
              <>
                {' · '}
                {multiple(primary.min)}–{multiple(primary.max)}
              </>
            )}
          </div>
        </div>
      </div>

      {adding && data.can_edit && (
        <form
          onSubmit={addPeer}
          className="mt-6 grid gap-4 rounded-lg border border-paper-300 bg-surface p-5 shadow-card sm:grid-cols-3"
        >
          <Field label="Company name">
            <TextInput
              required
              value={draft.name}
              onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
            />
          </Field>
          <Field label="Ticker">
            <TextInput
              value={draft.ticker}
              onChange={(e) => setDraft((d) => ({ ...d, ticker: e.target.value }))}
            />
          </Field>
          <Field label="SIC">
            <TextInput value={draft.sic} onChange={(e) => setDraft((d) => ({ ...d, sic: e.target.value }))} />
          </Field>
          <Field label="Enterprise value">
            <TextInput
              inputMode="decimal"
              value={draft.ev}
              onChange={(e) => setDraft((d) => ({ ...d, ev: e.target.value }))}
            />
          </Field>
          <Field label="LTM revenue">
            <TextInput
              inputMode="decimal"
              value={draft.revenue}
              onChange={(e) => setDraft((d) => ({ ...d, revenue: e.target.value }))}
            />
          </Field>
          <Field label="LTM EBITDA">
            <TextInput
              inputMode="decimal"
              value={draft.ebitda}
              onChange={(e) => setDraft((d) => ({ ...d, ebitda: e.target.value }))}
            />
          </Field>
          <div className="sm:col-span-3">
            <Button type="submit" disabled={busy}>
              Add comparable
            </Button>
          </div>
        </form>
      )}

      {data.comparables.length === 0 ? (
        <div className="mt-6">
          <EmptyState title="No comparables recorded">
            Run a screen to pull the guideline set from the reference universe, or add a peer by hand. Until
            then the market approach uses the summarised multiples from the AI comp-selection run.
          </EmptyState>
        </div>
      ) : (
        <div className="mt-6 overflow-x-auto rounded-lg border border-paper-300 bg-surface shadow-card">
          <table className="w-full min-w-[720px] text-sm" aria-label="Comparable companies">
            <thead>
              <tr className="border-b border-paper-300 text-left">
                <th className="overline px-5 py-3 font-semibold text-ink-400">Company</th>
                {columns.map((key) => (
                  <th key={key} className="overline px-4 py-3 text-right font-semibold text-ink-400">
                    {MULTIPLE_LABELS[key]}
                  </th>
                ))}
                <th className="overline px-4 py-3 text-right font-semibold text-ink-400">Score</th>
                <th className="overline px-5 py-3 font-semibold text-ink-400">Status</th>
                {data.can_edit && <th className="px-5 py-3" />}
              </tr>
            </thead>
            <tbody>
              {data.comparables.map((row) => (
                <tr
                  key={row.id}
                  className={`border-b border-paper-200 last:border-0 ${row.included ? '' : 'bg-paper-50 text-ink-400'}`}
                >
                  <td className="px-5 py-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium text-ink-900">{row.name}</span>
                      {row.ticker && <span className="tnum text-xs text-ink-400">{row.ticker}</span>}
                      <SourceBadge source={row.source} />
                    </div>
                  </td>
                  {columns.map((key) => (
                    <td key={key} className="tnum px-4 py-3 text-right">
                      {multiple(row.multiples[key])}
                    </td>
                  ))}
                  <td className="tnum px-4 py-3 text-right">
                    {row.score === null ? '—' : row.score.toFixed(2)}
                  </td>
                  <td className="px-5 py-3">
                    {row.included ? (
                      <span className="text-ink-500">Included</span>
                    ) : (
                      <span title={row.exclude_reason ?? undefined}>
                        Excluded — {row.exclude_reason ?? 'no reason recorded'}
                      </span>
                    )}
                  </td>
                  {data.can_edit && (
                    <td className="px-5 py-3 text-right whitespace-nowrap">
                      {row.included ? (
                        <Button variant="ghost" onClick={() => setExcluding(row.id)} disabled={busy}>
                          Exclude
                        </Button>
                      ) : (
                        <Button variant="ghost" onClick={() => include(row)} disabled={busy}>
                          Include
                        </Button>
                      )}
                      {/* A screened row is excluded, never deleted — the set has to
                          show what was considered. Only analyst rows offer this. */}
                      {row.source === 'analyst' && (
                        <Button variant="ghost" onClick={() => remove(row)} disabled={busy}>
                          Remove
                        </Button>
                      )}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {excluding && (
        <form
          onSubmit={exclude}
          className="mt-4 rounded-lg border border-paper-300 bg-surface p-5 shadow-card"
        >
          <Field label="Why is this company not comparable?">
            <TextInput
              required
              autoFocus
              value={reason}
              placeholder="e.g. different industry, acquired mid-period, pre-revenue"
              onChange={(e) => setReason(e.target.value)}
            />
          </Field>
          <div className="mt-3 flex gap-2">
            <Button type="submit" disabled={busy}>
              Exclude
            </Button>
            <Button
              variant="ghost"
              type="button"
              onClick={() => {
                setExcluding(null);
                setReason('');
              }}
            >
              Cancel
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}
