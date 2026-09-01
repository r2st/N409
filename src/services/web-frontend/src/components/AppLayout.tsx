import { Suspense, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { PageSkeleton } from './ui';
import { ErrorBoundary } from './ErrorBoundary';
import { reportCrash } from '../lib/crashReport';
import { SkipLink, mainContentTargetProps } from './SkipLink';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { canManageUsers, effectiveUser, isFirmAdmin, isOps, isPartner, scopeLabel } from '../lib/rbac';
import { displayName, initials } from '../lib/format';
import { Wordmark } from './Logo';
import { HelpWidget } from './HelpWidget';
import { ViewModeToggle } from './ViewModeToggle';
import { ThemeToggle } from './ThemeToggle';
import { CommandPalette, PaletteTrigger } from './CommandPalette';

function NavItem({
  to,
  label,
  icon,
  onNavigate,
  badge,
  count,
}: {
  to: string;
  label: string;
  icon: ReactNode;
  onNavigate: () => void;
  /** Needs attention — rendered in the accent colour. */
  badge?: number;
  /** How many there are — muted, and never competing with the badge. */
  count?: number;
}) {
  return (
    <NavLink
      to={to}
      end={to === '/dashboard'}
      onClick={onNavigate}
      className={({ isActive }) =>
        `group flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors ${
          isActive
            ? 'bg-chrome-800 text-chrome-fg shadow-[inset_2px_0_0_var(--color-brass-400)]'
            : 'text-chrome-dim hover:bg-chrome-800/60 hover:text-chrome-fg'
        }`
      }
    >
      <span className="text-chrome-faint group-hover:text-brass-300">{icon}</span>
      {label}
      {count !== undefined && (
        <span className={`tnum text-[0.7rem] text-chrome-faint ${badge ? '' : 'ml-auto'}`}>{count}</span>
      )}
      {badge !== undefined && badge > 0 && (
        <span
          className={`tnum rounded-full bg-brass-400 px-1.5 py-0.5 text-[0.65rem] font-bold text-chrome-900 ${
            count === undefined ? 'ml-auto' : 'ml-1.5'
          }`}
        >
          {badge > 99 ? '99+' : badge}
        </span>
      )}
    </NavLink>
  );
}

/**
 * Collapsible nav section (final-status §3.3 #1): the ops/admin blocks fold
 * away so the sidebar stays scannable. Open state persists per section.
 */
function NavGroup({ label, children }: { label: string; children: ReactNode }) {
  const storageKey = `n409.nav.${label.toLowerCase()}`;
  const [open, setOpen] = useState(() => localStorage.getItem(storageKey) !== 'closed');
  const toggle = () => {
    setOpen((v) => {
      localStorage.setItem(storageKey, v ? 'closed' : 'open');
      return !v;
    });
  };
  return (
    <>
      <button
        onClick={toggle}
        aria-expanded={open}
        className="overline mt-6 mb-2 flex w-full cursor-pointer items-center justify-between px-3 text-left text-chrome-faint/80 hover:text-chrome-dim"
      >
        {label}
        <svg
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          className={`transition-transform ${open ? 'rotate-90' : ''}`}
          aria-hidden
        >
          <path d="M9 5l7 7-7 7" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && children}
    </>
  );
}

/**
 * How often a nav badge re-reads its count on a timer.
 */
const BADGE_POLL_MS = 60_000;

