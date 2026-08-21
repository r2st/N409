import { useCallback, useSyncExternalStore } from 'react';

/**
 * One optimistic-lock version, shared by every panel that writes the same row.
 *
 * `valuation_params` is one row holding three separately-edited documents — the
 * methodology (ParamsPanel), the financial model (FinancialModelPanel, and the
 * scenario block inside ParamsPanel) and the discount-rate build-up
 * (WaccPanel) — and migration 0158 gives the row a single `version` that *every*
 * writer moves. That is deliberate: a panel holding version 4 has to be able to
 * tell that somebody else's save landed, whichever part of the row it touched.
 *
 * It also means a panel is made stale by its own neighbours. ParamsPanel and
 * WaccPanel render on the same tab; saving the build-up bumps the version, and
 * a panel that kept its own copy would then refuse the methodology save beside
 * it — a conflict against a change the same analyst had just made, on a save
 * that could not have reverted anything, and one whose recovery is to reload
 * and discard forty fields of unsaved work. A guard that fires on the writes it
 * was built to allow is worse than no guard: it teaches people to distrust it.
 *
 * So the version lives with the row rather than with the panel. Each panel
 * reports the version it observes — on load, and from whatever a write returns
 * — and reads back whatever any of them last saw. A save by a *genuine* third
 * party is still invisible to all of them and still conflicts, which is the
 * case the guard exists for.
 *
 * Not a React context, because the panels are siblings assembled by a tab
 * component that has no business knowing this exists, and because the identity
 * that matters is the row's, not the tree's.
 */

const versions = new Map<string, number | undefined>();
const listeners = new Map<string, Set<() => void>>();

/** Key for the row a panel writes. Include the id — this is a per-row fact. */
export const paramsVersionKey = (valuationId: string): string => `valuation_params:${valuationId}`;

function subscribe(key: string, onChange: () => void): () => void {
  let set = listeners.get(key);
  if (!set) {
    set = new Set();
    listeners.set(key, set);
  }
  set.add(onChange);
  return () => {
    // Re-read rather than closing over `set`. If this key's entry has already
    // been dropped and remade — a cleanup and a re-subscribe, which is exactly
    // what React does on a StrictMode remount — the captured Set is nobody's
    // any more, and finding it empty would delete the *live* entry that
    // replaced it along with the version somebody is currently holding.
    const live = listeners.get(key);
    if (!live) return;
    live.delete(onChange);
    // Drop the entry with its last reader. The key is a valuation id, so a long
    // session that visits many engagements would otherwise accumulate one entry
    // per visit — small, but unbounded, and nothing would ever read them again.
    if (live.size === 0) {
      listeners.delete(key);
      versions.delete(key);
    }
  };
}

/**
 * The current version for `key`, and a setter every writer calls with what its
 * response reported.
 *
 * `undefined` is a real value and means "no opinion": before the first load, or
 * against a server that does not report the version. `ifMatch` sends nothing
 * for it, so the write falls back to last-write-wins rather than failing.
 */
export function useRowVersion(key: string): [number | undefined, (version: number | undefined) => void] {
  const version = useSyncExternalStore(
    useCallback((onChange: () => void) => subscribe(key, onChange), [key]),
    useCallback(() => versions.get(key), [key]),
  );
  const set = useCallback(
    (next: number | undefined) => {
      const current = versions.get(key);
      if (current === next && versions.has(key)) return;
      // A row's version only ever goes up, so a *lower* number is not news — it
      // is a reply that was already stale when it arrived. Panels reload after
      // they save, and a read issued before somebody else's write can land
      // after it: without this, WaccPanel's post-save reload could hand the
      // methodology form the version it held two writes ago, and the next save
      // would be refused for a change nobody made since. Clearing to
      // `undefined` stays allowed — that is "no opinion", not an older one.
      if (typeof current === 'number' && typeof next === 'number' && next < current) return;
      versions.set(key, next);
      for (const listener of listeners.get(key) ?? []) listener();
    },
    [key],
  );
  return [version, set];
}

/** Test seam — drops every tracked version. */
export function resetRowVersions(): void {
  versions.clear();
  listeners.clear();
}
