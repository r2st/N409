import { Suspense, useCallback, useEffect, useState } from 'react';
import { Link, NavLink, Outlet, useLocation, useOutletContext, useParams } from 'react-router-dom';
import { api, ApiError } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { isOps } from '../../lib/rbac';
import { REPORT_VISIBLE_STATES } from '../../lib/m2';
import { useValuationStream, type Viewer } from '../../lib/realtime';
import type { Valuation } from '../../lib/types';
import {
  ErrorNote,
  KindBadge,
  LoadingBlock,
  Skeleton,
  SkeletonTable,
  SkeletonText,
  StateBadge,
} from '../../components/ui';
import { HelpIcon } from '../../components/HelpIcon';
import { ScrollableTabs } from '../../components/ScrollableTabs';

/**
 * Maps each workspace tab (keyed by its sub-path, '' = Overview) to the help
 * article that explains it. Feeds the single contextual "?" in the header so
 * every tab surfaces a help link without each tab wiring its own icon. Tabs
 * without a dedicated article fall back to the general valuations overview.
 */
export const TAB_HELP: Record<string, string> = {
  '': 'valuations-overview',
  progress: 'engagement-overview',
  'audit-trail': 'valuations-overview',
  intake: 'creating-a-valuation',
  company: 'comparables-overview',
  documents: 'financial-data-overview',
  'cap-table': 'cap-table-basics',
  model: 'financial-data-overview',
  params: 'assumptions-overview',
  workbook: 'methodology-overview',
  overwrites: 'assumptions-overview',
  ai: 'ai-agents-overview',
  engagement: 'engagement-overview',
  tasks: 'engagement-overview',
  calculations: 'methodology-overview',
  qa: 'health-checks-overview',
  health: 'health-checks-overview',
  decisions: 'board-approval-overview',
  scenarios: 'pwerm-overview',
  bridge: 'value-bridge-overview',
  analytics: 'sensitivity-overview',
  report: 'report-overview',
  grants: 'grants-overview',
  asc718: 'asc718-public-overview',
  monitoring: 'monitoring-overview',
  package: 'report-overview',
};

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
 * Placeholder for the workspace shell itself: back-link, company name, badge
 * row, reference line and the tab strip. The shell's geometry is fixed and
 * known before the aggregate arrives, so it can be drawn immediately and the
 * heading lands where the reader is already looking.
 */
function WorkspaceSkeleton() {
  const tabWidths = ['w-16', 'w-20', 'w-14', 'w-24', 'w-16', 'w-20'];
  return (
    <LoadingBlock label="Loading valuation…">
      <Skeleton className="h-3.5 w-24" />
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <Skeleton className="h-8 w-64 max-w-full" />
        <Skeleton className="h-5 w-20" />
        <Skeleton className="h-5 w-24" />
      </div>
      <Skeleton className="mt-2 h-3 w-56 max-w-full" />
      <div className="mt-6 flex gap-6 border-b border-paper-300 pb-2.5">
        {tabWidths.map((w, i) => (
          <Skeleton key={i} className={`h-3.5 ${w}`} />
        ))}
      </div>
      <div className="mt-8">
        <SkeletonText lines={2} className="max-w-lg" />
        <div className="mt-6 rounded-lg border border-paper-300 bg-surface p-2 shadow-card">
          <SkeletonTable columns={4} rows={4} />
        </div>
      </div>
    </LoadingBlock>
  );
}

/**
 * Fallback for a tab whose chunk has not downloaded yet. Deliberately generic —
 * the tabs range from a two-field form to a twelve-column table, so this claims
 * only that a panel of some sort is arriving, and does it inside the workspace
 * so the header and tab strip stay put while it does.
 */