/**
 * The floor under how often a *navigation* may re-ask.
 *
 * WHY THIS EXISTS (round 330, methodology M8). The three badge hooks below all
 * carried `location.pathname` in their dependency list, which is the right
 * intent — a state change made on the workspace should show up in the sidebar
 * without a reload — implemented as "fire all three again, immediately, on
 * every client-side navigation". Clicking through the six sidebar buckets is
 * eighteen requests in a couple of seconds, every one of them returning the
 * numbers the last one returned.
 *
 * Fifteen seconds is not a guess: it is `UNREAD_COUNT_CACHE_TTL_MS` and
 * `COUNTS_CACHE_TTL_MS`, the TTL caches all three of these endpoints sit
 * behind server-side. Inside that window the server *cannot* answer
 * differently, so a re-poll is guaranteed to spend a round trip to be told
 * what this tab already knows. Those caches were added (see `routes/inbox.ts`)
 * to absorb exactly this storm — but a cache absorbs the query, not the
 * request: each one still costs a JWT verification, the `findAuthPrincipal`
 * join every authenticated route makes, and a charge against the caller's rate
 * limit. This is the other half of that fix, on the side that is doing the
 * asking.
 *
 * The floor applies to navigation only. A freshly mounted hook has never
 * asked and always polls, so a reload, a sign-in, or a route that mounts the
 * shell for the first time is unaffected — and the timer above is untouched,
 * so a tab left open still refreshes on its own cadence.
 */
const BADGE_MIN_REFETCH_MS = 15_000;

/**
 * One nav badge: fetched on mount, re-fetched on navigation and on a timer.
 *
 * Shared by the three below because they had three copies of this effect and
 * the copies are what let the navigation storm go unnoticed in all of them.
 *
 * Silent on failure, which every caller relied on: a client user's scope
 * answers zero rather than erroring, and a stale session should not put an
 * error banner in the navigation.
 */
function useBadgePoll<T>(path: string, enabled: boolean): T | null {
  const [value, setValue] = useState<T | null>(null);
  const location = useLocation();
  // Per hook instance rather than module-level: this is "has *this* badge
  // asked recently", and a remount is a badge that has never asked.
  const lastPolledAt = useRef(0);
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const poll = () => {
      lastPolledAt.current = Date.now();
      api<T>(path)
        .then((d) => {
          if (!cancelled) setValue(d);
        })
        .catch(() => {});
    };
    if (Date.now() - lastPolledAt.current >= BADGE_MIN_REFETCH_MS) poll();
    const timer = setInterval(poll, BADGE_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [location.pathname, enabled, path]);
  return value;
}

/**
 * Polls the unread *thread* count for the shared inbox — engagements whose
 * conversation has moved since this reader last opened them.
 *
 * Threads and not messages: "3" should mean three files want attention, which
 * is actionable. A message count means "somebody wrote nine paragraphs", which
 * is not, and it is the number that made the old global badge ignorable.
 *
 * Silent on failure. A client user has no inbox and the endpoint answers 0 for
 * them, but a partner whose session has gone stale would otherwise get an
 * error banner from a badge.
 */
function useInboxUnread(enabled: boolean): number {
  return useBadgePoll<{ unread_threads: number }>('/inbox/unread-count', enabled)?.unread_threads ?? 0;
}

/**
 * Live counts for the nine named listing buckets (design §3.2/§4.2).
 *
 * The nav has carried static labels while the counts existed server-side the
 * whole time. Polled on the same cadence as the other two badges and re-read on
 * navigation, so a state change made on the workspace shows up in the sidebar
 * without a reload — see {@link useBadgePoll}.
 *
 * Silent on failure, like the other badges: a client user's scope answers zero
 * rather than erroring, and a stale session should not put an error banner in
 * the navigation.
 */
export interface BucketCounts {
  all: number;
  incomplete: number;
  unverified: number;
  in_progress: number;
  waiting_on_client: number;
  drafted: number;
  published: number;
  unread: number;
  ignored: number;
}

function useBucketCounts(enabled: boolean): BucketCounts | null {
  return (
    useBadgePoll<{ counts: BucketCounts }>('/valuations/counts?buckets=named', enabled)?.counts ?? null
  );
}

/**
 * A bucket's row in the sidebar: total in muted type, unread in the accent,
 * matching the inbox's existing treatment.
 *
 * Only the All row carries an unread badge. Unread is a property of the reader
 * and cuts across every bucket, so repeating it beside each total would say the
 * same six things six times and mean something different each time.
 */
