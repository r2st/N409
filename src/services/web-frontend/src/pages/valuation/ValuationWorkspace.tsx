import { Suspense, useCallback, useEffect, useState } from 'react';
import { Link, NavLink, Outlet, useLocation, useOutletContext, useParams } from 'react-router-dom';
import { api, ApiError } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { isOps } from '../../lib/rbac';
import { REPORT_VISIBLE_STATES } from '../../lib/m2';
import { useValuationStream, type Viewer } from '../../lib/realtime';
import type { Valuation } from '../../lib/types';
import { useLatestOnly } from '../../lib/useLatestOnly';
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
import { usePageTitleDetail } from '../../components/RouteTitle';

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
  completeness: 'health-checks-overview',
  decisions: 'board-approval-overview',
  scenarios: 'pwerm-overview',
  bridge: 'value-bridge-overview',
  analytics: 'sensitivity-overview',
  report: 'report-overview',
  grants: 'grants-overview',
  asc718: 'asc718-public-overview',
  monitoring: 'monitoring-overview',
  package: 'report-overview',
  specialty: 'methodology-overview',
  research: 'comparables-overview',
  comparables: 'comparables-overview',
};

/**
 * The help article for a workspace tab, defaulting to the overview.
 *
 * `Object.hasOwn` rather than a bare lookup, because the argument is a path
 * segment — whatever follows the workspace base in the address bar.
 * `/valuations/:id/constructor` was answered from `Object.prototype` with a
 * value that is not nullish, so the fallback never ran and the help icon linked
 * at an article named after a function's source text.
 */
export function helpArticleFor(tab: string): string {
  return Object.hasOwn(TAB_HELP, tab) ? TAB_HELP[tab]! : 'valuations-overview';
}

/**
 * Report types with a dedicated specialty engine (domain/specialty.ts
 * SPECIALTY_KINDS). Mirrored here only to decide whether to *show* the tab —
 * the tab itself reads the engine definition from the server, so this list can
 * never disagree with the engine that runs.
 *
 * Shown conditionally because a Run button on a 409A that 422s is worse than
 * no button: it teaches an operator that the tab is unreliable rather than that
 * the report type is wrong.
 */
export const SPECIALTY_TAB_KINDS: ReadonlySet<string> = new Set([
  'qsbs',
  'ppa',
  'goodwill',
  'esop',
  'fmv',
  'emi',
  'csop',
  'ip',
  '820',
  'gifts',
  'ifrs2',
]);

/**
 * The header chip row and the Calculations badge (design §4.6, §7.3).
 *
 * Every number is outstanding work rather than a total — three pending files
 * is a thing to do, twelve documents is a fact about the past — which is what
 * makes zero a meaningful state and the chip worth looking at.
 */
export interface ValuationCounters {
  pending_files: number;
  my_tasks: number;
  all_tasks: number;
  unread_comments: number;
  calculations: { done: number; total: number; missing: string[] };
}

export interface WorkspaceContext {
  valuation: Valuation;
  counters: ValuationCounters | null;
  reload: () => Promise<void>;
  /** Live co-viewers of this valuation (excluding the current user). */
  viewers: Viewer[];
  /** Bumps when a comment lands anywhere on this valuation (SSE). */
  commentTick: number;
  /**
   * The firm has withdrawn this engagement: readable, and refusing every write.
   *
   * `valuation.archived_at` says the same thing and tabs used to have to know
   * that. Named here because it is a condition of the whole workspace rather
   * than a column — the banner below states it once for every tab, and a tab
   * that closes a control reads better asking `retired` than asking about a
   * timestamp.
   */
  retired: boolean;
}

/**
 * The standing condition of a withdrawn engagement, stated once for the
 * workspace.
 *
 * R89 put this on the Overview tab, which is where it was noticed and not
 * where it belongs: the workspace has twenty-five tabs and every one of them
 * offered its full write UI on a retired engagement, so a client could fill in
 * a questionnaire on the Intake tab or upload a document with nothing on
 * screen to say the work had been withdrawn — and find out from a 409 after
 * the file had already gone up the wire. Rendered in the shell, above the
 * outlet, so it is on every tab.
 *
 * `role="status"` rather than `alert`: this is the condition of the page a
 * reader has just opened, not something that happened to them, and an
 * assertive live region interrupts whatever a screen reader was already
 * saying.
 */
