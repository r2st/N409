import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { isOps } from '../lib/rbac';
import { formatDate, KIND_LABELS, STATE_LABELS } from '../lib/format';
import { VALUATION_KINDS, VALUATION_STATES } from '../lib/types';
import type { ValuationList } from '../lib/types';
import { Button, EmptyState, ErrorNote, KindBadge, Select, Spinner, StateBadge } from '../components/ui';

const PER_PAGE = 25;

export function ValuationsPage() {
  const { user } = useAuth();
  const ops = isOps(user);
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [data, setData] = useState<ValuationList | null>(null);
  const [error, setError] = useState<string | null>(null);

  const state = params.get('state') ?? '';
  const kind = params.get('kind') ?? '';
  const page = Math.max(1, Number(params.get('page') ?? '1') || 1);

  useEffect(() => {
    setData(null);
    setError(null);
    const q = new URLSearchParams({ page: String(page), per_page: String(PER_PAGE) });
    if (state) q.set('state', state);
    if (kind) q.set('kind', kind);
    api<ValuationList>(`/valuations?${q}`)
      .then(setData)
      .catch(() => setError('Could not load valuations.'));
  }, [state, kind, page]);

  const setFilter = (key: 'state' | 'kind', value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    next.delete('page');
    setParams(next, { replace: true });
  };

  const totalPages = data ? Math.max(1, Math.ceil(data.total / PER_PAGE)) : 1;

  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="overline text-ink-400">{ops ? 'Operations' : 'Portfolio'}</div>
          <h1 className="mt-1 font-display text-3xl font-semibold text-ink-900">
            {ops ? 'All valuations' : 'Valuations'}
          </h1>
        </div>
        <Button onClick={() => navigate('/valuations/new')}>+ New valuation</Button>
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

      {error && <div className="mt-6"><ErrorNote>{error}</ErrorNote></div>}
      {!data && !error && <Spinner />}

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