function BucketNav({ counts, onNavigate }: { counts: BucketCounts | null; onNavigate: () => void }) {
  const rows: Array<{ key: keyof BucketCounts; label: string; to: string }> = [
    { key: 'incomplete', label: 'Incomplete', to: '/valuations?bucket=incomplete' },
    { key: 'unverified', label: 'Unverified', to: '/valuations?bucket=unverified' },
    { key: 'in_progress', label: 'In Progress', to: '/valuations?bucket=in_progress' },
    { key: 'waiting_on_client', label: 'Waiting On Client', to: '/valuations?bucket=waiting_on_client' },
    { key: 'drafted', label: 'Drafted', to: '/valuations?bucket=drafted' },
    { key: 'published', label: 'Published', to: '/valuations?bucket=published' },
  ];
  return (
    <>
      {rows.map((row) => (
        <NavLink
          key={row.key}
          to={row.to}
          onClick={onNavigate}
          className={({ isActive }) =>
            `group flex items-center gap-3 rounded-md py-1.5 pr-3 pl-10 text-sm transition-colors ${
              isActive ? 'text-chrome-fg' : 'text-chrome-dim hover:text-chrome-fg'
            }`
          }
        >
          {row.label}
          {counts && <span className="tnum ml-auto text-[0.7rem] text-chrome-faint">{counts[row.key]}</span>}
        </NavLink>
      ))}
    </>
  );
}

/** Polls the unread notification count (M4) — see {@link useBadgePoll} for the cadence. */
function useUnreadCount(): number {
  return useBadgePoll<{ unread_count: number }>('/notifications/unread-count', true)?.unread_count ?? 0;
}

