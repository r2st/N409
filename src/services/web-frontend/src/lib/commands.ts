import type { User } from './types';
import { canManageUsers, isOps, isPartner } from './rbac';

/**
 * Command registry for the ⌘K palette (feature-improvements §2 "Command
 * palette"). Pure data and pure functions — no React, no browser — so the
 * matcher and the gating are unit-testable and the palette component stays a
 * thin renderer.
 *
 * Two kinds of entry end up in the palette: these static ones, and valuation /
 * user hits streamed in from `/api/v1/search`. The palette merges them.
 */

export type CommandGroup =
  'Workspace' | 'This valuation' | 'Operations' | 'Administration' | 'Account' | 'Actions';

export interface Command {
  /** Stable across renders and used as the recent-items key. */
  id: string;
  label: string;
  group: CommandGroup;
  /** Route to navigate to. Omitted for commands that only run `perform`. */
  to?: string;
  /** Extra words that should match but aren't worth showing (e.g. "409A" → Valuations). */
  keywords?: string;
  /** Right-aligned hint: a shortcut, or what the command will do. */
  hint?: string;
  /** Non-navigation commands (sign out, theme). Runs instead of navigating. */
  perform?: () => void;
}

/** Every workspace tab, with the roles that may see it (mirrors ValuationWorkspace). */
const VALUATION_TABS: { path: string; label: string; access: 'all' | 'ops' | 'ops-or-owner' }[] = [
  { path: '', label: 'Overview', access: 'all' },
  { path: 'progress', label: 'Progress', access: 'all' },
  { path: 'intake', label: 'Intake', access: 'ops-or-owner' },
  { path: 'company', label: 'Company', access: 'ops-or-owner' },
  { path: 'documents', label: 'Documents', access: 'all' },
  { path: 'cap-table', label: 'Cap Table', access: 'ops-or-owner' },
  { path: 'model', label: 'Financial Model', access: 'ops' },
  { path: 'params', label: 'Params', access: 'ops-or-owner' },
  { path: 'workbook', label: 'Workbook', access: 'ops' },
  { path: 'overwrites', label: 'Overwrites', access: 'ops' },
  { path: 'ai', label: 'AI', access: 'ops' },
  { path: 'engagement', label: 'Engagement', access: 'ops' },
  { path: 'tasks', label: 'Tasks', access: 'ops' },
  { path: 'calculations', label: 'Calculations', access: 'ops' },
  { path: 'qa', label: 'QA', access: 'ops' },
  { path: 'health', label: 'Health', access: 'ops' },
  { path: 'decisions', label: 'Decisions', access: 'ops' },
  { path: 'scenarios', label: 'What-If Scenarios', access: 'all' },
  { path: 'sensitivity', label: 'Sensitivity', access: 'ops' },
  { path: 'bridge', label: 'Value Bridge', access: 'ops' },
  { path: 'analytics', label: 'Analytics', access: 'ops' },
  { path: 'report', label: 'Report', access: 'all' },
  { path: 'grants', label: 'Grants', access: 'ops-or-owner' },
  { path: 'asc718', label: 'ASC 718', access: 'ops' },
  { path: 'monitoring', label: 'Monitoring', access: 'ops' },
  { path: 'package', label: 'Package', access: 'ops' },
  { path: 'audit-trail', label: 'Change History', access: 'all' },
];

/**
 * The valuation id in the current path, if the user is standing in a
 * workspace. Drives the "This valuation" group, which is what makes the
 * palette a jump *within* a valuation and not just a page switcher.
 */
export function valuationIdFromPath(pathname: string): string | null {
  const match = /^\/valuations\/([0-9a-zA-Z-]{6,})(\/|$)/.exec(pathname);
  const id = match?.[1];
  // '/valuations/new' is a page, not a valuation.
  return id && id !== 'new' ? id : null;
}

