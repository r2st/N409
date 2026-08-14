import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api, apiDownload, ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';
import { isOps } from '../lib/rbac';
import { displayName, formatDate, KIND_LABELS, SOURCE_LABELS, STATE_LABELS } from '../lib/format';
import { parseSortParam, serializeSort, sortIndicator, toggleSort } from '../lib/sort';
import type { SortableColumn } from '../lib/sort';
import { VALUATION_KINDS, VALUATION_STATES } from '../lib/types';
import type {
  BulkResult,
  NamedBucketCounts,
  NamedBucketDef,
  Partner,
  UserOption,
  ValuationList,
} from '../lib/types';
import {
  Button,
  EmptyState,
  ErrorNote,
  KindBadge,
  LoadingBlock,
  PickerOverflowNote,
  Select,
  Skeleton,
  SkeletonTable,
  StateBadge,
  TextInput,
} from '../components/ui';
import { HelpIcon } from '../components/HelpIcon';
import { SavedViews } from '../components/SavedViews';

const PER_PAGE = 25;

/** csv for data pipelines, pdf to circulate, xlsx for auditors who need to foot it. */
type ExportFormat = 'csv' | 'pdf' | 'xlsx';

/** Query params that drive the list (M3) — kept in the URL so views are shareable. */
const FILTER_KEYS = [
  'q',
  'state',
  'kind',
  'source',
  'paid_status',
  'reviewer_id',
  'partner_id',
  'created_from',
  'created_to',
  'due_from',
  'due_to',
  'unread',
] as const;

/** Clickable column header with the M4 multi-sort indicator (↑/↓ + priority). */
function SortableTh({
  column,
  label,
  sortParam,
  onSort,
}: {
  column: SortableColumn;
  label: string;
  sortParam: string;
  onSort: (column: SortableColumn) => void;
}) {
  const indicator = sortIndicator(parseSortParam(sortParam), column);
  return (
    <th className="overline px-5 py-3 font-semibold text-ink-400">
      <button
        onClick={() => onSort(column)}
        className="inline-flex cursor-pointer items-center gap-1 uppercase hover:text-ink-700"
        aria-label={`Sort by ${label}`}
      >
        {label}
        {indicator && (
          <span className="tnum text-bond-600">
            {indicator.dir === 'asc' ? '↑' : '↓'}
            {parseSortParam(sortParam).length > 1 ? indicator.position : ''}
          </span>
        )}
      </button>
    </th>
  );
}

