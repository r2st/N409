import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { canManageUsers, isOps, isPartner, scopeLabel } from '../lib/rbac';
import { displayName, initials } from '../lib/format';
import { Wordmark } from './Logo';
import { HelpWidget } from './HelpWidget';

function NavItem({
  to,
  label,
  icon,
  onNavigate,
  badge,
}: {
  to: string;
  label: string;
  icon: ReactNode;
  onNavigate: () => void;
  badge?: number;
}) {
  return (
    <NavLink
      to={to}
      end={to === '/dashboard'}
      onClick={onNavigate}
      className={({ isActive }) =>
        `group flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors ${
          isActive
            ? 'bg-ink-800 text-paper-50 shadow-[inset_2px_0_0_var(--color-brass-400)]'
            : 'text-ink-300 hover:bg-ink-800/60 hover:text-paper-50'
        }`
      }
    >
      <span className="text-ink-400 group-hover:text-brass-300">{icon}</span>
      {label}
      {badge !== undefined && badge > 0 && (
        <span className="tnum ml-auto rounded-full bg-brass-400 px-1.5 py-0.5 text-[0.65rem] font-bold text-ink-900">
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
        className="overline mt-6 mb-2 flex w-full cursor-pointer items-center justify-between px-3 text-left text-ink-400/80 hover:text-ink-300"
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

/** Polls the unread notification count (M4) — on route change and every 60s. */
function useUnreadCount(): number {
  const [count, setCount] = useState(0);
  const location = useLocation();
  useEffect(() => {
    let cancelled = false;
    const poll = () => {
      api<{ unread_count: number }>('/notifications/unread-count')
        .then((d) => {
          if (!cancelled) setCount(d.unread_count);
        })
        .catch(() => {});
    };
    poll();
    const timer = setInterval(poll, 60_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [location.pathname]);
  return count;
}

const icons = {
  dashboard: (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <rect x="3" y="3" width="8" height="8" rx="1.5" />
      <rect x="13" y="3" width="8" height="5" rx="1.5" />
      <rect x="13" y="10" width="8" height="11" rx="1.5" />
      <rect x="3" y="13" width="8" height="8" rx="1.5" />
    </svg>
  ),
  valuations: (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M4 20V10m5.5 10V4m5.5 16v-7M20.5 20V8" strokeLinecap="round" />
    </svg>
  ),
  newValuation: (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 8.5v7M8.5 12h7" strokeLinecap="round" />
    </svg>
  ),
  schema: (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M4 19.5V6a2 2 0 0 1 2-2h13.5v13.5H6a2 2 0 0 0-2 2Zm0 0A2 2 0 0 0 6 21.5h13.5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M8.5 8.5h7M8.5 12h5" strokeLinecap="round" />
    </svg>
  ),
  settings: (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <circle cx="12" cy="12" r="3.2" />
      <path d="M12 2.8v3M12 18.2v3M2.8 12h3M18.2 12h3M5.5 5.5l2.1 2.1M16.4 16.4l2.1 2.1M18.5 5.5l-2.1 2.1M7.6 16.4l-2.1 2.1" strokeLinecap="round" />
    </svg>
  ),
  partner: (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M8 21v-6a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v6" strokeLinecap="round" />
      <path d="M3.5 9.5 12 3l8.5 6.5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M5.5 8v13h13V8" strokeLinecap="round" />
    </svg>
  ),
  users: (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <circle cx="9" cy="8" r="3.2" />
      <path d="M3.5 20c.6-3.2 2.8-5 5.5-5s4.9 1.8 5.5 5" strokeLinecap="round" />
      <circle cx="17" cy="9.5" r="2.4" />
      <path d="M15.7 14.6c2.4.2 4.2 1.7 4.8 4.4" strokeLinecap="round" />
    </svg>
  ),
  search: (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <circle cx="11" cy="11" r="6.5" />
      <path d="M15.8 15.8L20.5 20.5" strokeLinecap="round" />
    </svg>
  ),
  notifications: (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M6 9.5a6 6 0 0 1 12 0c0 4 1.5 5.5 2 6.5H4c.5-1 2-2.5 2-6.5Z" strokeLinejoin="round" />
      <path d="M10 19.5a2 2 0 0 0 4 0" strokeLinecap="round" />
    </svg>
  ),
  templates: (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M7 3.5h7.5L19 8v12.5H7z" strokeLinejoin="round" />
      <path d="M14 3.5V8h4.5M9.8 12h4.4M9.8 15.5h4.4" strokeLinecap="round" />
      <path d="M5 6.5v14h9.5" strokeLinecap="round" />
    </svg>
  ),
  tasks: (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <rect x="3.5" y="3.5" width="17" height="17" rx="2" />
      <path d="M8 12.5l2.5 2.5L16 9.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  prompts: (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M4 6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H9l-4 3.5V6Z" strokeLinejoin="round" />
      <path d="M8.5 8.5h7M8.5 12h4.5" strokeLinecap="round" />
    </svg>
  ),
  support: (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <circle cx="12" cy="12" r="8.5" />
      <circle cx="12" cy="12" r="3.5" />
      <path d="M6 6l3.5 3.5M18 6l-3.5 3.5M18 18l-3.5-3.5M6 18l3.5-3.5" strokeLinecap="round" />
    </svg>
  ),
  outbox: (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M3.5 6.5h17v11h-17z" strokeLinejoin="round" />
      <path d="m3.5 7 8.5 6 8.5-6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  communications: (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M4 5.5h16v10.5H9L4.5 20V5.5Z" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M8 9.5h8M8 12.5h5" strokeLinecap="round" />
    </svg>
  ),
  activity: (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M3.5 12h4l2.5-7 4 14 2.5-7h4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  help: (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M9.2 9a2.9 2.9 0 0 1 5.6 1c0 1.8-2.3 2.2-2.8 3.5" strokeLinecap="round" />
      <circle cx="12" cy="17.3" r="0.4" fill="currentColor" />
      <circle cx="12" cy="12" r="9.2" />
    </svg>
  ),
  billing: (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <rect x="3" y="5.5" width="18" height="13" rx="2" />
      <path d="M3 9.5h18M6.5 14.5h4" strokeLinecap="round" />
    </svg>
  ),
};

export function AppLayout() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const [menuOpen, setMenuOpen] = useState(false);
  const close = () => setMenuOpen(false);
  const unread = useUnreadCount();

  const roleTag = isOps(user) ? 'Operations' : isPartner(user) ? 'Partner' : 'Client';

  const nav = (
    <nav className="flex flex-1 flex-col gap-1 px-3">
      <div className="overline mt-1 mb-2 px-3 text-ink-400/80">Workspace</div>
      <NavItem to="/dashboard" label="Dashboard" icon={icons.dashboard} onNavigate={close} />
      <NavItem
        to="/valuations"
        label={isOps(user) ? 'All valuations' : 'Valuations'}
        icon={icons.valuations}
        onNavigate={close}
      />
      <NavItem to="/valuations/new" label="New valuation" icon={icons.newValuation} onNavigate={close} />
      <NavItem to="/search" label="Search" icon={icons.search} onNavigate={close} />
      <NavItem
        to="/notifications"
        label="Notifications"
        icon={icons.notifications}
        onNavigate={close}
        badge={unread}
      />
      {isPartner(user) && (
        <NavItem to="/partner" label="Partner portal" icon={icons.partner} onNavigate={close} />
      )}
      {isOps(user) && (
        <NavGroup label="Operations">
          <NavItem to="/tasks" label="Review tasks" icon={icons.tasks} onNavigate={close} />
          <NavItem to="/templates" label="Report templates" icon={icons.templates} onNavigate={close} />
          <NavItem to="/admin/prompts" label="Bot prompts" icon={icons.prompts} onNavigate={close} />
          <NavItem to="/admin/support" label="Support inbox" icon={icons.support} onNavigate={close} />
          <NavItem to="/admin/outbox" label="Email outbox" icon={icons.outbox} onNavigate={close} />
          <NavItem
            to="/admin/communications"
            label="Communications"
            icon={icons.communications}
            onNavigate={close}
          />
          <NavItem to="/admin/activity" label="Activity log" icon={icons.activity} onNavigate={close} />
          <NavItem to="/admin/help" label="Help articles" icon={icons.help} onNavigate={close} />
          <NavItem to="/schema/overwrites" label="Overwrites schema" icon={icons.schema} onNavigate={close} />
        </NavGroup>
      )}
      {canManageUsers(user) && (
        <NavGroup label="Administration">
          <NavItem to="/admin/users" label="Users & roles" icon={icons.users} onNavigate={close} />
          <NavItem to="/admin/partners" label="Partners" icon={icons.partner} onNavigate={close} />
        </NavGroup>
      )}
      <div className="overline mt-6 mb-2 px-3 text-ink-400/80">Account</div>
      <NavItem to="/billing" label="Billing" icon={icons.billing} onNavigate={close} />
      <NavItem to="/settings" label="Settings" icon={icons.settings} onNavigate={close} />
    </nav>
  );

  const userCard = user && (
    <div className="border-t border-ink-800 px-4 py-4">
      <div className="flex items-center gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-bond-700 text-xs font-bold text-paper-50">
          {initials(user)}
        </div>
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold text-paper-50">{displayName(user)}</div>
          <div className="truncate text-xs text-ink-400">
            {roleTag} · {scopeLabel(user).split(' (')[0]}
          </div>
        </div>
      </div>
      <button
        onClick={() => {
          logout();
          navigate('/login');
        }}
        className="mt-3 w-full cursor-pointer rounded-md border border-ink-700 px-3 py-1.5 text-xs font-semibold text-ink-300 transition-colors hover:border-ink-600 hover:text-paper-50"
      >
        Sign out
      </button>
    </div>
  );

  return (
    <div className="min-h-screen bg-paper-100 lg:flex">
      {/* Desktop sidebar */}
      <aside className="ledger-grid fixed inset-y-0 left-0 z-30 hidden w-64 flex-col bg-ink-900 lg:flex">
        <div className="px-6 py-6">
          <Wordmark light />
        </div>
        {nav}
        {userCard}
      </aside>

      {/* Mobile top bar + drawer */}
      <div className="sticky top-0 z-30 flex items-center justify-between bg-ink-900 px-4 py-3 lg:hidden">
        <Wordmark light />
        <button
          aria-label="Toggle navigation"
          onClick={() => setMenuOpen((v) => !v)}
          className="rounded-md p-2 text-paper-50 hover:bg-ink-800"
        >
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            {menuOpen ? (
              <path d="M5 5l14 14M19 5L5 19" strokeLinecap="round" />
            ) : (
              <path d="M4 7h16M4 12h16M4 17h16" strokeLinecap="round" />
            )}
          </svg>
        </button>
      </div>
      {menuOpen && (
        <div className="ledger-grid fixed inset-x-0 top-[52px] z-20 flex max-h-[calc(100dvh-52px)] flex-col overflow-y-auto bg-ink-900 pb-2 shadow-lift lg:hidden">
          {nav}
          {userCard}
        </div>
      )}

      <main className="min-w-0 flex-1 lg:ml-64">
        <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6 lg:px-10">
          <Outlet />
        </div>
      </main>

      <HelpWidget />
    </div>
  );
}