export function RetiredBanner() {
  return (
    <section
      role="status"
      className="mt-6 rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900"
    >
      <p className="font-semibold">This engagement has been retired.</p>
      <p className="mt-1">
        It is kept here for reference and can still be read, but it no longer accepts changes — editing,
        workflow moves, report generation and reminders are all closed, on every tab. Nothing in this
        workspace will bring it back: an administrator can restore it from Data retention, and until they do,
        every control that would change it stays closed.
      </p>
    </section>
  );
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

function Tab({
  to,
  label,
  end = false,
  badge,
  badgeTone = 'neutral',
  badgeTitle,
}: {
  to: string;
  label: string;
  end?: boolean;
  badge?: string;
  badgeTone?: 'neutral' | 'attention';
  badgeTitle?: string;
}) {
  return (
    <NavLink
      to={to}
      end={end}
      className={({ isActive }) =>
        `-mb-px flex items-center gap-1.5 border-b-2 px-1 pb-2.5 text-sm font-semibold whitespace-nowrap transition-colors ${
          isActive
            ? 'border-bond-600 text-bond-700'
            : 'border-transparent text-ink-400 hover:border-ink-200 hover:text-ink-700'
        }`
      }
    >
      {label}
      {badge !== undefined && (
        <span
          title={badgeTitle}
          className={`tnum rounded-full px-1.5 py-0.5 text-[0.65rem] font-bold ${
            badgeTone === 'attention' ? 'bg-amber-100 text-amber-800' : 'bg-paper-300 text-ink-500'
          }`}
        >
          {badge}
        </span>
      )}
    </NavLink>
  );
}

/**
 * The four header counters (design §4.6).
 *
 * Rendered as links rather than as text, because every one of them is a
 * question whose answer is on another tab: "2 pending files" that does not take
 * you to the files is a number to memorise and then go looking for.
 *
 * A zero chip is dimmed rather than hidden. The row disappearing as work is
 * cleared would make "no chips" ambiguous between "nothing outstanding" and
 * "not loaded yet", and the reader would have to check.
 */
function CounterChips({ base, counters }: { base: string; counters: ValuationCounters }) {
  const chips: Array<{ to: string; label: string; value: number; attention?: boolean }> = [
    { to: `${base}/documents`, label: 'Pending files', value: counters.pending_files },
    { to: `${base}/tasks`, label: 'My tasks', value: counters.my_tasks, attention: true },
    { to: `${base}/tasks`, label: 'All tasks', value: counters.all_tasks },
    { to: `${base}/engagement`, label: 'Unread chat', value: counters.unread_comments, attention: true },
  ];
  return (
    <div className="mt-3 flex flex-wrap items-center gap-2">
      {chips.map((chip) => (
        <Link
          key={chip.label}
          to={chip.to}
          className={`rounded-full border px-2.5 py-1 text-xs font-semibold transition-colors ${
            chip.value === 0
              ? 'border-paper-300 bg-surface text-ink-400 hover:border-ink-200'
              : chip.attention
                ? 'border-amber-200 bg-amber-50 text-amber-800 hover:border-amber-300'
                : 'border-bond-200 bg-bond-50 text-bond-800 hover:border-bond-300'
          }`}
        >
          {chip.label} <span className="tnum">({chip.value})</span>
        </Link>
      ))}
    </div>
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
  /*
   * Both pieces of loaded state remember *which* engagement they are about.
   *
   * Ordering the replies (below) settled which one wins the race; it did not
   * change what is on screen during it. Held as a bare `Valuation | null`, this
   * state still contained the previous engagement's row for the whole round
   * trip after the URL moved, so the heading, the reference, the badges, the
   * counter chips and the object handed to the tab through the outlet context
   * were all confidently about the engagement the analyst had just left. It
   * reads as a loaded page — nothing spins and nothing disagrees with anything
   * else — which is what makes it worse than a slow one.
   *
   * Tagging with the id it was requested for, and deriving below, makes the
   * mismatch unrepresentable rather than merely short: there is no render in
   * which a stale row can be read.
   */
  const [loaded, setLoaded] = useState<{
    forId: string;
    valuation: Valuation;
    counters: ValuationCounters | null;
  } | null>(null);
  const [failure, setFailure] = useState<{ forId: string; message: string } | null>(null);
  const { viewers, commentTick } = useValuationStream(id ?? '');

  /*
   * Navigating from one valuation straight to another — a bridge candidate, a
   * portfolio entity, the browser's back button — changes `:id` without this
   * component being torn down, so two aggregates can be in flight at once and
   * nothing orders their replies. What the late one paints is not a mismatch
   * anyone can see: the company name, the state badge, the counters and the
   * `valuation` object every tab below reads all come from this one response,
   * so the whole workspace agrees with itself about the wrong engagement, under
   * the other one's URL. See `useLatestOnly`.
   */
  const claim = useLatestOnly();

  const reload = useCallback(async () => {
    if (!id) return;
    const current = claim();
    try {
      const { valuation: v, counters: c } = await api<{
        valuation: Valuation;
        counters?: ValuationCounters;
      }>(`/valuations/${id}`);
      if (!current()) return;
      setLoaded({ forId: id, valuation: v, counters: c ?? null });
    } catch (err) {
      if (!current()) return;
      setFailure({
        forId: id,
        message:
          err instanceof ApiError && err.status === 404
            ? 'This valuation does not exist or you do not have access to it.'
            : 'Could not load the valuation.',
      });
    }
  }, [id, claim]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // Loaded state is only this route's while it is about this route's id.
  const valuation = loaded && loaded.forId === id ? loaded.valuation : null;
  const counters = loaded && loaded.forId === id ? loaded.counters : null;
  const error = failure && failure.forId === id ? failure.message : null;

  /*
   * "Cap Table · N409" is the same title on every valuation an analyst has
   * open. The company name is the only thing that tells the tabs apart, and it
   * is not known until the aggregate lands — hence a detail registered from
   * here rather than a wider registry entry. Above the early returns because it
   * is a hook; `undefined` while loading simply leaves the tab title alone.
   */
  usePageTitleDetail(valuation?.company_name);

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
  const retired = Boolean(valuation.archived_at);
  const showReportTab = ops || REPORT_VISIBLE_STATES.has(valuation.state);
  const base = `/valuations/${valuation.id}`;

  // Active tab = first path segment after the workspace base ('' on Overview).
  const activeTab = location.pathname.slice(base.length).replace(/^\//, '').split('/')[0] ?? '';
  const helpArticle = helpArticleFor(activeTab);

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

      {/* Ops only: the chips count analyst working state — files an analyst has
          cleared, tasks in the review queue — none of which a client has a
          view of or an action on. */}
      {ops && counters && <CounterChips base={base} counters={counters} />}

      {retired && <RetiredBanner />}

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
        {ops && (
          /* §7.3 — `n/m`: approaches computed over approaches the weighting
             asks for. Amber while short, because a 2/4 that reads like a 4/4
             is worse than no badge. */
          <Tab
            to={`${base}/calculations`}
            label="Calculations"
            badge={counters ? `${counters.calculations.done}/${counters.calculations.total}` : undefined}
            badgeTone={
              counters && counters.calculations.done < counters.calculations.total ? 'attention' : 'neutral'
            }
            badgeTitle={
              counters && counters.calculations.missing.length > 0
                ? `Not yet computed: ${counters.calculations.missing.join(', ')}`
                : 'Every weighted approach has a result'
            }
          />
        )}
        {ops && SPECIALTY_TAB_KINDS.has(valuation.kind) && (
          <Tab to={`${base}/specialty`} label="Specialty Engine" />
        )}
        {/* Research is readable by the owner too: the citations are the
            provenance behind the report's market discussion, and "where did
            this multiple come from" is a fair question. Running it is ops-only,
            and the tab enforces that from the served `can_run`. */}
        {(ops || owner) && <Tab to={`${base}/research`} label="Market Research" />}
        {/* Same reasoning as Research: the client whose report rests on the
            median may read the set it was struck from. Editing it is ops-only,
            and the tab enforces that from the served `can_edit`. */}
        {(ops || owner) && <Tab to={`${base}/comparables`} label="Comparables" />}
        {ops && <Tab to={`${base}/qa`} label="QA" />}
        {ops && <Tab to={`${base}/health`} label="Health" />}
        <Tab to={`${base}/completeness`} label="Completeness" />
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
        {/* Ops-only: the payloads are the engine's raw working state. */}
        {ops && <Tab to={`${base}/network`} label="Network Log" />}
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
          {/*
           * Keyed by the valuation, so the tab below is torn down and rebuilt
           * when the URL moves to a different engagement rather than being
           * re-rendered with new props.
           *
           * This is the guard for a whole family at once. Every tab and every
           * panel under it loads its own slice from `/valuations/${id}/…`, and
           * each one of those is the same race as this component's: two slices
           * outstanding, the previous engagement's reply landing second. Forty
           * or so effects, each of which would otherwise need its own ticket.
           * A remount cannot be raced — the late reply writes to state that no
           * longer exists, which React discards.
           */}
          <Outlet
            key={id}
            context={
              {
                valuation,
                counters,
                reload,
                viewers: viewers.filter((v) => v.user_id !== user?.id),
                commentTick,
                retired,
              } satisfies WorkspaceContext
            }
          />
        </Suspense>
      </div>
    </div>
  );
}