const icons = {
  dashboard: (
    <svg
      aria-hidden="true"
      width="17"
      height="17"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
    >
      <rect x="3" y="3" width="8" height="8" rx="1.5" />
      <rect x="13" y="3" width="8" height="5" rx="1.5" />
      <rect x="13" y="10" width="8" height="11" rx="1.5" />
      <rect x="3" y="13" width="8" height="8" rx="1.5" />
    </svg>
  ),
  valuations: (
    <svg
      aria-hidden="true"
      width="17"
      height="17"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
    >
      <path d="M4 20V10m5.5 10V4m5.5 16v-7M20.5 20V8" strokeLinecap="round" />
    </svg>
  ),
  newValuation: (
    <svg
      aria-hidden="true"
      width="17"
      height="17"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
    >
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 8.5v7M8.5 12h7" strokeLinecap="round" />
    </svg>
  ),
  schema: (
    <svg
      aria-hidden="true"
      width="17"
      height="17"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
    >
      <path
        d="M4 19.5V6a2 2 0 0 1 2-2h13.5v13.5H6a2 2 0 0 0-2 2Zm0 0A2 2 0 0 0 6 21.5h13.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M8.5 8.5h7M8.5 12h5" strokeLinecap="round" />
    </svg>
  ),
  settings: (
    <svg
      aria-hidden="true"
      width="17"
      height="17"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
    >
      <circle cx="12" cy="12" r="3.2" />
      <path
        d="M12 2.8v3M12 18.2v3M2.8 12h3M18.2 12h3M5.5 5.5l2.1 2.1M16.4 16.4l2.1 2.1M18.5 5.5l-2.1 2.1M7.6 16.4l-2.1 2.1"
        strokeLinecap="round"
      />
    </svg>
  ),
  partner: (
    <svg
      aria-hidden="true"
      width="17"
      height="17"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
    >
      <path d="M8 21v-6a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v6" strokeLinecap="round" />
      <path d="M3.5 9.5 12 3l8.5 6.5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M5.5 8v13h13V8" strokeLinecap="round" />
    </svg>
  ),
  users: (
    <svg
      aria-hidden="true"
      width="17"
      height="17"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
    >
      <circle cx="9" cy="8" r="3.2" />
      <path d="M3.5 20c.6-3.2 2.8-5 5.5-5s4.9 1.8 5.5 5" strokeLinecap="round" />
      <circle cx="17" cy="9.5" r="2.4" />
      <path d="M15.7 14.6c2.4.2 4.2 1.7 4.8 4.4" strokeLinecap="round" />
    </svg>
  ),
  search: (
    <svg
      aria-hidden="true"
      width="17"
      height="17"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
    >
      <circle cx="11" cy="11" r="6.5" />
      <path d="M15.8 15.8L20.5 20.5" strokeLinecap="round" />
    </svg>
  ),
  notifications: (
    <svg
      aria-hidden="true"
      width="17"
      height="17"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
    >
      <path d="M6 9.5a6 6 0 0 1 12 0c0 4 1.5 5.5 2 6.5H4c.5-1 2-2.5 2-6.5Z" strokeLinejoin="round" />
      <path d="M10 19.5a2 2 0 0 0 4 0" strokeLinecap="round" />
    </svg>
  ),
  templates: (
    <svg
      aria-hidden="true"
      width="17"
      height="17"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
    >
      <path d="M7 3.5h7.5L19 8v12.5H7z" strokeLinejoin="round" />
      <path d="M14 3.5V8h4.5M9.8 12h4.4M9.8 15.5h4.4" strokeLinecap="round" />
      <path d="M5 6.5v14h9.5" strokeLinecap="round" />
    </svg>
  ),
  tasks: (
    <svg
      aria-hidden="true"
      width="17"
      height="17"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
    >
      <rect x="3.5" y="3.5" width="17" height="17" rx="2" />
      <path d="M8 12.5l2.5 2.5L16 9.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  prompts: (
    <svg
      aria-hidden="true"
      width="17"
      height="17"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
    >
      <path d="M4 6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H9l-4 3.5V6Z" strokeLinejoin="round" />
      <path d="M8.5 8.5h7M8.5 12h4.5" strokeLinecap="round" />
    </svg>
  ),
  support: (
    <svg
      aria-hidden="true"
      width="17"
      height="17"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
    >
      <circle cx="12" cy="12" r="8.5" />
      <circle cx="12" cy="12" r="3.5" />
      <path d="M6 6l3.5 3.5M18 6l-3.5 3.5M18 18l-3.5-3.5M6 18l3.5-3.5" strokeLinecap="round" />
    </svg>
  ),
  outbox: (
    <svg
      aria-hidden="true"
      width="17"
      height="17"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
    >
      <path d="M3.5 6.5h17v11h-17z" strokeLinejoin="round" />
      <path d="m3.5 7 8.5 6 8.5-6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  communications: (
    <svg
      aria-hidden="true"
      width="17"
      height="17"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
    >
      <path d="M4 5.5h16v10.5H9L4.5 20V5.5Z" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M8 9.5h8M8 12.5h5" strokeLinecap="round" />
    </svg>
  ),
  activity: (
    <svg
      aria-hidden="true"
      width="17"
      height="17"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
    >
      <path d="M3.5 12h4l2.5-7 4 14 2.5-7h4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  help: (
    <svg
      aria-hidden="true"
      width="17"
      height="17"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
    >
      <path d="M9.2 9a2.9 2.9 0 0 1 5.6 1c0 1.8-2.3 2.2-2.8 3.5" strokeLinecap="round" />
      <circle cx="12" cy="17.3" r="0.4" fill="currentColor" />
      <circle cx="12" cy="12" r="9.2" />
    </svg>
  ),
  billing: (
    <svg
      aria-hidden="true"
      width="17"
      height="17"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
    >
      <rect x="3" y="5.5" width="18" height="13" rx="2" />
      <path d="M3 9.5h18M6.5 14.5h4" strokeLinecap="round" />
    </svg>
  ),
  features: (
    <svg
      aria-hidden="true"
      width="17"
      height="17"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
    >
      <path
        d="M12 2.5l2.6 5.5 6 .8-4.4 4.2 1.1 6L12 16.9 6.7 19l1.1-6L3.4 8.8l6-.8L12 2.5Z"
        strokeLinejoin="round"
      />
    </svg>
  ),
};

