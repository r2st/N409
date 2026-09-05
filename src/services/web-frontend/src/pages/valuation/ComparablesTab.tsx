import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { required, useFormValidation } from '../../lib/useFormValidation';
import { api, describeActionFailure } from '../../lib/api';
import { useWorkspace } from './ValuationWorkspace';
import {
  Button,
  EmptyState,
  ErrorNote,
  Field,
  ListTruncationNote,
  LoadError,
  Spinner,
  TextInput,
  WriteGate,
  useRetry,
} from '../../components/ui';
import { VolatilityPanel } from '../../components/valuation/VolatilityPanel';

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
  /** Where the figures came from and when (migration 0133); null on older rows. */
  figures_source: 'snapshot' | 'live' | 'analyst' | null;
  figures_as_of: string | null;
}

/**
 * Where a row's figures came from — a different question from `source`, which
 * is who put the row in the set. An analyst reading a multiple has no way to
 * check it without this, and until the refresh existed the honest answer for
 * every row was the reference set.
 */
const FIGURES_LABELS: Record<string, string> = {
  snapshot: 'Reference',
  live: 'Market',
  analyst: 'Entered',
};

interface RefreshResponse {
  refreshed: Array<{ ticker: string; as_of: string }>;
  unavailable: Array<{ ticker: string; warning: string }>;
  /**
   * Comps that left the set while the refresh was running — deleted, or
   * replaced wholesale by a re-screen, both of which are ops actions taken from
   * this same screen. Distinct from `unavailable`: those rows kept the figures
   * they had, and these rows are not there to have kept anything. Said out loud
   * because the alternative is a note counting a company the table below no
   * longer shows.
   */
  dropped: string[];
  /**
   * Comps this press was asked to update and could not, because the write or
   * the guard in front of it threw. A third bucket because it is a third fact:
   * `unavailable` is the feed having nothing to give, `dropped` is the row
   * having gone, and this is the row still sitting there with the figures it
   * had and a press that could not say why in terms of the market. Reported
   * because the alternative was a 500 that also discarded the peers the same
   * press had already updated.
   */
  failed: Array<{ ticker: string; failure_reason: string }>;
  /**
   * Comps this press did not reach. The refresh leaves the process once per
   * ticker and the server caps how many it will fetch in one request, so a set
   * wider than `refresh_batch` comes back part-done — and a note reading
   * "Refreshed 25 companies" over a set of forty is the partial result
   * presented as the finished one. Oldest-first server-side, so pressing again
   * makes progress.
   */
  remaining: number;
  refresh_batch: number;
}

/**
 * `POST /valuations/:id/ai/comp_selection/apply`. `selected` is what landed
 * included; `excluded` is everything the agent named that did not, which is the
 * union of its own rejected half and the comps it chose that the market data
 * could not price — `unusable` counts that second group separately, because the
 * two are set aside for opposite reasons and only one of them is a judgement.
 *
 * `unverified` is a third reason and the only one that is about the agent's run
 * rather than about a company: the market-data service was unreachable, so the
 * agent fell back to the model's own suggestions and no ticker in the run was
 * checked against anything. Those rows want looking up, not filling in.
 */
