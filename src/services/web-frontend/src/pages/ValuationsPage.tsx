import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api, apiDownload } from '../lib/api';
import { useAuth } from '../lib/auth';
import { isOps } from '../lib/rbac';
import { displayName, formatDate, GROUP_LABELS, KIND_LABELS, SOURCE_LABELS, STATE_LABELS } from '../lib/format';
import { STATE_GROUPS, VALUATION_KINDS, VALUATION_STATES } from '../lib/types';
import type { Partner, UserOption, ValuationCounts, ValuationList } from '../lib/types';
import { Button, EmptyState, ErrorNote, KindBadge, Select, Spinner, StateBadge, TextInput } from '../components/ui';

const PER_PAGE = 25;

/** Query params that drive the list — kept in the URL so views are shareable. */
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
] as const;

export function ValuationsPage() {
  const { user } = useAuth();
  const ops = isOps(user);
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [data, setData] = useState<ValuationList | null>(null);
  const [counts, setCounts] = useState<ValuationCounts | null>(null);
  const [reviewers, setReviewers] = useState<UserOption[]>([]);
  const [partners, setPartners] = useState<Partner[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [qDraft, setQDraft] = useState(params.get('q') ?? '');

  const group = params.get('group') ?? '';
  const page = Math.max(1, Number(params.get('page') ?? '1') || 1);

  // Everything except pagination + tab, encoded once and reused by list/counts/export.
  const filterQuery = useMemo(() => {
    const q = new URLSearchParams();
    for (const key of FILTER_KEYS) {
      const value = params.get(key);
      if (value) q.set(key, value);
    }
    return q;
  }, [params]);

  useEffect(() => {
    setData(null);
    setError(null);
    const q = new URLSearchParams(filterQuery);
    if (group) q.set('group', group);
    q.set('page', String(page));
    q.set('per_page', String(PER_PAGE));
    api<ValuationList>(`/valuations?${q}`)
      .then(setData)
      .catch(() => setError('Could not load valuations.'));
  }, [filterQuery, group, page]);

  // Live tab counts — refetched when any non-tab filter changes.
  useEffect(() => {
    api<{ counts: ValuationCounts }>(`/valuations/counts?${filterQuery}`)
      .then((res) => setCounts(res.counts))
      .catch(() => setCounts(null));
  }, [filterQuery]);

  useEffect(() => {
    if (!ops) return;
    api<{ options: UserOption[] }>('/users/options?group=ops')
      .then((res) => setReviewers(res.options))
      .catch(() => {});
    api<{ partners: Partner[] }>('/partners')
      .then((res) => setPartners(res.partners))
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
    if (group) next.set('group', group);
    setQDraft('');
    setParams(next, { replace: true });
  };

  const hasFilters = FILTER_KEYS.some((k) => params.get(k));
  const totalPages = data ? Math.max(1, Math.ceil(data.total / PER_PAGE)) : 1;

  const exportCsv = async () => {
    setExporting(true);
    try {
      const q = new URLSearchParams(filterQuery);
      if (group) q.set('group', group);
      await apiDownload(`/valuations/export?${q}`, 'valuations.csv');
    } catch {
      setError('Could not export CSV.');
    } finally {
      setExporting(false);
    }
  };

  const tabs: Array<{ key: string; label: string }> = [
    { key: '', label: GROUP_LABELS.all! },
    ...STATE_GROUPS.map((g) => ({ key: g, label: GROUP_LABELS[g] ?? g })),
  ];

  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="overline text-ink-400">{ops ? 'Operations' : 'Portfolio'}</div>
          <h1 className="mt-1 font-display text-3xl font-semibold text-ink-900">
            {ops ? 'All valuations' : 'Valuations'}
          </h1>
        </div>
        <div className="flex gap-2">
          <Button variant="secondary" onClick={exportCsv} disabled={exporting}>
            {exporting ? 'Exporting…' : '↓ Export CSV'}
          </Button>
          <Button onClick={() => navigate('/valuations/new')}>+ New valuation</Button>
        </div>
      </div>

      {/* Tabbed scopes with live counts (M3 feature 15) */}
      <div className="mt-6 flex flex-wrap gap-1 border-b border-paper-300" role="tablist">
        {tabs.map((tab) => {
          const active = group === tab.key;
          const count = counts ? counts[(tab.key || 'all') as keyof ValuationCounts] : null;
          return (
            <button
              key={tab.key || 'all'}
              role="tab"
              aria-selected={active}
              onClick={() => setFilter('group', tab.key)}
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

      {/* Filter bar */}
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
            <span className="text-ink-300">–</span>
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
            <span className="text-ink-300">–</span>
            <TextInput
              type="date"
              aria-label="Due to"
              value={params.get('due_to') ?? ''}
              onChange={(e) => setFilter('due_to', e.target.value)}
              className="!w-auto"
            />
          </div>
        </label>
        {hasFilters && (
          <Button variant="ghost" type="button" onClick={clearFilters}>
            Clear filters
          </Button>
        )}
        <button type="submit" hidden />
      </form>

      {error && <div className="mt-6"><ErrorNote>{error}</ErrorNote></div>}
      {!data && !error && <Spinner />}

      {data && data.valuations.length === 0 && (
        <div className="mt-6">
          <EmptyState title={hasFilters || group ? 'Nothing matches these filters' : 'No valuations yet'}>
            {hasFilters || group ? (
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
          <table className="w-full min-w-[720px] text-sm">
            <thead>
              <tr className="border-b border-paper-300 text-left">
                <th className="overline px-5 py-3 font-semibold text-ink-400">#</th>
                <th className="overline px-5 py-3 font-semibold text-ink-400">Company</th>
                <th className="overline px-5 py-3 font-semibold text-ink-400">Kind</th>
                <th className="overline px-5 py-3 font-semibold text-ink-400">State</th>
                <th className="overline px-5 py-3 font-semibold text-ink-400">Created</th>
                <th className="overline px-5 py-3 font-semibold text-ink-400">Due</th>
                {ops && <th className="overline px-5 py-3 font-semibold text-ink-400">Paid</th>}
              </tr>
            </thead>
            <tbody>
              {data.valuations.map((v) => (
                <tr
                  key={v.id}
                  onClick={() => navigate(`/valuations/${v.id}`)}
                  className="cursor-pointer border-b border-paper-200 last:border-0 hover:bg-paper-50"
                >
                  <td className="tnum px-5 py-3.5 text-ink-400">{v.number ?? '—'}</td>
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