export function AppLayout() {
  const { user, viewMode, logout } = useAuth();
  const navigate = useNavigate();
  const [menuOpen, setMenuOpen] = useState(false);
  const close = () => setMenuOpen(false);
  const unread = useUnreadCount();
  const location = useLocation();
  const menuButtonRef = useRef<HTMLButtonElement>(null);

  /*
   * The mobile drawer covers the viewport, so Escape has to dismiss it — and
   * dismissing it has to hand focus back to the control that opened it, or the
   * next Tab restarts from the top of the document. Both are keyboard-only
   * failures that never show up in a mouse walkthrough.
   */
  useEffect(() => {
    if (!menuOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setMenuOpen(false);
      menuButtonRef.current?.focus();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [menuOpen]);

  // Nav gating follows the effective user so "User view" hides the Operations
  // and Administration sections; the ViewModeToggle keeps using the real user.
  const eff = effectiveUser(user, viewMode);
  // Polled only for readers who have an inbox at all — a client user's badge
  // would be a request per minute for a nav item they never see.
  const inboxUnread = useInboxUnread(isOps(eff) || isPartner(eff));
  // The bucket strip is a worklist, which is an ops idea; a client with three
  // engagements does not need six sub-counts under their own listing.
  const buckets = useBucketCounts(isOps(eff));
  const roleTag = isOps(eff) ? 'Operations' : isPartner(eff) ? 'Partner' : 'Client';

  /*
   * The sidebar and the mobile drawer render the same links, and both are in
   * the DOM at once (the sidebar is `hidden lg:flex`, not unmounted). Two
   * unlabelled `<nav>` landmarks are indistinguishable in a screen reader's
   * landmark list, so each gets its own name.
   */
  const renderNav = (label: string) => (
    // min-h-0 lets this flex child shrink below its content height so
    // overflow-y-auto can take over; without it the nav grows past the fixed
    // sidebar and pushes the user card below the viewport (bottom items hidden).
    <nav
      aria-label={label}
      className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto overscroll-y-contain px-3"
    >
      <ViewModeToggle onNavigate={close} />
      <PaletteTrigger onNavigate={close} />
      <div className="overline mt-3 mb-2 px-3 text-chrome-faint/80">Workspace</div>
      <NavItem to="/dashboard" label="Dashboard" icon={icons.dashboard} onNavigate={close} />
      <NavItem
        to="/valuations"
        label={isOps(eff) ? 'All valuations' : 'Valuations'}
        icon={icons.valuations}
        onNavigate={close}
        badge={buckets?.unread}
        count={buckets?.all}
      />
      {isOps(eff) && <BucketNav counts={buckets} onNavigate={close} />}
      <NavItem to="/valuations/new" label="New valuation" icon={icons.newValuation} onNavigate={close} />
      <NavItem to="/portfolio" label="Portfolio" icon={icons.dashboard} onNavigate={close} />
      {isOps(eff) && (
        <NavItem to="/funds" label="Fund Portfolios" icon={icons.dashboard} onNavigate={close} />
      )}
      {isOps(eff) && (
        <NavItem to="/debt" label="Debt Instruments" icon={icons.dashboard} onNavigate={close} />
      )}
      <NavItem to="/search" label="Search" icon={icons.search} onNavigate={close} />
      <NavItem
        to="/notifications"
        label="Notifications"
        icon={icons.notifications}
        onNavigate={close}
        badge={unread}
      />
      {/* Ops and partner staff both have a cross-engagement inbox; a client's
          conversation lives on their own engagement, so they do not. */}
      {(isOps(eff) || isPartner(eff)) && (
        <NavItem
          to="/inbox"
          label="Inbox"
          icon={icons.communications}
          onNavigate={close}
          badge={inboxUnread}
        />
      )}
      {/* Firm users only: the console scopes itself from the session. Ops belong
          to no firm and reach a named one from the partner console instead. */}
      {isPartner(eff) && <NavItem to="/firm" label="Firm console" icon={icons.partner} onNavigate={close} />}
      {isPartner(eff) && (
        <NavItem to="/partner" label="Partner portal" icon={icons.partner} onNavigate={close} />
      )}
      {isFirmAdmin(eff) && (
        <NavItem to="/settings/branding" label="Branding" icon={icons.settings} onNavigate={close} />
      )}
      {isOps(eff) && (
        <NavGroup label="Operations">
          <NavItem to="/tasks" label="Review tasks" icon={icons.tasks} onNavigate={close} />
          <NavItem to="/engagements" label="Engagement pipeline" icon={icons.tasks} onNavigate={close} />
          <NavItem to="/monitors" label="Monitored valuations" icon={icons.tasks} onNavigate={close} />
          <NavItem to="/templates" label="Report templates" icon={icons.templates} onNavigate={close} />
          <NavItem to="/admin/prompts" label="Bot prompts" icon={icons.prompts} onNavigate={close} />
          <NavItem
            to="/admin/narrative-prompts"
            label="Narrative library"
            icon={icons.prompts}
            onNavigate={close}
          />
          <NavItem
            to="/admin/data-remediation"
            label="Data remediation"
            icon={icons.activity}
            onNavigate={close}
          />
          <NavItem to="/admin/documents" label="Document triage" icon={icons.templates} onNavigate={close} />
          <NavItem to="/admin/support" label="Support inbox" icon={icons.support} onNavigate={close} />
          <NavItem to="/admin/outbox" label="Email outbox" icon={icons.outbox} onNavigate={close} />
          <NavItem to="/admin/jobs" label="Background jobs" icon={icons.tasks} onNavigate={close} />
          <NavItem to="/admin/operations" label="System health" icon={icons.activity} onNavigate={close} />
          <NavItem
            to="/admin/communications"
            label="Communications"
            icon={icons.communications}
            onNavigate={close}
          />
          <NavItem to="/admin/activity" label="Activity log" icon={icons.activity} onNavigate={close} />
          <NavItem to="/admin/help" label="Help articles" icon={icons.help} onNavigate={close} />
          <NavItem to="/admin/blog" label="Blog" icon={icons.templates} onNavigate={close} />
          {/* Read-only for ops; only admins can save. */}
          <NavItem to="/admin/settings" label="System settings" icon={icons.settings} onNavigate={close} />
          <NavItem to="/schema/overwrites" label="Overwrites schema" icon={icons.schema} onNavigate={close} />
        </NavGroup>
      )}
      {canManageUsers(eff) && (
        <NavGroup label="Administration">
          <NavItem to="/admin/users" label="Users & roles" icon={icons.users} onNavigate={close} />
          <NavItem to="/admin/sso" label="Enterprise SSO" icon={icons.settings} onNavigate={close} />
          <NavItem to="/admin/retention" label="Data retention" icon={icons.settings} onNavigate={close} />
          <NavItem to="/admin/partners" label="Partners" icon={icons.partner} onNavigate={close} />
          <NavItem to="/admin/api-tokens" label="API tokens" icon={icons.settings} onNavigate={close} />
        </NavGroup>
      )}
      <div className="overline mt-6 mb-2 px-3 text-chrome-faint/80">Account</div>
      <NavItem to="/billing" label="Billing" icon={icons.billing} onNavigate={close} />
      <NavItem to="/settings" label="Settings" icon={icons.settings} onNavigate={close} />
      <NavItem to="/features" label="Features" icon={icons.features} onNavigate={close} />
      <NavItem to="/help" label="Help Center" icon={icons.help} onNavigate={close} />
    </nav>
  );

  // Pinned below the scrolling nav so the control is reachable without
  // scrolling to the bottom of a long ops sidebar, and visible signed-out too.
  const themeRow = (
    <div className="px-3 pt-3">
      <ThemeToggle variant="chrome" />
    </div>
  );

  const userCard = user && (
    <div className="border-t border-chrome-800 px-4 py-4">
      <div className="flex items-center gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-bond-700 text-xs font-bold text-bond-fg">
          {initials(user)}
        </div>
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold text-chrome-fg">{displayName(user)}</div>
          <div className="truncate text-xs text-chrome-faint">
            {roleTag} · {scopeLabel(eff).split(' (')[0]}
          </div>
        </div>
      </div>
      <button
        onClick={() => {
          logout();
          navigate('/login');
        }}
        className="tap-area mt-3 w-full cursor-pointer rounded-md border border-chrome-700 px-3 py-1.5 text-xs font-semibold text-chrome-dim transition-colors hover:border-chrome-600 hover:text-chrome-fg"
      >
        Sign out
      </button>
    </div>
  );

  return (
    <div className="min-h-screen bg-paper-100 lg:flex">
      <SkipLink />

      {/* Desktop sidebar */}
      <div className="ledger-grid fixed inset-y-0 left-0 z-30 hidden w-64 flex-col bg-chrome-900 lg:flex">
        <div className="px-6 py-6">
          <Wordmark light />
        </div>
        {renderNav('Main')}
        {themeRow}
        {userCard}
      </div>

      {/* Mobile top bar + drawer */}
      <div className="sticky top-0 z-30 flex items-center justify-between bg-chrome-900 px-4 py-3 lg:hidden">
        <Wordmark light />
        <button
          ref={menuButtonRef}
          aria-label="Toggle navigation"
          aria-expanded={menuOpen}
          aria-controls="mobile-nav-drawer"
          onClick={() => setMenuOpen((v) => !v)}
          className="flex items-center justify-center rounded-md p-2 text-chrome-fg touch:min-h-11 touch:min-w-11 hover:bg-chrome-800"
        >
          <svg
            aria-hidden="true"
            width="22"
            height="22"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            {menuOpen ? (
              <path d="M5 5l14 14M19 5L5 19" strokeLinecap="round" />
            ) : (
              <path d="M4 7h16M4 12h16M4 17h16" strokeLinecap="round" />
            )}
          </svg>
        </button>
      </div>
      {menuOpen && (
        <div
          id="mobile-nav-drawer"
          className="ledger-grid fixed inset-x-0 top-[52px] z-20 flex max-h-[calc(100dvh-52px)] flex-col overflow-y-auto overscroll-y-contain bg-chrome-900 pb-2 shadow-lift lg:hidden"
        >
          {renderNav('Mobile')}
          {themeRow}
          {userCard}
        </div>
      )}

      <main
        {...mainContentTargetProps}
        className={`min-w-0 flex-1 lg:ml-64 ${mainContentTargetProps.className}`}
      >
        <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6 lg:px-10">
          {/*
           * The app's only Suspense boundary used to sit above the router, so
           * the first visit to any page — every page is a lazy chunk — tore
           * the whole shell down and put a spinner on an empty screen: sidebar
           * gone, heading gone, scroll position gone, for the length of one
           * chunk fetch. Catching the suspension here instead keeps the
           * furniture on screen and confines the wait to the region that is
           * actually changing. The outer boundary in App.tsx still covers the
           * public pages, which have no shell to preserve.
           *
           * The error boundary was left behind by that move, and had exactly
           * the same problem one step worse: a render throw on any single page
           * replaced the whole workspace with an error card — sidebar,
           * navigation and the sign-out button included — leaving the user
           * nothing to click but "Reload". Catching it here confines the
           * failure to the page that failed, so the rest of the app is still
           * there to navigate away with.
           *
           * The key is what makes navigating away actually work: a boundary
           * that has caught stays caught, so without it the error card would
           * survive the very navigation it is meant to leave room for. Keying
           * on the path remounts it whenever the route changes.
           */}
          <ErrorBoundary
            key={location.pathname}
            label="this page"
            onError={(error, info) => reportCrash('render', error, info.componentStack ?? undefined)}
          >
            <Suspense fallback={<PageSkeleton />}>
              <Outlet />
            </Suspense>
          </ErrorBoundary>
        </div>
      </main>

      <CommandPalette />
      <HelpWidget />
    </div>
  );
}