export function buildCommands(options: {
  user: Pick<User, 'roles' | 'id'> | null;
  /** Effective user — respects the admin's "User view" preview. */
  effective: Pick<User, 'roles' | 'id'> | null;
  pathname: string;
  actions: { signOut: () => void; toggleTheme: () => void };
}): Command[] {
  const { effective, pathname, actions } = options;
  const ops = isOps(effective);
  const partner = isPartner(effective);
  const admin = canManageUsers(effective);
  const commands: Command[] = [];

  const add = (c: Command) => commands.push(c);

  add({
    id: 'nav:dashboard',
    label: 'Dashboard',
    group: 'Workspace',
    to: '/dashboard',
    keywords: 'home overview',
  });
  add({
    id: 'nav:valuations',
    label: ops ? 'All valuations' : 'Valuations',
    group: 'Workspace',
    to: '/valuations',
    keywords: '409a worklist list',
  });
  add({
    id: 'nav:new-valuation',
    label: 'New valuation',
    group: 'Workspace',
    to: '/valuations/new',
    keywords: 'create start order',
  });
  add({
    id: 'nav:compare',
    label: 'Compare valuations',
    group: 'Workspace',
    to: '/valuations/compare',
    keywords: 'diff side by side versus changed delta',
  });
  add({ id: 'nav:portfolio', label: 'Portfolio', group: 'Workspace', to: '/portfolio' });
  add({ id: 'nav:search', label: 'Search', group: 'Workspace', to: '/search', keywords: 'find' });
  add({
    id: 'nav:notifications',
    label: 'Notifications',
    group: 'Workspace',
    to: '/notifications',
    keywords: 'alerts inbox',
  });
  if (ops) {
    add({ id: 'nav:funds', label: 'Fund portfolios', group: 'Workspace', to: '/funds' });
    add({
      id: 'nav:debt',
      label: 'Debt instruments',
      group: 'Workspace',
      to: '/debt',
      keywords: 'safe convertible note',
    });
  }
  if (partner) add({ id: 'nav:partner', label: 'Partner portal', group: 'Workspace', to: '/partner' });

  // Tabs of the valuation currently open, so ⌘K is a jump *inside* the file.
  const valuationId = valuationIdFromPath(pathname);
  if (valuationId) {
    // The palette cannot know the owner without the aggregate, so it offers the
    // tabs a non-ops user is allowed to *try*; the API and the tab bar remain
    // the real gate. Ops-only tabs stay hidden for non-ops.
    for (const tab of VALUATION_TABS) {
      if (tab.access === 'ops' && !ops) continue;
      add({
        id: `tab:${tab.path}`,
        label: tab.label,
        group: 'This valuation',
        to: tab.path ? `/valuations/${valuationId}/${tab.path}` : `/valuations/${valuationId}`,
        keywords: 'tab',
      });
    }
  }

  if (ops) {
    add({ id: 'nav:tasks', label: 'Review tasks', group: 'Operations', to: '/tasks' });
    add({ id: 'nav:engagements', label: 'Engagement pipeline', group: 'Operations', to: '/engagements' });
    add({ id: 'nav:monitors', label: 'Monitored valuations', group: 'Operations', to: '/monitors' });
    add({ id: 'nav:templates', label: 'Report templates', group: 'Operations', to: '/templates' });
    add({
      id: 'nav:prompts',
      label: 'Bot prompts',
      group: 'Operations',
      to: '/admin/prompts',
      keywords: 'ai',
    });
    add({ id: 'nav:support', label: 'Support inbox', group: 'Operations', to: '/admin/support' });
    add({ id: 'nav:outbox', label: 'Email outbox', group: 'Operations', to: '/admin/outbox' });
    add({
      id: 'nav:communications',
      label: 'Communications',
      group: 'Operations',
      to: '/admin/communications',
    });
    add({
      id: 'nav:activity',
      label: 'Activity log',
      group: 'Operations',
      to: '/admin/activity',
      keywords: 'audit events',
    });
    add({ id: 'nav:admin-help', label: 'Help articles', group: 'Operations', to: '/admin/help' });
    add({ id: 'nav:settings-system', label: 'System settings', group: 'Operations', to: '/admin/settings' });
    add({ id: 'nav:schema', label: 'Overwrites schema', group: 'Operations', to: '/schema/overwrites' });
  }

  if (admin) {
    add({ id: 'nav:users', label: 'Users & roles', group: 'Administration', to: '/admin/users' });
    add({
      id: 'nav:sso',
      label: 'Enterprise SSO',
      group: 'Administration',
      to: '/admin/sso',
      keywords: 'saml scim',
    });
    add({ id: 'nav:retention', label: 'Data retention', group: 'Administration', to: '/admin/retention' });
    add({
      id: 'nav:partners',
      label: 'Partners',
      group: 'Administration',
      to: '/admin/partners',
      keywords: 'white label',
    });
  }

  add({
    id: 'nav:billing',
    label: 'Billing',
    group: 'Account',
    to: '/billing',
    keywords: 'invoice payment subscription',
  });
  add({
    id: 'nav:settings',
    label: 'Settings',
    group: 'Account',
    to: '/settings',
    keywords: 'profile password mfa theme',
  });
  add({ id: 'nav:features', label: 'Features', group: 'Account', to: '/features' });
  add({
    id: 'nav:help',
    label: 'Help Center',
    group: 'Account',
    to: '/help',
    keywords: 'docs support article',
  });

  add({
    id: 'action:theme',
    label: 'Switch colour theme',
    group: 'Actions',
    keywords: 'dark light mode appearance',
    hint: 'Light → Dark → System',
    perform: actions.toggleTheme,
  });
  add({
    id: 'action:sign-out',
    label: 'Sign out',
    group: 'Actions',
    keywords: 'logout leave',
    perform: actions.signOut,
  });

  return commands;
}

