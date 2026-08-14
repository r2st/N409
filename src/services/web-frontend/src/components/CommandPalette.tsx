import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useLocation, useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { effectiveUser, isOps } from '../lib/rbac';
import { displayName } from '../lib/format';
import { getThemeChoice, setThemeChoice } from '../lib/theme';
import { buildCommands, pushRecent, rankCommands, readRecent } from '../lib/commands';
import type { Command } from '../lib/commands';
import type { SearchResults } from '../lib/types';
import { KindBadge, StateBadge, useFocusTrap } from './ui';

/**
 * ⌘K command palette (feature-improvements §2, ranked #7).
 *
 * Two sources merged into one list: the static command registry
 * (lib/commands.ts) and live hits from `/api/v1/search`, which is already
 * scope-filtered server-side. Remote results are appended rather than
 * interleaved so the fast local list never reorders under the cursor while a
 * request is in flight.
 */

/** Rows the list can render — a registry command or a search hit. */
type Row =
  | { kind: 'command'; command: Command }
  | { kind: 'valuation'; hit: SearchResults['valuations'][number] }
  | { kind: 'user'; hit: SearchResults['users'][number] };

const MAX_LOCAL_ROWS = 8;

function rowKey(row: Row): string {
  if (row.kind === 'command') return `c:${row.command.id}`;
  return `${row.kind}:${row.hit.id}`;
}

function groupOf(row: Row): string {
  if (row.kind === 'command') return row.command.group;
  return row.kind === 'valuation' ? 'Valuations' : 'People';
}

/**
 * Sidebar affordance. The palette is opened by a global key handler, so this
 * dispatches the same synthetic ⌘K rather than owning the open state — a
 * palette nobody knows about is a palette nobody uses, but there is no reason
 * for two sources of truth.
 */
export function PaletteTrigger({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <div className="px-3 pt-3">
      <button
        type="button"
        onClick={() => {
          onNavigate?.();
          window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true }));
        }}
        className="flex w-full cursor-pointer items-center gap-2.5 rounded-md border border-chrome-700 bg-chrome-800/40 px-3 py-2 text-left text-xs font-semibold text-chrome-dim transition-colors hover:border-chrome-600 hover:text-chrome-fg"
      >
        <span aria-hidden>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
            <circle cx="11" cy="11" r="6.5" />
            <path d="M15.8 15.8L20.5 20.5" strokeLinecap="round" />
          </svg>
        </span>
        <span className="flex-1">Jump to…</span>
        <kbd className="rounded border border-chrome-600 px-1.5 py-0.5 text-[0.6rem] text-chrome-faint">
          ⌘K
        </kbd>
      </button>
    </div>
  );
}

