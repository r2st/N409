import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { isOps, isPartner } from '../lib/rbac';
import { computeStats } from '../lib/stats';
import { attentionItems } from '../lib/attention';
import {
  displayName,
  formatDate,
  GROUP_LABELS,
  KIND_LABELS,
  SOURCE_LABELS,
  STATE_LABELS,
} from '../lib/format';
import { VALUATION_STATES } from '../lib/types';
import type { DashboardAnalytics, Valuation, ValuationList } from '../lib/types';
import {
  Button,
  EmptyState,
  ErrorNote,
  KindBadge,
  LoadingBlock,
  Skeleton,
  SkeletonCardList,
  SkeletonTable,
  StatCard,
  StatCardSkeleton,
  StateBadge,
  TextInput,
} from '../components/ui';
import { DonutChart, LineChart } from '../components/charts';
import { HelpIcon } from '../components/HelpIcon';
import { GettingStarted } from '../components/GettingStarted';
import { AttentionBand } from '../components/AttentionBand';

const PIVOT_GROUPS = ['open', 'in_review', 'drafted', 'published', 'closed'] as const;

/**
 * The bucket strip (design §3.1/§3.2), in the order the sidebar lists them.
 *
 * `all` and `unread` are left out on purpose: the total is already the first
 * stat card above, and unread cuts across every bucket rather than sitting
 * beside them — it is shown as a badge on the ones that have some. Same
 * reasoning the sidebar's `BucketNav` documents.
 */
const STRIP_BUCKETS = [
  { key: 'incomplete', label: 'Incomplete' },
  { key: 'unverified', label: 'Unverified' },
  { key: 'in_progress', label: 'In Progress' },
  { key: 'waiting_on_client', label: 'Waiting On Client' },
  { key: 'drafted', label: 'Drafted' },
  { key: 'published', label: 'Published' },
  { key: 'ignored', label: 'Ignored' },
] as const;