export function ValuationsPage() {
  const { user } = useAuth();
  const ops = isOps(user);
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [data, setData] = useState<ValuationList | null>(null);
  const [counts, setCounts] = useState<NamedBucketCounts | null>(null);
  const [bucketDefs, setBucketDefs] = useState<NamedBucketDef[] | null>(null);
  const [reviewers, setReviewers] = useState<UserOption[]>([]);
  const [reviewersCapped, setReviewersCapped] = useState(false);
  const [partners, setPartners] = useState<Partner[]>([]);
  const [partnersCapped, setPartnersCapped] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const [qDraft, setQDraft] = useState(params.get('q') ?? '');

  // M4 — bulk actions (ops)
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkAction, setBulkAction] = useState('set_state');
  const [bulkState, setBulkState] = useState('started');
  const [bulkReviewer, setBulkReviewer] = useState('');
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkNote, setBulkNote] = useState<string | null>(null);

  /*
   * `bucket` is the nine named tabs (design §4.2); `group` is the old five-group
   * key, still read so saved views and links written against it keep working.
   * The tab strip drives `bucket`; a URL carrying only `group` still filters.
   */
  const bucket = params.get('bucket') ?? '';
  const group = params.get('group') ?? '';
  const sortParam = params.get('sort') ?? '';
  const page = Math.max(1, Number(params.get('page') ?? '1') || 1);

  // Everything except pagination/tab/sort, encoded once and reused by list/counts/export.
  const filterQuery = useMemo(() => {
    const q = new URLSearchParams();
    for (const key of FILTER_KEYS) {
      const value = params.get(key);
      if (value) q.set(key, value);
    }
    return q;
  }, [params]);

  const reload = useCallback(() => {
    setData(null);
    setError(null);
    const q = new URLSearchParams(filterQuery);
    if (bucket) q.set('bucket', bucket);
    if (group) q.set('group', group);
    if (sortParam) q.set('sort', sortParam);
    q.set('page', String(page));
    q.set('per_page', String(PER_PAGE));
    api<ValuationList>(`/valuations?${q}`)
      .then(setData)
      .catch(() => setError('Could not load valuations.'));
  }, [filterQuery, bucket, group, sortParam, page]);

  useEffect(reload, [reload]);

  // Live tab counts (M3) — refetched when any non-tab filter changes.
  const loadCounts = useCallback(() => {
    api<{ counts: NamedBucketCounts; buckets: NamedBucketDef[] }>(
      `/valuations/counts?buckets=named&${filterQuery}`,
    )
      .then((res) => {
        setCounts(res.counts);
        setBucketDefs(res.buckets);
      })
      .catch(() => setCounts(null));
  }, [filterQuery]);

  useEffect(loadCounts, [loadCounts]);

  useEffect(() => {
    if (!ops) return;
    api<{ options: UserOption[]; truncated: boolean }>('/users/options?group=ops')
      .then((res) => {
        setReviewers(res.options);
        setReviewersCapped(res.truncated);
      })
      .catch(() => {});
    api<{ partners: Partner[]; truncated: boolean }>('/partners')
      .then((res) => {
        setPartners(res.partners);
        setPartnersCapped(res.truncated);
      })
      .catch(() => {});
  }, [ops]);

  const setFilter = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    next.delete('page');
    setParams(next, { replace: true });
  };

  const clearFilters = () => {
    const next = new URLSearchParams();
    if (bucket) next.set('bucket', bucket);
    if (group) next.set('group', group);
    if (sortParam) next.set('sort', sortParam);
    setQDraft('');
    setParams(next, { replace: true });
  };

  const hasFilters = FILTER_KEYS.some((k) => params.get(k));

  const onSort = (column: SortableColumn) => {
    const specs = toggleSort(parseSortParam(sortParam), column);
    const next = new URLSearchParams(params);
    if (specs.length) next.set('sort', serializeSort(specs));
    else next.delete('sort');
    next.delete('page');
    setParams(next, { replace: true });
  };

  const toggleSelected = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const applyBulk = async () => {
    setBulkBusy(true);
    setBulkNote(null);
    try {
      const params: Record<string, unknown> = {};
      if (bulkAction === 'set_state') params.state = bulkState;
      if (bulkAction === 'assign_reviewer') params.reviewer_id = bulkReviewer.trim() || null;
      const body = { action: bulkAction, valuation_ids: [...selected], params };
      const result = await api<BulkResult>('/valuations/bulk-action', { method: 'POST', body });
      setBulkNote(
        result.failed === 0
          ? `Applied to ${result.succeeded} valuation${result.succeeded === 1 ? '' : 's'}.`
          : `${result.succeeded} succeeded, ${result.failed} failed (${result.results.find((r) => !r.ok)?.error ?? 'see log'}).`,
      );
      setSelected(new Set());
      reload();
      loadCounts();
    } catch (err) {
      setBulkNote(err instanceof ApiError ? err.message : 'Bulk action failed.');
    } finally {
      setBulkBusy(false);
    }
  };

  const exportAs = async (format: ExportFormat) => {
    setExportError(null);
    try {
      const q = new URLSearchParams(filterQuery);
      if (bucket) q.set('bucket', bucket);
      if (group) q.set('group', group);
      if (sortParam) q.set('sort', sortParam);
      q.set('format', format);
      await apiDownload(`/valuations/export?${q}`, `valuations.${format}`);
    } catch {
      setExportError('Export failed.');
    }
  };

  // Bulk export (improvement 5): download summaries of exactly the checked rows.
  const exportSelected = async (format: ExportFormat) => {
    setBulkNote(null);
    try {
      const q = new URLSearchParams({ ids: [...selected].join(','), format });
      await apiDownload(`/valuations/export?${q}`, `valuations-selected.${format}`);
    } catch {
      setBulkNote('Export of selected valuations failed.');
    }
  };

  const totalPages = data ? Math.max(1, Math.ceil(data.total / PER_PAGE)) : 1;
  const allOnPageSelected =
    Boolean(data?.valuations.length) && data!.valuations.every((v) => selected.has(v.id));

  /*
   * Served, not restated: the labels and the order come from
   * `domain/workflow.NAMED_BUCKETS`, which is the same definition the counts and
   * the row filter read. Two copies of this mapping would be two answers to
   * "how many are in progress", and the count on the tab and the rows behind it
   * would disagree — which is worse than not having the tab.
   */
  const tabs: Array<{ key: string; label: string }> = (bucketDefs ?? []).map((b) => ({
    key: b.key === 'all' ? '' : b.key,
    label: b.label,
  }));

  const scopedPartner = partners.find((p) => p.id === params.get('partner_id')) ?? null;

  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="overline flex items-center gap-1.5 text-ink-400">
            {ops ? 'Operations' : 'Portfolio'}
            <HelpIcon article="valuations-overview" />
          </div>
          <h1 className="mt-1 font-display text-3xl font-semibold text-ink-900">
            {ops ? 'All valuations' : 'Valuations'}
          </h1>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" onClick={() => navigate('/valuations/compare')}>
            Compare
          </Button>
          <Button variant="secondary" onClick={() => void exportAs('csv')}>
            Export CSV
          </Button>
          <Button variant="secondary" onClick={() => void exportAs('pdf')}>
            Export PDF
          </Button>
          <Button variant="secondary" onClick={() => void exportAs('xlsx')}>
            Export Excel
          </Button>
          <Button onClick={() => navigate('/valuations/new')}>+ New valuation</Button>
        </div>
      </div>

      {/* The partner-scoped listing says so (design §4.4). Every count and
          every tab on this page is scoped to the firm when `partner_id` is
          set, and a scoped listing that looks identical to the unscoped one is
          how an operator concludes a firm has four engagements in total. */}
      {ops && scopedPartner && (
        <div className="mt-6 flex flex-wrap items-center gap-3 rounded-lg border border-bond-200 bg-bond-50 px-4 py-2.5">
          <span className="text-sm text-bond-900">
            Scoped to <span className="font-semibold">{scopedPartner.name}</span> — counts and tabs below
            cover this firm only.
          </span>
          <Link
            to={`/admin/partners/${scopedPartner.id}`}
            className="text-sm font-semibold text-bond-700 hover:text-bond-800"
          >
            Firm page
          </Link>
          <button
            onClick={() => setFilter('partner_id', '')}
            className="cursor-pointer text-sm font-semibold text-ink-500 hover:text-ink-700"
          >
            Clear scope
          </button>
        </div>
      )}

      {/* Tabbed scopes with live counts (M3 feature 15) */}
      <div className="mt-6 flex flex-wrap gap-1 border-b border-paper-300" role="tablist">
        {tabs.map((tab) => {
          const active = bucket === tab.key;
          const count = counts ? counts[(tab.key || 'all') as keyof NamedBucketCounts] : null;
          return (
            <button
              key={tab.key || 'all'}
              role="tab"
              aria-selected={active}
              onClick={() => {
                // Switching tabs drops the legacy alias so the two cannot both
                // be in the URL saying different things.
                const next = new URLSearchParams(params);
                next.delete('group');
                if (tab.key) next.set('bucket', tab.key);
                else next.delete('bucket');
                next.delete('page');
                setParams(next, { replace: true });
              }}
              className={`cursor-pointer border-b-2 px-3.5 py-2 text-sm font-semibold transition-colors ${
                active
                  ? 'border-bond-600 text-bond-700'
                  : 'border-transparent text-ink-400 hover:border-ink-200 hover:text-ink-700'
              }`}
            >
              {tab.label}
              {count !== null && (
                <span
                  className={`tnum ml-2 rounded-full px-1.5 py-0.5 text-xs ${
                    active ? 'bg-bond-50 text-bond-700' : 'bg-paper-200 text-ink-600'
                  }`}
                >
                  {count}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* Saved views (feature-improvements §2) — sits above the filter bar
          because applying one rewrites everything below it. */}
      <SavedViews />

      {/* Filter bar (M3 feature 15) */}
      <form
        className="mt-4 flex flex-wrap items-end gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          setFilter('q', qDraft.trim());
        }}
      >
        <div className="w-full sm:w-72">
          <TextInput
            aria-label="Search"
            placeholder="Search id, #number, workflow, company…"
            value={qDraft}
            onChange={(e) => setQDraft(e.target.value)}
            onBlur={() => setFilter('q', qDraft.trim())}
          />
        </div>
        <Select
          aria-label="Filter by state"
          value={params.get('state') ?? ''}
          onChange={(e) => setFilter('state', e.target.value)}
          className="!w-auto min-w-36"
        >
          <option value="">All states</option>
          {VALUATION_STATES.map((s) => (
            <option key={s} value={s}>
              {STATE_LABELS[s]}
            </option>
          ))}
        </Select>
        <Select
          aria-label="Filter by kind"
          value={params.get('kind') ?? ''}
          onChange={(e) => setFilter('kind', e.target.value)}
          className="!w-auto min-w-36"
        >
          <option value="">All kinds</option>
          {VALUATION_KINDS.map((k) => (
            <option key={k} value={k}>
              {KIND_LABELS[k]}
            </option>
          ))}
        </Select>
        {ops && (
          <>
            <Select
              aria-label="Filter by reviewer"
              value={params.get('reviewer_id') ?? ''}
              onChange={(e) => setFilter('reviewer_id', e.target.value)}
              className="!w-auto min-w-36"
            >
              <option value="">Any reviewer</option>
              {reviewers.map((r) => (
                <option key={r.id} value={r.id}>
                  {displayName(r)}
                </option>
              ))}
              <PickerOverflowNote truncated={reviewersCapped} />
            </Select>
            <Select
              aria-label="Filter by partner"
              value={params.get('partner_id') ?? ''}
              onChange={(e) => setFilter('partner_id', e.target.value)}
              className="!w-auto min-w-36"
            >
              <option value="">Any partner</option>
              {partners.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
              <PickerOverflowNote truncated={partnersCapped} />
            </Select>
            <Select
              aria-label="Filter by source"
              value={params.get('source') ?? ''}
              onChange={(e) => setFilter('source', e.target.value)}
              className="!w-auto min-w-32"
            >
              <option value="">Any source</option>
              {(['partner', 'referral', 'ads', 'repeat'] as const).map((s) => (
                <option key={s} value={s}>
                  {SOURCE_LABELS[s]}
                </option>
              ))}
            </Select>
          </>
        )}
        <label className="block text-xs font-semibold text-ink-600">
          Created
          <div className="mt-1 flex items-center gap-1.5">
            <TextInput
              type="date"
              aria-label="Created from"
              value={params.get('created_from') ?? ''}
              onChange={(e) => setFilter('created_from', e.target.value)}
              className="!w-auto"
            />
            <span className="text-ink-400">–</span>
            <TextInput
              type="date"
              aria-label="Created to"
              value={params.get('created_to') ?? ''}
              onChange={(e) => setFilter('created_to', e.target.value)}
              className="!w-auto"
            />
          </div>
        </label>
        <label className="block text-xs font-semibold text-ink-600">
          Due
          <div className="mt-1 flex items-center gap-1.5">
            <TextInput
              type="date"
              aria-label="Due from"
              value={params.get('due_from') ?? ''}
              onChange={(e) => setFilter('due_from', e.target.value)}
              className="!w-auto"
            />
            <span className="text-ink-400">–</span>
            <TextInput
              type="date"
              aria-label="Due to"
              value={params.get('due_to') ?? ''}
              onChange={(e) => setFilter('due_to', e.target.value)}
              className="!w-auto"
            />
          </div>
        </label>
        <label className="flex items-center gap-1.5 pb-2 text-xs font-semibold text-ink-600">
          <input
            type="checkbox"
            className="h-4 w-4 accent-bond-600"
            checked={params.get('unread') === 'true'}
            onChange={(e) => setFilter('unread', e.target.checked ? 'true' : '')}
          />
          Unread only
        </label>
        {hasFilters && (
          <Button variant="ghost" type="button" onClick={clearFilters}>
            Clear filters
          </Button>
        )}
        <button type="submit" hidden />
      </form>

      {exportError && (
        <div className="mt-4">
          <ErrorNote>{exportError}</ErrorNote>
        </div>
      )}
      {error && (
        <div className="mt-6">
          <ErrorNote>{error}</ErrorNote>
        </div>
      )}
      {/*
       * The worklist is the page ops live on, and it reloads on every filter,
       * sort and page change — a centred spinner threw the table away and
       * moved the pagination up the viewport each time. The placeholder holds
       * the same two layouts the loaded list uses, so nothing jumps.
       */}
      {!data && !error && (
        <LoadingBlock label="Loading valuations…">
          <ul aria-hidden className="mt-6 space-y-3 md:hidden">
            {Array.from({ length: 5 }, (_, i) => (
              <li key={i} className="rounded-lg border border-paper-300 bg-surface p-4 shadow-card">
                <Skeleton className="h-4 w-2/3" />
                <Skeleton className="mt-2.5 h-3 w-1/3" />
                <div className="mt-3 flex gap-2">
                  <Skeleton className="h-5 w-16" />
                  <Skeleton className="h-5 w-20" />
                </div>
              </li>
            ))}
          </ul>
          <div className="mt-6 hidden rounded-lg border border-paper-300 bg-surface shadow-card md:block">
            <SkeletonTable columns={ops ? 9 : 7} rows={8} />
          </div>
        </LoadingBlock>
      )}

      {/* M4 — bulk action bar (ops) */}
      {ops && selected.size > 0 && (
        <div className="mt-5 flex flex-wrap items-center gap-3 rounded-lg border border-bond-200 bg-bond-50 px-4 py-3">
          <span className="tnum text-sm font-semibold text-ink-800">{selected.size} selected</span>
          <Select
            aria-label="Bulk action"
            value={bulkAction}
            onChange={(e) => setBulkAction(e.target.value)}
            className="!w-auto"
          >
            <option value="set_state">Set state</option>
            <option value="assign_reviewer">Assign reviewer</option>
            <option value="advance">Auto-advance</option>
            <option value="restart">Restart</option>
          </Select>
          {bulkAction === 'set_state' && (
            <Select
              aria-label="Bulk target state"
              value={bulkState}
              onChange={(e) => setBulkState(e.target.value)}
              className="!w-auto"
            >
              {VALUATION_STATES.map((s) => (
                <option key={s} value={s}>
                  {STATE_LABELS[s]}
                </option>
              ))}
            </Select>
          )}
          {bulkAction === 'assign_reviewer' && (
            <Select
              aria-label="Bulk reviewer"
              value={bulkReviewer}
              onChange={(e) => setBulkReviewer(e.target.value)}
              className="!w-auto min-w-52"
            >
              <option value="">Unassign</option>
              {reviewers.map((r) => (
                <option key={r.id} value={r.id}>
                  {displayName(r)}
                </option>
              ))}
              <PickerOverflowNote truncated={reviewersCapped} />
            </Select>
          )}
          <Button disabled={bulkBusy} onClick={() => void applyBulk()}>
            {bulkBusy ? 'Applying…' : 'Apply'}
          </Button>
          <Button variant="secondary" onClick={() => void exportSelected('csv')}>
            Export selected CSV
          </Button>
          <Button variant="secondary" onClick={() => void exportSelected('pdf')}>
            Export selected PDF
          </Button>
          <Button variant="secondary" onClick={() => void exportSelected('xlsx')}>
            Export selected Excel
          </Button>
          <Button variant="ghost" onClick={() => setSelected(new Set())}>
            Clear
          </Button>
        </div>
      )}
      {bulkNote && <div className="mt-3 text-sm text-ink-600">{bulkNote}</div>}

      {data && data.valuations.length === 0 && (
        <div className="mt-6">
          <EmptyState
            title={hasFilters || bucket || group ? 'Nothing matches these filters' : 'No valuations yet'}
          >
            {hasFilters || bucket || group ? (
              'Try clearing a filter.'
            ) : (
              <Link to="/onboarding" className="font-semibold text-bond-600 hover:text-bond-700">
                Start your first valuation — we'll guide you through it
              </Link>
            )}
          </EmptyState>
        </div>
      )}

      {/* Mobile / tablet-portrait: card list (improvement 7) — table below md is unusable */}
      {data && data.valuations.length > 0 && (
        <ul className="mt-6 space-y-3 md:hidden" aria-label="Valuations">
          {data.valuations.map((v) => (
            <li key={v.id}>
              <div
                onClick={() => navigate(`/valuations/${v.id}`)}
                className="cursor-pointer rounded-lg border border-paper-300 bg-surface p-4 shadow-card transition-shadow active:shadow-lift"
              >
                <div className="flex items-start gap-3">
                  {ops && (
                    <input
                      type="checkbox"
                      aria-label={`Select ${v.company_name}`}
                      className="mt-1 h-5 w-5 shrink-0 accent-bond-600"
                      checked={selected.has(v.id)}
                      onClick={(e) => e.stopPropagation()}
                      onChange={() => toggleSelected(v.id)}
                    />
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline gap-2">
                      {v.unread && (
                        <span
                          aria-label="Unread activity"
                          className="h-2 w-2 shrink-0 self-center rounded-full bg-bond-600"
                        />
                      )}
                      <span className="truncate font-display text-[1.05rem] font-semibold text-ink-900">
                        {v.company_name}
                      </span>
                      <span className="tnum shrink-0 text-xs text-ink-400">#{v.number ?? '—'}</span>
                    </div>
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      <KindBadge kind={v.kind} />
                      <StateBadge state={v.state} />
                      {v.waiting_on_client && (
                        <span className="text-xs font-medium text-amber-700">Waiting on client</span>
                      )}
                      {ops && v.paid_status === 'unpaid' && (
                        <span className="text-xs font-semibold text-red-600">Unpaid</span>
                      )}
                      {ops && v.partner_id && (
                        <span className="rounded-full bg-paper-200 px-1.5 py-0.5 text-[0.65rem] font-semibold text-ink-500 ring-1 ring-ink-200 ring-inset">
                          Partner
                        </span>
                      )}
                    </div>
                    <div className="tnum mt-2 text-xs text-ink-400">
                      Created {formatDate(v.created_at)}
                      {v.due_date && <> · due {formatDate(v.due_date)}</>}
                    </div>
                  </div>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}

      {data && data.valuations.length > 0 && (
        <div className="mt-6 hidden overflow-x-auto rounded-lg border border-paper-300 bg-surface shadow-card md:block">
          <table className="w-full min-w-[760px] text-sm">
            <thead>
              <tr className="border-b border-paper-300 text-left">
                {ops && (
                  <th className="px-4 py-3">
                    <input
                      type="checkbox"
                      aria-label="Select all on page"
                      className="h-4 w-4 accent-bond-600"
                      checked={allOnPageSelected}
                      onChange={() =>
                        setSelected((prev) => {
                          const next = new Set(prev);
                          if (allOnPageSelected) data.valuations.forEach((v) => next.delete(v.id));
                          else data.valuations.forEach((v) => next.add(v.id));
                          return next;
                        })
                      }
                    />
                  </th>
                )}
                <SortableTh column="number" label="#" sortParam={sortParam} onSort={onSort} />
                <SortableTh column="company_name" label="Company" sortParam={sortParam} onSort={onSort} />
                <SortableTh column="kind" label="Kind" sortParam={sortParam} onSort={onSort} />
                <SortableTh column="state" label="State" sortParam={sortParam} onSort={onSort} />
                <SortableTh column="created_at" label="Created" sortParam={sortParam} onSort={onSort} />
                <SortableTh column="due_date" label="Due" sortParam={sortParam} onSort={onSort} />
                {ops && (
                  <SortableTh column="paid_status" label="Paid" sortParam={sortParam} onSort={onSort} />
                )}
                <th className="overline px-4 py-3 font-semibold text-ink-400" aria-label="Quick actions" />
              </tr>
            </thead>
            <tbody>
              {data.valuations.map((v) => (
                <tr
                  key={v.id}
                  onClick={() => navigate(`/valuations/${v.id}`)}
                  className="cursor-pointer border-b border-paper-200 last:border-0 hover:bg-paper-50"
                >
                  {ops && (
                    <td className="px-4 py-3.5" onClick={(e) => e.stopPropagation()}>
                      <input
                        type="checkbox"
                        aria-label={`Select ${v.company_name}`}
                        className="h-4 w-4 accent-bond-600"
                        checked={selected.has(v.id)}
                        onChange={() => toggleSelected(v.id)}
                      />
                    </td>
                  )}
                  <td className="tnum px-5 py-3.5 text-ink-400">{v.number ?? '—'}</td>
                  <td className="px-5 py-3.5">
                    <div className="flex items-center gap-2 font-semibold text-ink-900">
                      {v.unread && (
                        <span
                          aria-label="Unread activity"
                          title="New activity since you last opened this valuation"
                          className="h-2 w-2 shrink-0 rounded-full bg-bond-600"
                        />
                      )}
                      {/* The whole row is clickable, which is a mouse-only
                          affordance: a <tr onClick> is not focusable and has no
                          key binding, so opening a valuation from the worklist
                          was unreachable from the keyboard. The name is the
                          real link; the row click stays as a convenience. */}
                      <Link
                        to={`/valuations/${v.id}`}
                        onClick={(e) => e.stopPropagation()}
                        className="rounded-sm hover:underline focus-visible:ring-2 focus-visible:ring-bond-600/40 focus-visible:outline-none"
                      >
                        {v.company_name}
                      </Link>
                      {ops && v.partner_id && (
                        <span className="rounded-full bg-paper-200 px-1.5 py-0.5 text-[0.65rem] font-semibold text-ink-500 ring-1 ring-ink-200 ring-inset">
                          Partner
                        </span>
                      )}
                    </div>
                    {v.waiting_on_client && (
                      <div className="mt-0.5 text-xs font-medium text-amber-700">Waiting on client</div>
                    )}
                  </td>
                  <td className="px-5 py-3.5">
                    <KindBadge kind={v.kind} />
                  </td>
                  <td className="px-5 py-3.5">
                    <StateBadge state={v.state} />
                  </td>
                  <td className="tnum px-5 py-3.5 text-ink-600">{formatDate(v.created_at)}</td>
                  <td className="tnum px-5 py-3.5 text-ink-600">{formatDate(v.due_date)}</td>
                  {ops && (
                    <td className="px-5 py-3.5 text-ink-600">
                      {v.paid_status === 'unpaid' ? (
                        <span className="text-red-600">Unpaid</span>
                      ) : v.paid_status === 'paid_by_partner' ? (
                        'Partner'
                      ) : (
                        'Paid'
                      )}
                    </td>
                  )}
                  {/* Quick actions (gap 10) — jump straight to a tab without opening the overview */}
                  <td className="px-4 py-3.5 text-right" onClick={(e) => e.stopPropagation()}>
                    <div className="flex justify-end gap-3 text-xs font-semibold">
                      <Link
                        to={`/valuations/${v.id}/documents`}
                        aria-label={`Documents of ${v.company_name}`}
                        className="text-bond-600 hover:text-bond-700"
                      >
                        Docs
                      </Link>
                      <Link
                        to={`/valuations/${v.id}/report`}
                        aria-label={`Report of ${v.company_name}`}
                        className="text-bond-600 hover:text-bond-700"
                      >
                        Report
                      </Link>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {data && data.total > PER_PAGE && (
        <div className="mt-5 flex items-center justify-between text-sm text-ink-600">
          <span className="tnum">
            Page {data.page} of {totalPages} · {data.total} total
          </span>
          <div className="flex gap-2">
            <Button
              variant="secondary"
              disabled={page <= 1}
              onClick={() => {
                const next = new URLSearchParams(params);
                next.set('page', String(page - 1));
                setParams(next);
              }}
            >
              ← Previous
            </Button>
            <Button
              variant="secondary"
              disabled={page >= totalPages}
              onClick={() => {
                const next = new URLSearchParams(params);
                next.set('page', String(page + 1));
                setParams(next);
              }}
            >
              Next →
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
