import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { isOps } from '../lib/rbac';
import { computeStats } from '../lib/stats';
import { displayName, formatDate } from '../lib/format';
import type { Valuation, ValuationList } from '../lib/types';
import { Button, EmptyState, ErrorNote, KindBadge, Spinner, StatCard, StateBadge } from '../components/ui';

export function DashboardPage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [valuations, setValuations] = useState<Valuation[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<ValuationList>('/valuations?per_page=100')
      .then((res) => setValuations(res.valuations))
      .catch(() => setError('Could not load valuations.'));
  }, []);

  const stats = valuations ? computeStats(valuations) : null;
  const recent = valuations?.slice(0, 6) ?? [];

  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="overline text-ink-400">Dashboard</div>
          <h1 className="mt-1 font-display text-3xl font-semibold text-ink-900">
            {user ? `Welcome, ${displayName(user).split(' ')[0]}` : 'Welcome'}
          </h1>
          <p className="mt-1 text-sm text-ink-400">
            {isOps(user) ? 'Operations view — all valuations in flight.' : 'Your valuation engagements at a glance.'}
          </p>
        </div>
        <Button onClick={() => navigate('/valuations/new')}>+ New valuation</Button>
      </div>

      {error && <div className="mt-6"><ErrorNote>{error}</ErrorNote></div>}
      {!valuations && !error && <Spinner />}

      {stats && (
        <>
          <div className="mt-8 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
            <StatCard label="Total" value={stats.total} />
            <StatCard label="Open" value={stats.open} />
            <StatCard label="In review" value={stats.inReview} />
            <StatCard label="Drafted" value={stats.drafted} />
            <StatCard label="Published" value={stats.published} accent />
          </div>
          {stats.waitingOnClient > 0 && (
            <div className="mt-4 rounded-md border border-amber-200 bg-amber-50 px-4 py-2.5 text-sm text-amber-900">
              <strong className="font-semibold">{stats.waitingOnClient}</strong> valuation
              {stats.waitingOnClient === 1 ? ' is' : 's are'} waiting on client input.
            </div>
          )}

          <div className="mt-10 flex items-center justify-between">
            <h2 className="overline text-ink-400">Recent valuations</h2>
            <Link to="/valuations" className="text-sm font-semibold text-bond-600 hover:text-bond-700">
              View all →
            </Link>
          </div>

          {recent.length === 0 ? (
            <div className="mt-4">
              <EmptyState title="No valuations yet">
                <Link to="/valuations/new" className="font-semibold text-bond-600 hover:text-bond-700">
                  Start your first valuation
                </Link>{' '}
                — it takes about two minutes.
              </EmptyState>
            </div>
          ) : (
            <ul className="mt-4 space-y-3">
              {recent.map((v) => (
                <li key={v.id}>
                  <Link
                    to={`/valuations/${v.id}`}
                    className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-paper-300 bg-white px-5 py-4 shadow-card transition-shadow hover:shadow-lift"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-display text-[1.05rem] font-semibold text-ink-900">
                        {v.company_name}
                      </div>
                      <div className="mt-0.5 text-xs text-ink-400">
                        Created {formatDate(v.created_at)}
                        {v.due_date && <> · due {formatDate(v.due_date)}</>}
                      </div>
                    </div>
                    <KindBadge kind={v.kind} />
                    <StateBadge state={v.state} />
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