export function CommandPalette() {
  const { user, viewMode, logout } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  const [recent, setRecent] = useState<string[]>([]);
  const [remote, setRemote] = useState<SearchResults | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchFailed, setSearchFailed] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const close = useCallback(() => setOpen(false), []);
  const dialogRef = useFocusTrap<HTMLDivElement>(open, close);

  // ⌘K / Ctrl-K anywhere, and "/" when the user isn't already typing.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const key = event.key.toLowerCase();
      const inField =
        event.target instanceof HTMLElement &&
        (/^(input|textarea|select)$/i.test(event.target.tagName) || event.target.isContentEditable);
      if (key === 'k' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        setOpen((v) => !v);
      } else if (key === '/' && !inField && !event.metaKey && !event.ctrlKey && !event.altKey) {
        event.preventDefault();
        setOpen(true);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  // A fresh open starts from a clean query, cursor and recents snapshot.
  useEffect(() => {
    if (!open) return;
    setQuery('');
    setCursor(0);
    setRemote(null);
    setRecent(readRecent());
  }, [open]);

  const commands = useMemo(
    () =>
      buildCommands({
        user,
        effective: effectiveUser(user, viewMode),
        pathname: location.pathname,
        actions: {
          signOut: () => {
            logout();
            navigate('/login');
          },
          toggleTheme: () => {
            const choice = getThemeChoice();
            setThemeChoice(choice === 'light' ? 'dark' : choice === 'dark' ? 'system' : 'light');
          },
        },
      }),
    [user, viewMode, location.pathname, logout, navigate],
  );

  // Remote search only earns its round-trip once the query could plausibly be
  // a company name; below two characters the local list is the whole answer.
  useEffect(() => {
    if (!open) return;
    const q = query.trim();
    if (q.length < 2) {
      setRemote(null);
      setSearchFailed(false);
      setSearching(false);
      return;
    }
    setSearching(true);
    let cancelled = false;
    const timer = setTimeout(() => {
      api<SearchResults>(`/search?q=${encodeURIComponent(q)}&limit=6`)
        .then((r) => {
          if (!cancelled) {
            setRemote(r);
            setSearchFailed(false);
          }
        })
        /*
         * Discarding the failure left the palette saying "Nothing matches
         * “Acme”" — a statement about the account, on the strength of a search
         * that never came back. The palette is how people find a valuation
         * they cannot see in the list, so that answer sends them looking for
         * an engagement they were told does not exist. The local commands are
         * still matched and still shown; only the server half is missing, and
         * it now says so.
         */
        .catch(() => {
          if (!cancelled) {
            setRemote(null);
            setSearchFailed(true);
          }
        })
        .finally(() => {
          if (!cancelled) setSearching(false);
        });
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query, open]);

  const rows = useMemo<Row[]>(() => {
    const q = query.trim();
    // With no query this is a recents-first shortlist, not a wall of 60 rows.
    const ranked = rankCommands(commands, q, recent).slice(0, MAX_LOCAL_ROWS);
    const out: Row[] = ranked.map((command) => ({ kind: 'command', command }));
    for (const hit of remote?.valuations ?? []) out.push({ kind: 'valuation', hit });
    for (const hit of remote?.users ?? []) out.push({ kind: 'user', hit });
    return out;
  }, [commands, query, recent, remote]);

  // Keep the cursor inside the list as results shrink under a longer query.
  useEffect(() => {
    setCursor((c) => (rows.length === 0 ? 0 : Math.min(c, rows.length - 1)));
  }, [rows.length]);

  useEffect(() => {
    const active = listRef.current?.querySelector('[data-active="true"]');
    // Guarded: jsdom has no scrollIntoView, and keeping the cursor visible is
    // never worth throwing out of a passive effect.
    if (active instanceof HTMLElement && typeof active.scrollIntoView === 'function') {
      active.scrollIntoView({ block: 'nearest' });
    }
  }, [cursor, rows.length]);

  const run = useCallback(
    (row: Row) => {
      if (row.kind === 'command') {
        setRecent(pushRecent(row.command.id));
        if (row.command.perform) {
          row.command.perform();
          // Theme is a toggle the user may want to hit twice; sign-out
          // navigates away and closing an unmounted palette is harmless.
          if (row.command.id !== 'action:theme') close();
          return;
        }
        if (row.command.to) navigate(row.command.to);
      } else if (row.kind === 'valuation') {
        navigate(`/valuations/${row.hit.id}`);
      } else {
        navigate(`/admin/users?q=${encodeURIComponent(row.hit.email)}`);
      }
      close();
    },
    [navigate, close],
  );

  if (!open) return null;

  const onInputKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setCursor((c) => (rows.length ? (c + 1) % rows.length : 0));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setCursor((c) => (rows.length ? (c - 1 + rows.length) % rows.length : 0));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const row = rows[cursor];
      if (row) run(row);
    }
  };

  let lastGroup = '';

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-chrome-950/60 p-4 pt-[12vh]"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        className="w-full max-w-xl overflow-hidden rounded-xl border border-paper-300 bg-surface shadow-lift focus:outline-none"
      >
        <div className="flex items-center gap-3 border-b border-paper-200 px-4">
          <span className="text-ink-300" aria-hidden>
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
            >
              <circle cx="11" cy="11" r="6.5" />
              <path d="M15.8 15.8L20.5 20.5" strokeLinecap="round" />
            </svg>
          </span>
          <input
            ref={inputRef}
            autoFocus
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setCursor(0);
            }}
            onKeyDown={onInputKeyDown}
            placeholder={
              isOps(user) ? 'Jump to a page, valuation or person…' : 'Jump to a page or valuation…'
            }
            aria-label="Search commands"
            aria-controls="command-palette-list"
            aria-activedescendant={rows[cursor] ? `cmd-${rowKey(rows[cursor]!)}` : undefined}
            className="w-full bg-transparent py-4 text-sm text-ink-900 placeholder:text-ink-400 focus:outline-none"
          />
          {searching && (
            <span className="text-[0.65rem] font-semibold text-ink-400" role="status">
              Searching…
            </span>
          )}
          <kbd className="rounded border border-paper-300 px-1.5 py-0.5 text-[0.65rem] font-semibold text-ink-400">
            Esc
          </kbd>
        </div>

        <div
          id="command-palette-list"
          ref={listRef}
          role="listbox"
          className="max-h-[52vh] overflow-y-auto py-2"
        >
          {searchFailed && (
            <p role="status" className="px-4 py-3 text-center text-sm text-red-700">
              Search is unavailable — only pages are listed. Try again in a moment.
            </p>
          )}
          {rows.length === 0 && !searchFailed && (
            <p className="px-4 py-6 text-center text-sm text-ink-400">Nothing matches “{query}”.</p>
          )}
          {rows.length === 0 && searchFailed && (
            <p className="px-4 pb-6 text-center text-sm text-ink-400">No page matches “{query}”.</p>
          )}
          {rows.map((row, index) => {
            const group = groupOf(row);
            const heading = group === lastGroup ? null : group;
            lastGroup = group;
            const active = index === cursor;
            return (
              <div key={rowKey(row)}>
                {heading && <div className="overline px-4 pt-3 pb-1 text-ink-400">{heading}</div>}
                <button
                  type="button"
                  id={`cmd-${rowKey(row)}`}
                  role="option"
                  aria-selected={active}
                  data-active={active}
                  onMouseMove={() => setCursor(index)}
                  onClick={() => run(row)}
                  className={`flex w-full cursor-pointer items-center gap-3 px-4 py-2 text-left text-sm ${
                    active ? 'bg-bond-50 text-ink-900' : 'text-ink-700'
                  }`}
                >
                  {row.kind === 'command' && (
                    <>
                      <span className="flex-1 font-medium">{row.command.label}</span>
                      {row.command.hint && <span className="text-xs text-ink-400">{row.command.hint}</span>}
                    </>
                  )}
                  {row.kind === 'valuation' && (
                    <>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-medium">{row.hit.company_name}</span>
                        <span className="tnum block truncate text-xs text-ink-400">
                          {row.hit.number}
                          {row.hit.service_name ? ` · ${row.hit.service_name}` : ''}
                        </span>
                      </span>
                      <KindBadge kind={row.hit.kind} />
                      <StateBadge state={row.hit.state} />
                    </>
                  )}
                  {row.kind === 'user' && (
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium">{displayName(row.hit)}</span>
                      <span className="block truncate text-xs text-ink-400">{row.hit.email}</span>
                    </span>
                  )}
                </button>
              </div>
            );
          })}
        </div>

        <div className="flex items-center gap-4 border-t border-paper-200 px-4 py-2 text-[0.65rem] text-ink-400">
          <span>↑↓ navigate</span>
          <span>↵ open</span>
          <span className="ml-auto">⌘K or / to reopen</span>
        </div>
      </div>
    </div>,
    document.body,
  );
}