/**
 * Subsequence match with a small positional score. Not a full fuzzy ranker:
 * the corpus is ~60 short labels, so what matters is that "wb" finds Workbook
 * and that a prefix hit outranks a scattered one.
 *
 * Returns null when the query does not match at all, otherwise a score where
 * higher is better.
 */
export function scoreCommand(query: string, label: string, keywords = ''): number | null {
  const q = query.trim().toLowerCase();
  if (!q) return 0;
  const haystack = `${label} ${keywords}`.toLowerCase();
  const target = label.toLowerCase();

  // Whole-substring hits are the common case and should dominate.
  const direct = target.indexOf(q);
  if (direct === 0) return 1000;
  if (direct > 0) return 800 - direct;
  if (haystack.includes(q)) return 600;

  // Initials: "vb" → "Value Bridge".
  const initials = target
    .split(/[\s-]+/)
    .map((w) => w[0] ?? '')
    .join('');
  if (initials.startsWith(q)) return 700;

  // Scattered subsequence, penalised by how far apart the letters land.
  let cursor = 0;
  let gaps = 0;
  for (const ch of q) {
    const found = haystack.indexOf(ch, cursor);
    if (found < 0) return null;
    gaps += found - cursor;
    cursor = found + 1;
  }
  return Math.max(1, 400 - gaps);
}

/** Filters and ranks, keeping recently-used commands ahead of ties. */
export function rankCommands(commands: Command[], query: string, recentIds: string[]): Command[] {
  const scored: { command: Command; score: number }[] = [];
  for (const command of commands) {
    const score = scoreCommand(query, command.label, command.keywords);
    if (score === null) continue;
    const recentIndex = recentIds.indexOf(command.id);
    const recency = recentIndex < 0 ? 0 : (recentIds.length - recentIndex) * 12;
    scored.push({ command, score: score + recency });
  }
  // Stable: equal scores keep registry order, which is already the sidebar's.
  return scored
    .map((s, i) => ({ ...s, i }))
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .map((s) => s.command);
}

const RECENT_KEY = 'n409.palette.recent';
const RECENT_LIMIT = 8;

export function readRecent(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]') as unknown;
    return Array.isArray(raw)
      ? raw.filter((v): v is string => typeof v === 'string').slice(0, RECENT_LIMIT)
      : [];
  } catch {
    return [];
  }
}

export function pushRecent(id: string): string[] {
  const next = [id, ...readRecent().filter((v) => v !== id)].slice(0, RECENT_LIMIT);
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    // Recents are a convenience; losing them is not worth failing the jump.
  }
  return next;
}