/** `valuation_state_changed` → `Valuation state changed`. */
function eventLabel(type: string): string {
  const words = type.replace(/[._]/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function DashboardPage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [valuations, setValuations] = useState<Valuation[] | null>(null);
  const [analytics, setAnalytics] = useState<DashboardAnalytics | null>(null);
  // Tracked apart from `analytics`, which is also null when the pivot failed —
  // keyed off the data alone, a failed fetch would leave placeholders up for good.
  const [analyticsLoading, setAnalyticsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [range, setRange] = useState({ from: '', to: '' });

  useEffect(() => {
    api<ValuationList>('/valuations?per_page=100')
      .then((res) => setValuations(res.valuations))
      .catch(() => setError('Could not load valuations.'));
  }, []);

  // Analytics is noise for clients with 1–2 valuations — ops and partners only
  // (partner data is already server-scoped to their organisation).
  const showAnalytics = isOps(user) || isPartner(user);

  // Analytics (M3 feature 17) — server-side pivot within the date range.
  useEffect(() => {
    if (!showAnalytics) return;
    const q = new URLSearchParams();
    if (range.from) q.set('created_from', range.from);
    if (range.to) q.set('created_to', range.to);
    // `cancelled` guards both the state writes: typing through a date range
    // fires several of these, and without it the slowest response wins rather
    // than the newest one.
    let cancelled = false;
    setAnalyticsLoading(true);
    api<DashboardAnalytics>(`/stats/dashboard?${q}`)
      .then((data) => !cancelled && setAnalytics(data))
      .catch(() => !cancelled && setAnalytics(null))
      .finally(() => !cancelled && setAnalyticsLoading(false));
    return () => {
      cancelled = true;
    };
  }, [range, showAnalytics]);

  const stats = valuations ? computeStats(valuations) : null;
  const recent = valuations?.slice(0, 6) ?? [];
  // `now` is captured once per render rather than read inside the ranking, so
  // every row on one paint is measured against the same instant.
  const attention = useMemo(() => attentionItems(valuations ?? [], new Date()), [valuations]);

  /** Worklist URL matching a pivot cell's cohort — same date range, plus filters. */
  const drillTo = (filters: Record<string, string>) => {
    const q = new URLSearchParams();
    if (range.from) q.set('created_from', range.from);
    if (range.to) q.set('created_to', range.to);
    for (const [key, value] of Object.entries(filters)) q.set(key, value);
    const qs = q.toString();
    return qs ? `/valuations?${qs}` : '/valuations';
  };

  const drillLinkClass = 'font-medium text-bond-600 underline-offset-2 hover:text-bond-700 hover:underline';

  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="overline flex items-center gap-1.5 text-ink-400">
            Dashboard
            <HelpIcon article="dashboard-overview" />
          </div>
          <h1 className="mt-1 font-display text-3xl font-semibold text-ink-900">
            {user ? `Welcome, ${displayName(user).split(' ')[0]}` : 'Welcome'}
          </h1>
          <p className="mt-1 text-sm text-ink-400">
            {isOps(user)
              ? 'Operations view — all valuations in flight.'
              : 'Your valuation engagements at a glance.'}
          </p>
        </div>
        <Button onClick={() => navigate('/valuations/new')}>+ New valuation</Button>
      </div>

      {/* Getting Started checklist — new (client) users only; dismissible. */}
      {!isOps(user) && !isPartner(user) && (
        <div className="mt-8">
          <GettingStarted />
        </div>
      )}

      {error && (
        <div className="mt-6">
          <ErrorNote>{error}</ErrorNote>
        </div>
      )}
      {/* Same five-card grid the counts land in, so the fold does not move. */}
      {!valuations && !error && (
        <LoadingBlock label="Loading your dashboard…">
          <div className="mt-8 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
            {Array.from({ length: 5 }, (_, i) => (
              <StatCardSkeleton key={i} />
            ))}
          </div>
          <Skeleton className="mt-10 h-2.5 w-32" />
          {/* Recent valuations is a card list, not a table — placing a table
              here would promise a shape the data never takes. */}
          <SkeletonCardList className="mt-4" rows={5} lines={2} badges={2} />
        </LoadingBlock>
      )}

      {stats && (
        <>
          {/* Each count is a cohort the worklist can show; the cards go there. */}
          <div className="mt-8 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
            <StatCard label="Total" value={stats.total} to="/valuations" />
            <StatCard label="Open" value={stats.open} to="/valuations?group=open" />
            <StatCard label="In review" value={stats.inReview} to="/valuations?group=in_review" />
            <StatCard label="Drafted" value={stats.drafted} to="/valuations?group=drafted" />
            <StatCard label="Published" value={stats.published} accent to="/valuations?group=published" />
          </div>

          {/* ── Bucket strip (design §3.1/§3.2): the same tallies the sidebar
              badges read, so the two can never disagree. Each cell navigates to
              the listing pre-filtered on that bucket. */}
          {showAnalytics && analytics?.buckets && (
            <div className="mt-8 grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7">
              {STRIP_BUCKETS.map(({ key, label }) => {
                const tally = analytics.buckets[key];
                return (
                  <Link
                    key={key}
                    to={`/valuations?bucket=${key}`}
                    className="rounded-lg border border-paper-300 bg-surface px-4 py-3 shadow-card transition-shadow hover:shadow-lift"
                  >
                    <div className="overline truncate text-ink-400">{label}</div>
                    <div className="mt-1 flex items-baseline gap-2">
                      <span className="tnum font-display text-xl font-semibold text-ink-900">
                        {tally?.total ?? 0}
                      </span>
                      {(tally?.unread ?? 0) > 0 && (
                        <span className="tnum text-xs font-semibold text-bond-600">
                          {tally!.unread} unread
                        </span>
                      )}
                    </div>
                  </Link>
                );
              })}
            </div>
          )}

          {/* ── SLA band: the two figures that mean somebody has to do something
              today. Zero is stated rather than hidden — "nothing is overdue" is
              the answer an operator opens this page for. */}
          {showAnalytics && analytics?.sla && (
            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              <Link
                to="/valuations?bucket=in_progress"
                className={`rounded-lg border px-5 py-4 shadow-card transition-shadow hover:shadow-lift ${
                  analytics.sla.overdue > 0 ? 'border-red-200 bg-red-50' : 'border-paper-300 bg-surface'
                }`}
              >
                <div className="overline text-ink-400">Past due</div>
                <div className="tnum mt-1 font-display text-2xl font-semibold text-ink-900">
                  {analytics.sla.overdue}
                </div>
                <div className="mt-1 text-xs text-ink-400">Unpublished engagements past their due date</div>
              </Link>
              <Link
                to="/valuations?bucket=waiting_on_client"
                className={`rounded-lg border px-5 py-4 shadow-card transition-shadow hover:shadow-lift ${
                  analytics.sla.waiting_stale > 0
                    ? 'border-amber-200 bg-amber-50'
                    : 'border-paper-300 bg-surface'
                }`}
              >
                <div className="overline text-ink-400">Stalled with the client</div>
                <div className="tnum mt-1 font-display text-2xl font-semibold text-ink-900">
                  {analytics.sla.waiting_stale}
                </div>
                <div className="mt-1 text-xs text-ink-400">
                  Waiting, no contact for {analytics.sla.waiting_days} days
                </div>
              </Link>
            </div>
          )}

          <AttentionBand items={attention} isOps={isOps(user)} />

          {/* ── Analytics: date range + product pivot + pies (M3) — ops/partner only */}
          {showAnalytics && (
            <>
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

              {/*
               * First load only. A range change keeps the pivot that is already
               * on screen rather than collapsing it to placeholders — the reader
               * is comparing against what it said a moment ago.
               */}
              {analyticsLoading && !analytics && (
                <LoadingBlock label="Loading analytics…">
                  <div className="mt-4 grid gap-4 lg:grid-cols-2">
                    {Array.from({ length: 2 }, (_, i) => (
                      <div
                        key={i}
                        className="rounded-lg border border-paper-300 bg-surface p-5 shadow-card"
                        aria-hidden
                      >
                        <Skeleton className="h-2.5 w-24" />
                        <div className="mt-5 flex items-center gap-6">
                          <Skeleton className="h-28 w-28 shrink-0 rounded-full" />
                          <div className="min-w-0 flex-1 space-y-2.5">
                            {Array.from({ length: 4 }, (_, j) => (
                              <Skeleton key={j} className="h-3 w-full" />
                            ))}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                  <div className="mt-4 rounded-lg border border-paper-300 bg-surface p-2 shadow-card">
                    {/* Product column + five group columns + total. */}
                    <SkeletonTable columns={7} rows={4} />
                  </div>
                </LoadingBlock>
              )}

              {analytics && (
                <>
                  {analytics.throughput?.length > 0 && (
                    <div className="mt-4">
                      <LineChart
                        title="Published per week — trailing 12 weeks"
                        points={analytics.throughput.map((w) => ({
                          label: formatDate(w.week),
                          value: w.count,
                        }))}
                        format={(v) => String(Math.round(v))}
                      />
                    </div>
                  )}

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
                    <div className="mt-4 overflow-x-auto rounded-lg border border-paper-300 bg-surface shadow-card">
                      <table className="w-full min-w-[560px] text-sm" aria-label="Product pivot">
                        <thead>
                          <tr className="border-b border-paper-300 text-left">
                            <th className="overline px-5 py-3 font-semibold text-ink-400">Product</th>
                            {PIVOT_GROUPS.map((g) => (
                              <th
                                key={g}
                                className="overline px-4 py-3 text-right font-semibold text-ink-400"
                              >
                                {GROUP_LABELS[g]}
                              </th>
                            ))}
                            <th className="overline px-5 py-3 text-right font-semibold text-ink-400">
                              Total
                            </th>
                          </tr>
                        </thead>
                        <tbody>
                          {analytics.by_kind.map((row) => (
                            <tr key={row.kind} className="border-b border-paper-200 last:border-0">
                              <td className="px-5 py-3">
                                <KindBadge kind={row.kind} />
                              </td>
                              {PIVOT_GROUPS.map((g) => (
                                <td key={g} className="tnum px-4 py-3 text-right text-ink-600">
                                  {row[g] ? (
                                    <Link
                                      to={drillTo({ kind: row.kind, group: g })}
                                      className={drillLinkClass}
                                    >
                                      {row[g]}
                                    </Link>
                                  ) : (
                                    '—'
                                  )}
                                </td>
                              ))}
                              <td className="tnum px-5 py-3 text-right font-semibold">
                                <Link to={drillTo({ kind: row.kind })} className={drillLinkClass}>
                                  {row.total}
                                </Link>
                              </td>
                            </tr>
                          ))}
                          <tr className="bg-paper-50">
                            <td className="px-5 py-3 text-xs font-semibold text-ink-400 uppercase">Total</td>
                            {PIVOT_GROUPS.map((g) => {
                              const sum = analytics.by_kind.reduce((acc, row) => acc + row[g], 0);
                              return (
                                <td key={g} className="tnum px-4 py-3 text-right font-semibold">
                                  {sum ? (
                                    <Link to={drillTo({ group: g })} className={drillLinkClass}>
                                      {sum}
                                    </Link>
                                  ) : (
                                    '—'
                                  )}
                                </td>
                              );
                            })}
                            <td className="tnum px-5 py-3 text-right font-semibold">
                              <Link to={drillTo({})} className={drillLinkClass}>
                                {analytics.total}
                              </Link>
                            </td>
                          </tr>
                        </tbody>
                      </table>
                    </div>
                  )}

                  {/* Per-state detail — surfaces the states the grouped pivot hides. */}
                  {Object.keys(analytics.by_state).length > 0 && (
                    <div className="mt-4 overflow-x-auto rounded-lg border border-paper-300 bg-surface shadow-card">
                      <table className="w-full min-w-[360px] text-sm" aria-label="State detail">
                        <thead>
                          <tr className="border-b border-paper-300 text-left">
                            <th className="overline px-5 py-3 font-semibold text-ink-400">State</th>
                            <th className="overline px-5 py-3 text-right font-semibold text-ink-400">
                              Valuations
                            </th>
                          </tr>
                        </thead>
                        <tbody>
                          {VALUATION_STATES.filter((s) => analytics.by_state[s]).map((s) => (
                            <tr key={s} className="border-b border-paper-200 last:border-0">
                              <td className="px-5 py-3">{STATE_LABELS[s] ?? s}</td>
                              <td className="tnum px-5 py-3 text-right">
                                <Link to={drillTo({ state: s })} className={drillLinkClass}>
                                  {analytics.by_state[s]}
                                </Link>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </>
              )}
            </>
          )}

          {/* ── Activity feed: who did what, on which engagement. Scoped
              server-side — every row names a company, so this is the sharpest
              of the four bands and the one a cross-firm leak would show in. */}
          {showAnalytics && analytics?.activity && analytics.activity.length > 0 && (
            <>
              <div className="mt-10 flex items-center justify-between">
                <h2 className="overline text-ink-400">Recent activity</h2>
                {isOps(user) && (
                  <Link to="/activity" className="text-sm font-semibold text-bond-600 hover:text-bond-700">
                    View all →
                  </Link>
                )}
              </div>
              <ul className="mt-4 divide-y divide-paper-200 rounded-lg border border-paper-300 bg-surface shadow-card">
                {analytics.activity.map((row) => (
                  <li key={row.id}>
                    <Link
                      to={`/valuations/${row.valuation_id}`}
                      className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-5 py-3 hover:bg-paper-50"
                    >
                      <span className="text-sm font-medium text-ink-900">{eventLabel(row.type)}</span>
                      <span className="min-w-0 flex-1 truncate text-sm text-ink-500">
                        {row.company_name} · #{row.number}
                      </span>
                      <span className="text-xs text-ink-400">
                        {row.actor_type === 'human' ? (row.actor_email ?? 'unknown') : row.actor_type}
                      </span>
                      <span className="tnum text-xs text-ink-400">{formatDate(row.occurred_at)}</span>
                    </Link>
                  </li>
                ))}
              </ul>
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
                    className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-paper-300 bg-surface px-5 py-4 shadow-card transition-shadow hover:shadow-lift"
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
