import { useCallback, useEffect, useState } from 'react';
import { Link, NavLink, Outlet, useOutletContext, useParams } from 'react-router-dom';
import { api, ApiError } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { isOps } from '../../lib/rbac';
import { REPORT_VISIBLE_STATES } from '../../lib/m2';
import { useValuationStream, type Viewer } from '../../lib/realtime';
import type { Valuation } from '../../lib/types';
import { ErrorNote, KindBadge, Spinner, StateBadge } from '../../components/ui';

export interface WorkspaceContext {
  valuation: Valuation;
  reload: () => Promise<void>;
  /** Live co-viewers of this valuation (excluding the current user). */
  viewers: Viewer[];
  /** Bumps when a comment lands anywhere on this valuation (SSE). */
  commentTick: number;
}

/** Improvement 4 — "X is viewing" presence badges (live via SSE). */
export function PresenceBadges({ viewers }: { viewers: Viewer[] }) {
  if (viewers.length === 0) return null;
  return (
    <span className="flex flex-wrap items-center gap-1.5" data-testid="presence-badges">
      {viewers.map((v) => (
        <span
          key={v.user_id}
          className="flex items-center gap-1.5 rounded-full bg-emerald-50 px-2.5 py-0.5 text-xs font-semibold text-emerald-800 ring-1 ring-emerald-200 ring-inset"
        >
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-500" />
          {v.name} is viewing
        </span>
      ))}
    </span>
  );
}

export function useWorkspace(): WorkspaceContext {
  return useOutletContext<WorkspaceContext>();
}

function Tab({ to, label, end = false }: { to: string; label: string; end?: boolean }) {
  return (
    <NavLink
      to={to}
      end={end}
      className={({ isActive }) =>
        `-mb-px border-b-2 px-1 pb-2.5 text-sm font-semibold whitespace-nowrap transition-colors ${
          isActive
            ? 'border-bond-600 text-bond-700'
            : 'border-transparent text-ink-400 hover:border-ink-200 hover:text-ink-700'
        }`
      }
    >
      {label}
    </NavLink>
  );
}

/**
 * Per-valuation workspace shell (features.md "analyst nav"): loads the
 * aggregate, renders the header + tab bar, and hands the valuation to the
 * active tab via outlet context. Tab visibility mirrors the API's RBAC —
 * working data (M1/M2 analyst tooling) is ops-only.
 */
export function ValuationWorkspace() {
  const { id } = useParams<{ id: string }>();
  const { user } = useAuth();
  const [valuation, setValuation] = useState<Valuation | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { viewers, commentTick } = useValuationStream(id ?? '');

  const reload = useCallback(async () => {
    if (!id) return;
    try {
      const { valuation: v } = await api<{ valuation: Valuation }>(`/valuations/${id}`);
      setValuation(v);
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 404
          ? 'This valuation does not exist or you do not have access to it.'
          : 'Could not load the valuation.',
      );
    }
  }, [id]);

  useEffect(() => {
    void reload();
  }, [reload]);

  if (error) {
    return (
      <div className="max-w-xl">
        <ErrorNote>{error}</ErrorNote>
        <Link to="/valuations" className="mt-4 inline-block text-sm font-semibold text-bond-600 hover:text-bond-700">
          ← Back to valuations
        </Link>
      </div>
    );
  }
  if (!valuation) return <Spinner />;

  const ops = isOps(user);
  const owner = valuation.user_id === user?.id;
  const showReportTab = ops || REPORT_VISIBLE_STATES.has(valuation.state);
  const base = `/valuations/${valuation.id}`;

  return (
    <div>
      <Link to="/valuations" className="text-sm font-semibold text-bond-600 hover:text-bond-700">
        ← Valuations
      </Link>

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <h1 className="font-display text-3xl font-semibold text-ink-900">{valuation.company_name}</h1>
        <KindBadge kind={valuation.kind} />
        <StateBadge state={valuation.state} />
        {valuation.waiting_on_client && (
          <span className="rounded-full bg-amber-50 px-2.5 py-0.5 text-xs font-semibold text-amber-800 ring-1 ring-amber-200 ring-inset">
            Waiting on client
          </span>
        )}
        <PresenceBadges viewers={viewers.filter((v) => v.user_id !== user?.id)} />
      </div>
      <p className="tnum mt-1.5 text-xs text-ink-400">Ref {valuation.id}</p>

      <nav
        className="mt-6 flex gap-6 overflow-x-auto border-b border-paper-300"
        aria-label="Valuation workspace"
      >
        <Tab to={base} label="Overview" end />
        <Tab to={`${base}/progress`} label="Progress" />
        {(ops || owner) && <Tab to={`${base}/company`} label="Company" />}
        <Tab to={`${base}/documents`} label="Documents" />
        {(ops || owner) && <Tab to={`${base}/params`} label="Params" />}
        {ops && <Tab to={`${base}/workbook`} label="Workbook" />}
        {ops && <Tab to={`${base}/overwrites`} label="Overwrites" />}
        {ops && <Tab to={`${base}/ai`} label="AI" />}
        {ops && <Tab to={`${base}/tasks`} label="Tasks" />}
        {ops && <Tab to={`${base}/calculations`} label="Calculations" />}
        {ops && <Tab to={`${base}/qa`} label="QA" />}
        {ops && <Tab to={`${base}/decisions`} label="Decisions" />}
        <Tab to={`${base}/scenarios`} label="What-If Scenarios" />
        {ops && <Tab to={`${base}/sensitivity`} label="Sensitivity" />}
        {showReportTab && <Tab to={`${base}/report`} label="Report" />}
        {ops && <Tab to={`${base}/package`} label="Package" />}
      </nav>

      <div className="mt-8">
        <Outlet
          context={
            {
              valuation,
              reload,
              viewers: viewers.filter((v) => v.user_id !== user?.id),
              commentTick,
            } satisfies WorkspaceContext
          }
        />
      </div>
    </div>
  );
}
