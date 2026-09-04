import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api, apiDownload, describeActionFailure } from '../lib/api';
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
import { tabListKeyDown, tabProps } from '../lib/rovingFocus';
import { useLatestOnly } from '../lib/useLatestOnly';
import type { TagCatalogueCategory } from '../lib/tags';
import {
  Button,
  EmptyState,
  ErrorNote,
  KindBadge,
  LoadingBlock,
  PickerOverflowNote,
  ResultCount,
  Select,
  Skeleton,
  SkeletonTable,
  StateBadge,
  TextInput,
} from '../components/ui';
import { HelpIcon } from '../components/HelpIcon';
import { SavedViews } from '../components/SavedViews';

const PER_PAGE = 25;

/**
 * Said out-of-band because the CSV cannot say it in-band: a note row would be
 * data to anything parsing the file, and a spreadsheet honours no comment
 * syntax. The server has flagged this on `x-export-truncated` all along.
 */
const EXPORT_CAPPED =
  'The export hit the row cap — it holds the first rows only. Narrow the filters and export again for the rest.';

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
  // Engagement tags (parity gap #23). The API takes a comma-separated set and
  // requires every one of them to be *accepted*, so this key is plural even
  // though the control below sets one at a time — a URL somebody hand-edits to
  // `tags=saas,pre_revenue` keeps working, and the picker shows the first.
  'tags',
] as const;

