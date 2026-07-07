import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api, apiDownload, ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';
import { isOps } from '../lib/rbac';
import { formatDate, KIND_LABELS, STATE_LABELS } from '../lib/format';
import { parseSortParam, serializeSort, sortIndicator, toggleSort } from '../lib/sort';
import type { SortableColumn } from '../lib/sort';
import { VALUATION_KINDS, VALUATION_STATES } from '../lib/types';
import type { BulkResult, ValuationList } from '../lib/types';
import { Button, EmptyState, ErrorNote, KindBadge, Select, Spinner, StateBadge } from '../components/ui';

const PER_PAGE = 25;

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
  const [error, setError] = useState<string | null>(null);

  // M4 — bulk actions (ops)
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkAction, setBulkAction] = useState('set_state');
  const [bulkState, setBulkState] = useState('started');
  const [bulkReviewer, setBulkReviewer] = useState('');
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkNote, setBulkNote] = useState<string | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);

  const state = params.get('state') ?? '';
  const kind = params.get('kind') ?? '';
  const sortParam = params.get('sort') ?? '';
  const page = Math.max(1, Number(params.get('page') ?? '1') || 1);

  const reload = useCallback(() => {
    setData(null);
    setError(null);
    const q = new URLSearchParams({ page: String(page), per_page: String(PER_PAGE) });
    if (state) q.set('state', state);
    if (kind) q.set('kind', kind);
    if (sortParam) q.set('sort', sortParam);
    api<ValuationList>(`/valuations?${q}`)
      .then(setData)
      .catch(() => setError('Could not load valuations.'));
  }, [state, kind, page, sortParam]);

  useEffect(reload, [reload]);

  const setFilter = (key: 'state' | 'kind', value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    next.delete('page');
    setParams(next, { replace: true });
  };

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
      const body: Record<string, unknown> = { ids: [...selected], action: bulkAction };
      if (bulkAction === 'set_state') body.state = bulkState;
      if (bulkAction === 'assign_reviewer') body.reviewer_id = bulkReviewer.trim() || null;
      const result = await api<BulkResult>('/valuations/bulk', { method: 'POST', body });
      setBulkNote(
        result.failed === 0
          ? `Applied to ${result.succeeded} valuation${result.succeeded === 1 ? '' : 's'}.`
          : `${result.succeeded} succeeded, ${result.failed} failed (${result.results.find((r) => !r.ok)?.error ?? 'see log'}).`,
      );
      setSelected(new Set());
      reload();
    } catch (err) {
      setBulkNote(err instanceof ApiError ? err.message : 'Bulk action failed.');
    } finally {
      setBulkBusy(false);
    }
  };

  const exportAs = async (format: 'csv' | 'pdf') => {
    setExportError(null);
    try {
      const q = new URLSearchParams();
      if (state) q.set('state', state);
      if (kind) q.set('kind', kind);
      if (sortParam) q.set('sort', sortParam);
      q.set('format', format);
      await apiDownload(`/valuations/export?${q}`, `valuations.${format}`);
    } catch {
      setExportError('Export failed.');
    }
  };

  const totalPages = data ? Math.max(1, Math.ceil(data.total / PER_PAGE)) : 1;
  const allOnPageSelected = Boolean(data?.valuations.length) && data!.valuations.every((v) => selected.has(v.id));

  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="overline text-ink-400">{ops ? 'Operations' : 'Portfolio'}</div>
          <h1 className="mt-1 font-display text-3xl font-semibold text-ink-900">
            {ops ? 'All valuations' : 'Valuations'}
          </h1>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" onClick={() => void exportAs('csv')}>
            Export CSV
          </Button>
          <Button variant="secondary" onClick={() => void exportAs('pdf')}>
            Export PDF
          </Button>
          <Button onClick={() => navigate('/valuations/new')}>+ New valuation</Button>
        </div>
      </div>

      <div className="mt-6 flex flex-wrap gap-3">
        <Select
          aria-label="Filter by state"
          value={state}
          onChange={(e) => setFilter('state', e.target.value)}
          className="!w-auto min-w-40"
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
          value={kind}
          onChange={(e) => setFilter('kind', e.target.value)}
          className="!w-auto min-w-40"
        >
          <option value="">All kinds</option>
          {VALUATION_KINDS.map((k) => (
            <option key={k} value={k}>
              {KIND_LABELS[k]}
            </option>
          ))}
        </Select>
      </div>

      {exportError && <div className="mt-4"><ErrorNote>{exportError}</ErrorNote></div>}
      {error && <div className="mt-6"><ErrorNote>{error}</ErrorNote></div>}
      {!data && !error && <Spinner />}

      {/* M4 — bulk action bar (ops) */}
      {ops && selected.size > 0 && (
        <div className="mt-5 flex flex-wrap items-center gap-3 rounded-lg border border-bond-200 bg-bond-50 px-4 py-3">
          <span className="tnum text-sm font-semibold text-ink-800">{selected.size} selected</span>
          <Select value={bulkAction} onChange={(e) => setBulkAction(e.target.value)} className="!w-auto">
            <option value="set_state">Set state</option>
            <option value="assign_reviewer">Assign reviewer</option>
            <option value="advance">Auto-advance</option>
            <option value="restart">Restart</option>
          </Select>
          {bulkAction === 'set_state' && (
            <Select value={bulkState} onChange={(e) => setBulkState(e.target.value)} className="!w-auto">
              {VALUATION_STATES.map((s) => (
                <option key={s} value={s}>
                  {STATE_LABELS[s]}
                </option>
              ))}
            </Select>
          )}
          {bulkAction === 'assign_reviewer' && (
            <input
              value={bulkReviewer}
              onChange={(e) => setBulkReviewer(e.target.value)}
              placeholder="Reviewer user id (blank to unassign)"
              className="w-72 rounded-md border border-ink-200 bg-white px-3 py-2 text-sm"
            />
          )}
          <Button disabled={bulkBusy} onClick={() => void applyBulk()}>
            {bulkBusy ? 'Applying…' : 'Apply'}
          </Button>
          <Button variant="ghost" onClick={() => setSelected(new Set())}>
            Clear
          </Button>
        </div>
      )}
      {bulkNote && <div className="mt-3 text-sm text-ink-600">{bulkNote}</div>}

      {data && data.valuations.length === 0 && (
        <div className="mt-6">
          <EmptyState title={state || kind ? 'Nothing matches these filters' : 'No valuations yet'}>
            {state || kind ? (
              'Try clearing a filter.'
            ) : (
              <Link to="/valuations/new" className="font-semibold text-bond-600 hover:text-bond-700">
                Start your first valuation
              </Link>
            )}
          </EmptyState>
        </div>
      )}

      {data && data.valuations.length > 0 && (
        <div className="mt-6 overflow-x-auto rounded-lg border border-paper-300 bg-white shadow-card">
          <table className="w-full min-w-[640px] text-sm">
            <thead>
              <tr className="border-b border-paper-300 text-left">
                {ops && (
                  <th className="px-4 py-3">
                    <input
                      type="checkbox"
                      aria-label="Select all on page"
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
                <SortableTh column="company_name" label="Company" sortParam={sortParam} onSort={onSort} />
                <SortableTh column="kind" label="Kind" sortParam={sortParam} onSort={onSort} />
                <SortableTh column="state" label="State" sortParam={sortParam} onSort={onSort} />
                <SortableTh column="created_at" label="Created" sortParam={sortParam} onSort={onSort} />
                <SortableTh column="due_date" label="Due" sortParam={sortParam} onSort={onSort} />
                {ops && <SortableTh column="paid_status" label="Paid" sortParam={sortParam} onSort={onSort} />}
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
                        checked={selected.has(v.id)}
                        onChange={() => toggleSelected(v.id)}
                      />
                    </td>
                  )}
                  <td className="px-5 py-3.5">
                    <div className="font-semibold text-ink-900">{v.company_name}</div>
                    {v.waiting_on_client && (
                      <div className="mt-0.5 text-xs font-medium text-amber-700">Waiting on client</div>
                    )}
                  </td>
                  <td className="px-5 py-3.5"><KindBadge kind={v.kind} /></td>
                  <td className="px-5 py-3.5"><StateBadge state={v.state} /></td>
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
