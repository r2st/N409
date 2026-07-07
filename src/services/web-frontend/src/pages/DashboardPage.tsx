import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { isOps } from '../lib/rbac';
import { computeStats } from '../lib/stats';
import { displayName, formatDate, GROUP_LABELS, KIND_LABELS, SOURCE_LABELS } from '../lib/format';
import type { DashboardAnalytics, Valuation, ValuationList } from '../lib/types';
import { Button, EmptyState, ErrorNote, KindBadge, Spinner, StatCard, StateBadge, TextInput } from '../components/ui';
import { DonutChart } from '../components/charts';

const PIVOT_GROUPS = ['open', 'in_review', 'drafted', 'published', 'closed'] as const;

export function DashboardPage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [valuations, setValuations] = useState<Valuation[] | null>(null);
  const [analytics, setAnalytics] = useState<DashboardAnalytics | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [range, setRange] = useState({ from: '', to: '' });

  useEffect(() => {
    api<ValuationList>('/valuations?per_page=100')
      .then((res) => setValuations(res.valuations))
      .catch(() => setError('Could not load valuations.'));
  }, []);

  // Analytics (M3 feature 17) — server-side pivot within the date range.
  useEffect(() => {
    const q = new URLSearchParams();
    if (range.from) q.set('created_from', range.from);
    if (range.to) q.set('created_to', range.to);
    api<DashboardAnalytics>(`/stats/dashboard?${q}`)
      .then(setAnalytics)
      .catch(() => setAnalytics(null));
  }, [range]);

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

          {/* ── Analytics: date range + product pivot + pies (M3) ─────────── */}
          <div className="mt-10 flex flex-wrap items-end justify-between gap-4">
            <h2 className="overline text-ink-400">Analytics</h2>
            <div className="flex items-center gap-1.5">
              <TextInput
                type="date"
                aria-label="Analytics from"
                value={range.from}
                onChange={(e) => setRange((r) => ({ ...r, from: e.target.value }))}
                className="!w-auto"
              />
              <span className="text-ink-300">–</span>
              <TextInput
                type="date"
                aria-label="Analytics to"
                value={range.to}
                onChange={(e) => setRange((r) => ({ ...r, to: e.target.value }))}
                className="!w-auto"
              />
              {(range.from || range.to) && (
                <Button variant="ghost" onClick={() => setRange({ from: '', to: '' })}>
                  Reset
                </Button>
              )}
            </div>
          </div>

          {analytics && (
            <>
              <div className="mt-4 grid gap-4 lg:grid-cols-2">
                <DonutChart
                  title="By product"
                  slices={analytics.by_kind.map((row) => ({
                    label: KIND_LABELS[row.kind] ?? row.kind,
                    value: row.total,
                  }))}
                />
                <DonutChart
                  title="By source"
                  slices={Object.entries(analytics.by_source).map(([source, value]) => ({
                    label: SOURCE_LABELS[source] ?? source,
                    value,
                  }))}
                />
              </div>

              {analytics.by_kind.length > 0 && (
                <div className="mt-4 overflow-x-auto rounded-lg border border-paper-300 bg-white shadow-card">
                  <table className="w-full min-w-[560px] text-sm" aria-label="Product pivot">
                    <thead>
                      <tr className="border-b border-paper-300 text-left">
                        <th className="overline px-5 py-3 font-semibold text-ink-400">Product</th>
                        {PIVOT_GROUPS.map((g) => (
                          <th key={g} className="overline px-4 py-3 text-right font-semibold text-ink-400">
                            {GROUP_LABELS[g]}
                          </th>
                        ))}
                        <th className="overline px-5 py-3 text-right font-semibold text-ink-400">Total</th>
                      </tr>
                    </thead>
                    <tbody>
                      {analytics.by_kind.map((row) => (
                        <tr key={row.kind} className="border-b border-paper-200 last:border-0">
                          <td className="px-5 py-3"><KindBadge kind={row.kind} /></td>
                          {PIVOT_GROUPS.map((g) => (
                            <td key={g} className="tnum px-4 py-3 text-right text-ink-600">
                              {row[g] || '—'}
                            </td>
                          ))}
                          <td className="tnum px-5 py-3 text-right font-semibold text-ink-900">{row.total}</td>
                        </tr>
                      ))}
                      <tr className="bg-paper-50">
                        <td className="px-5 py-3 text-xs font-semibold text-ink-400 uppercase">Total</td>
                        {PIVOT_GROUPS.map((g) => (
                          <td key={g} className="tnum px-4 py-3 text-right font-semibold text-ink-900">
                            {analytics.by_kind.reduce((sum, row) => sum + row[g], 0) || '—'}
                          </td>
                        ))}
                        <td className="tnum px-5 py-3 text-right font-semibold text-bond-700">
                          {analytics.total}
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              )}
            </>
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