interface CompSelectionApplied {
  applied: { selected: number; excluded: number; unusable: number; unverified?: number };
  written: number;
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
  /**
   * True when the peer set runs past `page_limit`. It matters more here than
   * on most lists: `statistics` is a median over the page, so a truncated set
   * states a multiple the whole set does not have.
   */
  truncated: boolean;
  page_limit: number;
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

/**
 * Renders the comparable-company table, up to `COMPARABLE_PAGE_LIMIT` (500)
 * rows.
 *
 * Memoized (R443, methodology M8): `ComparablesTab` holds the exclude-reason
 * form's `reason` and the add-peer form's `draft` in the same component that
 * renders this table below both forms, so every keystroke into either one
 * re-ran a 500-row map whose `comparables`/`columns` had not changed. `columns`
 * is itself derived with `useMemo` in the caller for the same reason —
 * recomputing a fresh array from `data` on every render would have handed this
 * component a new `columns` reference on every keystroke and defeated the
 * memo just as surely as an unmemoized table would have.
 */
export const ComparablesTable = memo(function ComparablesTable({
  comparables,
  columns,
  canEdit,
  retired,
  busy,
  onExclude,
  onInclude,
  onRemove,
}: {
  comparables: Comparable[];
  columns: MultipleKey[];
  canEdit: boolean;
  retired: boolean;
  busy: boolean;
  onExclude: (id: string) => void;
  onInclude: (row: Comparable) => void;
  onRemove: (row: Comparable) => void;
}) {
  return (
    <div className="mt-6 overflow-x-auto overscroll-x-contain rounded-lg border border-paper-300 bg-surface shadow-card">
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
            {canEdit && <th className="px-5 py-3" />}
          </tr>
        </thead>
        <tbody>
          {comparables.map((row) => (
            <tr
              key={row.id}
              className={`border-b border-paper-200 last:border-0 ${row.included ? '' : 'bg-paper-50 text-ink-400'}`}
            >
              <td className="px-5 py-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium text-ink-900">{row.name}</span>
                  {row.ticker && <span className="tnum text-xs text-ink-400">{row.ticker}</span>}
                  <SourceBadge source={row.source} />
                  {/* Where the figures came from, beside who chose the row —
                      a multiple cannot be checked without both. Absent on
                      rows written before the columns existed, and silence
                      is better than guessing a vintage for them. */}
                  {row.figures_source && (
                    <span
                      className="text-[0.7rem] text-ink-400"
                      title={row.figures_as_of ? `Figures as at ${row.figures_as_of.slice(0, 10)}` : undefined}
                    >
                      {FIGURES_LABELS[row.figures_source] ?? row.figures_source}
                    </span>
                  )}
                </div>
              </td>
              {columns.map((key) => (
                <td key={key} className="tnum px-4 py-3 text-right">
                  {multiple(row.multiples[key])}
                </td>
              ))}
              <td className="tnum px-4 py-3 text-right">{row.score === null ? '—' : row.score.toFixed(2)}</td>
              <td className="px-5 py-3">
                {row.included ? (
                  <span className="text-ink-500">Included</span>
                ) : (
                  <span title={row.exclude_reason ?? undefined}>
                    Excluded — {row.exclude_reason ?? 'no reason recorded'}
                  </span>
                )}
              </td>
              {canEdit && (
                <td className="px-5 py-3 text-right whitespace-nowrap">
                  {/* Inside the cell rather than around it: a `fieldset`
                      between `tr` and `td` is not a thing the HTML parser
                      will keep, and `display: contents` only hides that
                      from the layout. */}
                  <WriteGate closed={retired}>
                    {row.included ? (
                      <Button variant="ghost" onClick={() => onExclude(row.id)} disabled={busy}>
                        Exclude
                      </Button>
                    ) : (
                      <Button variant="ghost" onClick={() => onInclude(row)} disabled={busy}>
                        Include
                      </Button>
                    )}
                    {/* A screened row is excluded, never deleted — the set has to
                      show what was considered. Only analyst rows offer this. */}
                    {row.source === 'analyst' && (
                      <Button variant="ghost" onClick={() => onRemove(row)} disabled={busy}>
                        Remove
                      </Button>
                    )}
                  </WriteGate>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
});

export function ComparablesTab() {
  const { valuation, retired } = useWorkspace();
  const [data, setData] = useState<ComparablesResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { token, retryProps } = useRetry(() => setError(null));
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
      setError(describeActionFailure(err, 'Could not load the comparable set.'));
    }
  }, [valuation.id]);

  useEffect(() => {
    void load();
  }, [load, token]);

  const run = useCallback(async (work: () => Promise<unknown>, failure: string) => {
    setBusy(true);
    setError(null);
    try {
      await work();
      await load();
      return true;
    } catch (err) {
      setError(describeActionFailure(err, failure));
      return false;
    } finally {
      setBusy(false);
    }
  }, [load]);

  const include = useCallback(
    (row: Comparable) =>
      run(
        () =>
          api(`/valuations/${valuation.id}/comparables/${row.id}`, {
            method: 'PATCH',
            body: { included: true },
          }),
        'Could not include the comparable.',
      ),
    [run, valuation.id],
  );

  const excludeValidation = useFormValidation({ reason }, { reason: required('reason', 'A reason') });

  const exclude = excludeValidation.handleSubmit(async () => {
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
      excludeValidation.reset();
    }
  });

  const remove = useCallback(
    (row: Comparable) =>
      run(
        () => api(`/valuations/${valuation.id}/comparables/${row.id}`, { method: 'DELETE' }),
        'Could not remove the comparable.',
      ),
    [run, valuation.id],
  );

  const screen = () =>
    run(
      () => api(`/valuations/${valuation.id}/comparables/screen`, { method: 'POST', body: {} }),
      'Could not re-screen the comparable set.',
    );

  /*
   * A refresh that reaches no ticker is not an error the user should have to
   * read as one, so the per-ticker outcome is kept and shown rather than being
   * collapsed into the error line. The engine's feed degrades to a documented
   * fallback rather than failing, and a silent no-op would leave an analyst
   * believing they were now looking at observed market data.
   */
  const [feedNote, setFeedNote] = useState<string | null>(null);

  /**
   * Run the `comp_selection` agent and apply what it found to this set.
   *
   * Two calls, run then apply, because they are two endpoints — but one button,
   * because "discover peers" is one intention and a UI that made an analyst
   * press Apply after every run would only ever be pressed twice in a row.
   *
   * A failed run stops here rather than falling through to the apply. The apply
   * endpoint takes the *latest successful* run, so a fallback would quietly
   * write a set the analyst never asked for and had no way to date — the same
   * kind of silent staleness the `figures_source` column exists to prevent.
   */
  const [aiPhase, setAiPhase] = useState<'finding' | 'applying' | null>(null);
  const discover = async () => {
    setFeedNote(null);
    setAiPhase('finding');
    await run(async () => {
      try {
        await api(`/valuations/${valuation.id}/ai/comp_selection`, { method: 'POST' });
        setAiPhase('applying');
        const res = await api<CompSelectionApplied>(`/valuations/${valuation.id}/ai/comp_selection/apply`, {
          method: 'POST',
          body: {},
        });
        const { selected, excluded, unusable, unverified = 0 } = res.applied;
        setFeedNote(
          `Applied the AI peer set — ${selected} ${selected === 1 ? 'company' : 'companies'} included, ` +
            `${excluded} set aside` +
            (unusable > 0
              ? `, ${unusable} of those chosen by the agent but carrying no market figures to strike a ` +
                `multiple on`
              : '') +
            (unverified > 0
              ? `, ${unverified} chosen while the market-data service was unreachable and never ` +
                `verified — check those tickers exist before including them`
              : '') +
            '.',
        );
      } finally {
        setAiPhase(null);
      }
    }, 'Could not run the AI comparable agent.');
  };

  const refresh = async () => {
    setFeedNote(null);
    await run(async () => {
      const res = await api<RefreshResponse>(`/valuations/${valuation.id}/comparables/refresh`, {
        method: 'POST',
        body: {},
      });
      const done = res.refreshed.length;
      const missed = res.unavailable;
      const vanished = res.dropped ?? [];
      // Read defensively for the same reason `dropped` is: a tab served by an
      // older build must not render `undefined` into the note.
      const broke = res.failed ?? [];
      const errored =
        broke.length > 0
          ? ` ${broke.map((f) => f.ticker).join(', ')} could not be updated — ` +
            `${broke.length === 1 ? 'that row keeps the figures it had' : 'those rows keep the figures they had'}. ` +
            'Try again.'
          : '';
      const gone =
        vanished.length > 0
          ? ` ${vanished.join(', ')} left the set while the refresh was running, so ` +
            `${vanished.length === 1 ? 'it was' : 'they were'} not updated.`
          : '';
      const left =
        res.remaining > 0
          ? ` ${res.remaining} more ${res.remaining === 1 ? 'company was' : 'companies were'} not ` +
            `reached — one press fetches at most ${res.refresh_batch}, oldest first. Refresh again ` +
            'to continue.'
          : '';
      setFeedNote(
        (missed.length === 0
          ? `Refreshed ${done} ${done === 1 ? 'company' : 'companies'} from observed market data.`
          : `Refreshed ${done} of ${done + missed.length}. No live figures for ` +
            `${missed.map((m) => m.ticker).join(', ')} — those rows keep the figures they had.`) +
          gone +
          errored +
          left,
      );
    }, 'Could not refresh the comparable set from market data.');
  };

  /*
   * Only the name is checked. The three figure boxes run through `money`, which
   * maps anything unparseable to null — the same value a blank box sends — and
   * that is deliberate rather than an oversight: "n/a" is how an analyst writes
   * "not known", and a rule here would reject it. See the "sends an unparseable
   * figure as null rather than NaN" test, which fixes that behaviour.
   */
  const { errorFor, blurHandler, handleSubmit, reset } = useFormValidation(draft, {
    name: required('name', 'Company name'),
  });

  const addPeer = handleSubmit(async () => {
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
      reset();
    }
  });

  // `included`/`columns` feed the memoized table below, so they are derived
  // with useMemo against `data` alone — plain consts here would hand it a new
  // `columns` array (and so break its memoization) on every keystroke into
  // `reason` or `draft`, neither of which `data` depends on.
  const included = useMemo(() => data?.comparables.filter((c) => c.included) ?? [], [data]);
  // Only the multiples some retained comp actually has: a column of dashes
  // says nothing about the set.
  const columns = useMemo(
    () => MULTIPLE_ORDER.filter((key) => included.some((c) => typeof c.multiples[key] === 'number')),
    [included],
  );

  if (error && !data) return <LoadError message={error} {...retryProps} />;
  if (!data) return <Spinner />;

  const primary = data.statistics[data.primary_multiple];

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
        <WriteGate closed={retired}>
          {data.can_edit && (
            <div className="flex gap-2">
              <Button variant="ghost" onClick={() => setAdding((v) => !v)} disabled={busy}>
                {adding ? 'Cancel' : '+ Add peer'}
              </Button>
              <Button variant="ghost" onClick={refresh} disabled={busy}>
                Refresh from market
              </Button>
              <Button variant="ghost" onClick={discover} disabled={busy}>
                {aiPhase === 'finding'
                  ? 'Finding peers…'
                  : aiPhase === 'applying'
                    ? 'Applying…'
                    : 'Find peers with AI'}
              </Button>
              <Button onClick={screen} disabled={busy}>
                Re-screen
              </Button>
            </div>
          )}
        </WriteGate>
      </div>

      {error && (
        <div className="mt-4">
          <ErrorNote>{error}</ErrorNote>
        </div>
      )}

      {aiPhase === 'finding' && (
        <p className="mt-4 text-sm text-ink-500">
          Screening guideline companies and verifying their tickers against market data — free-tier models can
          take up to a minute…
        </p>
      )}

      {feedNote && (
        <div
          role="status"
          className="mt-4 rounded-lg border border-paper-300 bg-surface px-4 py-3 text-sm text-ink-500"
        >
          {feedNote}
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

      <WriteGate closed={retired}>
        {adding && data.can_edit && (
          <form
            onSubmit={addPeer}
            className="mt-6 grid gap-4 rounded-lg border border-paper-300 bg-surface p-5 shadow-card sm:grid-cols-3"
            noValidate
          >
            <Field label="Company name" error={errorFor('name')}>
              <TextInput
                required
                value={draft.name}
                onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
                onBlur={blurHandler('name')}
              />
            </Field>
            <Field label="Ticker">
              <TextInput
                value={draft.ticker}
                onChange={(e) => setDraft((d) => ({ ...d, ticker: e.target.value }))}
              />
            </Field>
            <Field label="SIC">
              <TextInput
                value={draft.sic}
                onChange={(e) => setDraft((d) => ({ ...d, sic: e.target.value }))}
              />
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
      </WriteGate>

      {data.comparables.length === 0 ? (
        <div className="mt-6">
          <EmptyState title="No comparables recorded">
            Run a screen to pull the guideline set from the reference universe, let the AI agent find peers,
            or add one by hand. Until then the market approach uses the summarised multiples from the AI
            comp-selection run.
          </EmptyState>
        </div>
      ) : (
        <ComparablesTable
          comparables={data.comparables}
          columns={columns}
          canEdit={data.can_edit}
          retired={retired}
          busy={busy}
          onExclude={setExcluding}
          onInclude={include}
          onRemove={remove}
        />
      )}

      {/* Included peers sort first, so a truncated set has dropped its
          excluded tail — the half an auditor asks about. */}
      <ListTruncationNote
        truncated={data.truncated}
        shown={data.comparables.length}
        noun="comparables"
        hint="the multiples above are struck on the peers listed"
      />

      <WriteGate closed={retired}>
        {excluding && (
          <form
            onSubmit={exclude}
            className="mt-4 rounded-lg border border-paper-300 bg-surface p-5 shadow-card"
            noValidate
          >
            <Field label="Why is this company not comparable?" error={excludeValidation.errorFor('reason')}>
              <TextInput
                required
                autoFocus
                value={reason}
                placeholder="e.g. different industry, acquired mid-period, pre-revenue"
                onChange={(e) => setReason(e.target.value)}
                onBlur={excludeValidation.blurHandler('reason')}
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
      </WriteGate>

      {/* On this tab rather than on Params, because the estimate is struck on
          the set above: an analyst changing which peers are included is one
          scroll away from seeing what it did to sigma. */}
      <WriteGate closed={retired}>
        <VolatilityPanel valuationId={valuation.id} />
      </WriteGate>
    </div>
  );
}