/**
 * Clickable column header with the M4 multi-sort indicator (↑/↓ + priority).
 *
 * The whole sort state used to be carried by two glyphs and a digit inside a
 * span, and the button's `aria-label` was a fixed "Sort by Company" that
 * *replaced* them in the accessible name. So a screen reader user was told what
 * the control does and never which columns this list is actually ordered by, in
 * which direction, or in what priority — on the screen that is the platform's
 * primary index of every engagement. An arrow character is not a status: it is
 * announced as "upwards arrow", or at most verbosity settings not at all.
 *
 * The split is the one the ARIA sortable-table pattern prescribes. `aria-sort`
 * on the `th` is the state, which is what a screen reader reports when it
 * reaches the column; the glyphs become `aria-hidden` because they are now a
 * second rendering of it rather than the only one.
 *
 * Priority is the part `aria-sort` cannot express — it has no vocabulary for
 * "second key" — so it goes in the button's name, and only when there is more
 * than one key. Saying "sort priority 1 of 1" on every single-column sort would
 * be noise on the common case.
 */
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
  const specs = parseSortParam(sortParam);
  const indicator = sortIndicator(specs, column);
  const multi = specs.length > 1;
  return (
    <th
      className="overline px-5 py-3 font-semibold text-ink-400"
      aria-sort={indicator ? (indicator.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
    >
      <button
        onClick={() => onSort(column)}
        className="inline-flex cursor-pointer items-center gap-1 uppercase hover:text-ink-700"
        // Direction is deliberately not repeated here — the th above already
        // carries it, and a name that restates it makes every header announce
        // its sort twice.
        aria-label={
          indicator && multi
            ? `Sort by ${label}, sort priority ${indicator.position} of ${specs.length}`
            : `Sort by ${label}`
        }
      >
        {label}
        {indicator && (
          <span className="tnum text-bond-600" aria-hidden="true">
            {indicator.dir === 'asc' ? '↑' : '↓'}
            {multi ? indicator.position : ''}
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
  const [countsFailed, setCountsFailed] = useState(false);
  const [reviewers, setReviewers] = useState<UserOption[]>([]);
  const [reviewersCapped, setReviewersCapped] = useState(false);
  /*
   * The roster load failing has to be distinguishable from the roster being
   * empty, because the bulk bar reads the two the same way and acts on it.
   * `assign_reviewer` sends `bulkReviewer.trim() || null`, and `null` is
   * *unassign* — so with no options to choose from, a control labelled "Assign
   * reviewer" applied a bulk unassignment to every selected engagement, and the
   * only thing that had actually gone wrong was a GET nobody was told about.
   */
  const [reviewersFailed, setReviewersFailed] = useState(false);
  /** Same distinction for the organisation list, which only filters. */
  const [partnersFailed, setPartnersFailed] = useState(false);
  const [partners, setPartners] = useState<Partner[]>([]);
  const [partnersCapped, setPartnersCapped] = useState(false);
  /**
   * The tag vocabulary, for the filter picker. Never a hard-coded list: it is
   * served precisely so the picker and the `tagging` agent read one catalogue.
   * A failure leaves it empty, which hides the picker — an empty dropdown would
   * read as "this firm uses no tags" — and `tagsFailed` below says so in words.
   */
  const [tagCategories, setTagCategories] = useState<TagCatalogueCategory[]>([]);
  /**
   * Same distinction the reviewer and organisation rosters draw. A vocabulary
   * that failed to load and a firm that classifies nothing produce the same
   * empty picker, and hiding it silently tells an operator who knows the tags
   * exist that the filter was removed. Named, so the page can say which it is.
   */
  const [tagsFailed, setTagsFailed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const [exportNote, setExportNote] = useState<string | null>(null);
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

  /*
   * Both loads below are re-issued on every filter, tab, sort and page change,
   * which is the exact shape `useLatestOnly` exists for: nothing orders the
   * replies, and a slow reply for the previous filter set repaints the rows
   * under the current controls with nothing coming to correct it. See the hook.
   */
  const claimList = useLatestOnly();
  const claimCounts = useLatestOnly();

  const reload = useCallback(() => {
    const current = claimList();
    setData(null);
    setError(null);
    const q = new URLSearchParams(filterQuery);
    if (bucket) q.set('bucket', bucket);
    if (group) q.set('group', group);
    if (sortParam) q.set('sort', sortParam);
    q.set('page', String(page));
    q.set('per_page', String(PER_PAGE));
    api<ValuationList>(`/valuations?${q}`)
      .then((d) => current() && setData(d))
      .catch(() => current() && setError('Could not load valuations.'));
  }, [claimList, filterQuery, bucket, group, sortParam, page]);

  useEffect(reload, [reload]);

  // Live tab counts (M3) — refetched when any non-tab filter changes.
  const loadCounts = useCallback(() => {
    const current = claimCounts();
    api<{ counts: NamedBucketCounts; buckets: NamedBucketDef[] }>(
      `/valuations/counts?buckets=named&${filterQuery}`,
    )
      .then((res) => {
        if (!current()) return;
        setCounts(res.counts);
        setBucketDefs(res.buckets);
        setCountsFailed(false);
      })
      /*
       * `setCounts(null)` is the honest half — the badges then render as absent
       * rather than as zero, which they never should. What it does not cover is
       * `bucketDefs`, which comes from the same response and drives the scope
       * tab bar itself. On a first-load failure that stays null and `tabs` is
       * empty, so All / Open / In review / Drafted / Published / Closed — the
       * primary navigation of this page — simply is not there, and nothing says
       * why. The tabs are deliberately served rather than restated (see `tabs`
       * below), so the answer is to report the outage, not to hard-code a
       * second copy of the mapping.
       */
      .catch(() => {
        if (!current()) return;
        setCounts(null);
        setCountsFailed(true);
      });
  }, [claimCounts, filterQuery]);

  useEffect(loadCounts, [loadCounts]);

  useEffect(() => {
    api<{ categories?: TagCatalogueCategory[] }>('/tag-catalogue')
      // `res.categories` and not `res.categories ?? []` was a crash rather than
      // a missing filter: a 200 with the field absent put `undefined` into
      // state, and `.length` on it threw during render, taking the whole list
      // page down through the route boundary. A filter is optional; the page
      // it sits on is not.
      .then((res) => setTagCategories(Array.isArray(res.categories) ? res.categories : []))
      // Not a banner: the list beside it is entirely fine and one optional
      // filter is missing. But not silence either — see `tagsFailed`.
      .catch(() => setTagsFailed(true));
  }, []);

  useEffect(() => {
    if (!ops) return;
    api<{ options: UserOption[]; truncated: boolean }>('/users/options?group=ops')
      .then((res) => {
        setReviewers(res.options);
        setReviewersCapped(res.truncated);
      })
      .catch(() => setReviewersFailed(true));
    api<{ partners: Partner[]; truncated: boolean }>('/partners')
      .then((res) => {
        setPartners(res.partners);
        setPartnersCapped(res.truncated);
      })
      .catch(() => setPartnersFailed(true));
  }, [ops]);

  const setFilter = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    next.delete('page');
    setParams(next, { replace: true });
  };

  /**
   * "Clear filters" only renders while there are filters to clear, so pressing
   * it unmounts it — and focus, which was on it, fell to `<body>`. The next Tab
   * restarted at the top of the document, which for this page means the entire
   * sidebar before the filter bar comes round again. Focus goes to the search
   * box instead: it survives, it is the head of the filter set the button just
   * emptied, and it is where somebody who has cleared their filters is most
   * likely to type next.
   */
  const searchRef = useRef<HTMLInputElement>(null);

  const clearFilters = () => {
    const next = new URLSearchParams();
    if (bucket) next.set('bucket', bucket);
    if (group) next.set('group', group);
    if (sortParam) next.set('sort', sortParam);
    setQDraft('');
    setParams(next, { replace: true });
    searchRef.current?.focus();
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
      /*
       * THE FAILED ROWS STAY SELECTED (R422, methodology M5).
       *
       * A bulk action answers per row, so a partial failure is the ordinary
       * outcome — a stale state on nine of two hundred, a reviewer who lost the
       * role between loading the list and pressing the button. The response
       * names each of those rows by id. This handler read the response for two
       * numbers and one message and then cleared the whole selection, so the
       * only surviving account of which nine failed was a count: the operator
       * was told "191 succeeded, 9 failed", handed a reloaded table of two
       * hundred rows with nothing checked, and left to find the nine by hand.
       *
       * Re-selecting exactly the failed ids makes the retry the same gesture as
       * the first attempt — press the action again — and makes the failed set
       * visible on the table rather than only countable in a sentence. A clean
       * run selects nothing, which is the clear-the-selection behaviour that
       * was there before, arrived at from the data instead of assumed.
       */
      const failedIds = result.results.filter((r) => !r.ok).map((r) => r.id);
      setBulkNote(
        result.failed === 0
          ? `Applied to ${result.succeeded} valuation${result.succeeded === 1 ? '' : 's'}.`
          : `${result.succeeded} succeeded, ${result.failed} failed (${result.results.find((r) => !r.ok)?.error ?? 'see log'}). ` +
              `The ${result.failed === 1 ? 'one that failed is' : 'ones that failed are'} still selected.`,
      );
      setSelected(new Set(failedIds));
      reload();
      loadCounts();
    } catch (err) {
      setBulkNote(describeActionFailure(err, 'Bulk action failed.'));
    } finally {
      setBulkBusy(false);
    }
  };

  const exportAs = async (format: ExportFormat) => {
    setExportError(null);
    setExportNote(null);
    try {
      const q = new URLSearchParams(filterQuery);
      if (bucket) q.set('bucket', bucket);
      if (group) q.set('group', group);
      if (sortParam) q.set('sort', sortParam);
      q.set('format', format);
      const { truncated } = await apiDownload(`/valuations/export?${q}`, `valuations.${format}`);
      // The XLSX and the PDF say this on their own face; the CSV cannot, so
      // the only place a capped CSV can be reported is here.
      if (truncated) setExportNote(EXPORT_CAPPED);
    } catch (err) {
      setExportError(describeActionFailure(err, 'The export was not produced.'));
    }
  };

  // Bulk export (improvement 5): download summaries of exactly the checked rows.
  const exportSelected = async (format: ExportFormat) => {
    setBulkNote(null);
    try {
      const q = new URLSearchParams({ ids: [...selected].join(','), format });
      const { truncated } = await apiDownload(`/valuations/export?${q}`, `valuations-selected.${format}`);
      if (truncated) setBulkNote(EXPORT_CAPPED);
    } catch (err) {
      setBulkNote(describeActionFailure(err, 'The export of the selected engagements was not produced.'));
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

      {countsFailed && tabs.length === 0 && (
        <p className="mt-6 text-sm text-ink-400">
          The scope tabs could not be loaded, so this list is unfiltered. The filters below still work, and
          reloading the page will try again.
        </p>
      )}

      {/* Tabbed scopes with live counts (M3 feature 15) */}
      <div
        className="mt-6 flex flex-wrap gap-1 border-b border-paper-300"
        role="tablist"
        aria-label="Valuation scope"
        onKeyDown={tabListKeyDown}
      >
        {tabs.map((tab) => {
          const active = bucket === tab.key;
          const count = counts ? counts[(tab.key || 'all') as keyof NamedBucketCounts] : null;
          return (
            <button
              key={tab.key || 'all'}
              {...tabProps(active)}
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
              className={`tap-area cursor-pointer border-b-2 px-3.5 py-2 text-sm font-semibold transition-colors ${
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
            ref={searchRef}
            aria-label="Search"
            placeholder="Search id, #number, workflow, company…"
            value={qDraft}
            onChange={(e) => setQDraft(e.target.value)}
            onBlur={() => setFilter('q', qDraft.trim())}
          />
          {/* `data.total` rather than the page's row count: the answer to "how
              many matched" is the whole result set, not the twenty-five of it
              that fit on this page. Covers every filter beside it too. */}
          <ResultCount count={data ? data.total : null} noun="valuation" query={params.get('q') ?? ''} />
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
        {tagCategories.length > 0 && (
          <Select
            aria-label="Filter by tag"
            /*
             * `tags` is a set on the wire and one value here. Reading the first
             * of a hand-written multi-tag URL rather than blanking the control
             * keeps the two consistent in the direction that matters: the list
             * really is filtered, and the picker says so with the tag doing
             * most of the work rather than showing "Any tag" over a filtered
             * list, which reads as a bug.
             */
            value={(params.get('tags') ?? '').split(',')[0]}
            onChange={(e) => setFilter('tags', e.target.value)}
            className="!w-auto min-w-40"
          >
            <option value="">Any tag</option>
            {tagCategories.map((category) => (
              <optgroup key={category.category} label={category.label}>
                {category.tags.map((t) => (
                  <option key={t.slug} value={t.slug} title={t.definition}>
                    {t.label}
                  </option>
                ))}
              </optgroup>
            ))}
          </Select>
        )}
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

      {exportNote && (
        <div role="status" className="mt-3 text-sm text-ink-600" data-testid="export-note">
          {exportNote}
        </div>
      )}
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
              disabled={reviewersFailed}
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
          <Button
            // Blocked only for the action the missing roster actually breaks:
            // setting state in bulk does not read the roster and stays usable.
            disabled={bulkBusy || (bulkAction === 'assign_reviewer' && reviewersFailed)}
            // The roster failure greys the picker beside this button and says
            // nothing, so Apply went grey too with no stated reason. Which
            // matters more here than most: the action being refused is the one
            // that, run against an empty roster, would have unassigned every
            // selected engagement.
            title={
              bulkAction === 'assign_reviewer' && reviewersFailed
                ? 'The reviewer list could not be loaded, so there is nobody to assign. Reload to try again.'
                : undefined
            }
            onClick={() => void applyBulk()}
          >
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
      {reviewersFailed && (
        <p className="mt-3 text-sm text-ink-400">
          The reviewer list could not be loaded, so reviewers cannot be filtered on or assigned in bulk right
          now. Reload the page to try again.
        </p>
      )}
      {tagsFailed && (
        <p className="mt-3 text-sm text-ink-400">
          The tag vocabulary could not be loaded, so engagements cannot be filtered by tag right now. Reload
          the page to try again.
        </p>
      )}
      {partnersFailed && (
        <p className="mt-3 text-sm text-ink-400">
          The list of organisations could not be loaded, so the partner filter is empty. Reload the page to
          try again.
        </p>
      )}
      {bulkNote && (
        <div role="status" className="mt-3 text-sm text-ink-600">
          {bulkNote}
        </div>
      )}

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
                      {/* The card is a <div onClick>, which is a mouse-only
                          affordance — not focusable, no key binding. Below md
                          the table is hidden entirely, so on a phone (or a
                          narrow window) this list was the only way into a
                          valuation and there was no way in from the keyboard.
                          The name is the real link; the card click stays as a
                          convenience, as it is in the table above. */}
                      <Link
                        to={`/valuations/${v.id}`}
                        onClick={(e) => e.stopPropagation()}
                        className="truncate rounded-sm font-display text-[1.05rem] font-semibold text-ink-900 focus-visible:ring-2 focus-visible:ring-bond-600/40 focus-visible:outline-none"
                      >
                        {v.company_name}
                      </Link>
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
        <div className="mt-6 hidden overflow-x-auto overscroll-x-contain rounded-lg border border-paper-300 bg-surface shadow-card md:block">
          <table className="w-full min-w-[760px] text-sm">
            <caption className="sr-only">Valuations</caption>
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