function TabSkeleton() {
  return (
    <LoadingBlock label="Loading tab…">
      <SkeletonText lines={2} className="max-w-lg" />
      <div className="mt-6 rounded-lg border border-paper-300 bg-surface p-2 shadow-card">
        <SkeletonTable columns={4} rows={4} />
      </div>
    </LoadingBlock>
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
  const location = useLocation();
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
        <Link
          to="/valuations"
          className="mt-4 inline-block text-sm font-semibold text-bond-600 hover:text-bond-700"
        >
          ← Back to valuations
        </Link>
      </div>
    );
  }
  if (!valuation) return <WorkspaceSkeleton />;

  const ops = isOps(user);
  const owner = valuation.user_id === user?.id;
  const showReportTab = ops || REPORT_VISIBLE_STATES.has(valuation.state);
  const base = `/valuations/${valuation.id}`;

  // Active tab = first path segment after the workspace base ('' on Overview).
  const activeTab = location.pathname.slice(base.length).replace(/^\//, '').split('/')[0] ?? '';
  const helpArticle = TAB_HELP[activeTab] ?? 'valuations-overview';

  return (
    <div>
      <Link to="/valuations" className="text-sm font-semibold text-bond-600 hover:text-bond-700">
        ← Valuations
      </Link>

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <h1 className="font-display text-3xl font-semibold text-ink-900">{valuation.company_name}</h1>
        <HelpIcon
          key={helpArticle}
          article={helpArticle}
          label="Help for this tab"
          className="h-6 w-6 text-sm"
        />
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

      <ScrollableTabs label="Valuation workspace" activeKey={activeTab}>
        <Tab to={base} label="Overview" end />
        <Tab to={`${base}/progress`} label="Progress" />
        {(ops || owner) && <Tab to={`${base}/intake`} label="Intake" />}
        {(ops || owner) && <Tab to={`${base}/company`} label="Company" />}
        <Tab to={`${base}/documents`} label="Documents" />
        {(ops || owner) && <Tab to={`${base}/cap-table`} label="Cap Table" />}
        {ops && <Tab to={`${base}/model`} label="Financial Model" />}
        {(ops || owner) && <Tab to={`${base}/params`} label="Params" />}
        {ops && <Tab to={`${base}/workbook`} label="Workbook" />}
        {ops && <Tab to={`${base}/overwrites`} label="Overwrites" />}
        {ops && <Tab to={`${base}/ai`} label="AI" />}
        {ops && <Tab to={`${base}/engagement`} label="Engagement" />}
        {ops && <Tab to={`${base}/tasks`} label="Tasks" />}
        {ops && <Tab to={`${base}/calculations`} label="Calculations" />}
        {ops && <Tab to={`${base}/qa`} label="QA" />}
        {ops && <Tab to={`${base}/health`} label="Health" />}
        {ops && <Tab to={`${base}/decisions`} label="Decisions" />}
        <Tab to={`${base}/scenarios`} label="What-If Scenarios" />
        {ops && <Tab to={`${base}/sensitivity`} label="Sensitivity" />}
        {ops && <Tab to={`${base}/bridge`} label="Value Bridge" />}
        {ops && <Tab to={`${base}/analytics`} label="Analytics" />}
        {showReportTab && <Tab to={`${base}/report`} label="Report" />}
        {(ops || owner) && <Tab to={`${base}/grants`} label="Grants" />}
        {ops && <Tab to={`${base}/asc718`} label="ASC 718" />}
        {ops && <Tab to={`${base}/monitoring`} label="Monitoring" />}
        {ops && <Tab to={`${base}/package`} label="Package" />}
        <Tab to={`${base}/audit-trail`} label="Change History" />
      </ScrollableTabs>

      <div className="mt-8">
        {/*
         * Each tab is its own lazy chunk. Without a boundary here the first
         * click on a tab suspends all the way up to the app shell, which
         * replaces the valuation header and the tab strip the analyst just
         * clicked — so the control that caused the navigation disappears.
         * Catching it at the panel keeps the tab bar interactive throughout.
         */}
        <Suspense fallback={<TabSkeleton />}>
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
        </Suspense>
      </div>
    </div>
  );
}
