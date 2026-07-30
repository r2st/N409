import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';
import { isOps } from '../lib/rbac';
import type { SavedView } from '../lib/types';
import { Button, Modal, Select, TextInput } from './ui';

/**
 * Saved worklist views (feature-improvements §2, ranked #8).
 *
 * The list already keeps its whole state in the URL, so a view is just that
 * query string under a name. Applying one is a navigation; saving one is a
 * snapshot of what is on screen. Nothing here re-implements the filters, which
 * is why the picker keeps working as the list gains new ones.
 */

/** Keys the server keeps in a view — mirrors routes/savedViews.ts ALLOWED_KEYS. */
const VIEW_KEYS = [
  'q',
  'state',
  'group',
  'kind',
  'source',
  'paid_status',
  'reviewer_id',
  'partner_id',
  'user_id',
  'waiting_on_client',
  'unread',
  'created_from',
  'created_to',
  'due_from',
  'due_to',
  'sort',
] as const;

/**
 * The saveable slice of a query string: known keys only, no pagination, and
 * key-sorted so the same filters always produce the same text. Mirrors the
 * server's normalisation so "is the current view dirty?" can be answered
 * without a round-trip.
 */
export function viewQueryOf(params: URLSearchParams): string {
  const kept: [string, string][] = [];
  for (const key of VIEW_KEYS) {
    const value = params.get(key)?.trim();
    if (value) kept.push([key, value]);
  }
  kept.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return new URLSearchParams(kept).toString();
}

export function SavedViews() {
  const { user } = useAuth();
  const ops = isOps(user);
  const [params, setParams] = useSearchParams();
  const [views, setViews] = useState<SavedView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saveOpen, setSaveOpen] = useState(false);
  const [name, setName] = useState('');
  const [visibility, setVisibility] = useState<'private' | 'shared'>('private');
  const [makeDefault, setMakeDefault] = useState(false);
  const [busy, setBusy] = useState(false);
  const [appliedDefault, setAppliedDefault] = useState(false);

  const current = useMemo(() => viewQueryOf(params), [params]);

  const load = useCallback(async () => {
    try {
      const res = await api<{ views: SavedView[] }>('/saved-views');
      setViews(res.views);
    } catch {
      // A failed picker must not take the worklist with it.
      setViews([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Open on the user's default view — but only on a bare URL, so a shared or
  // bookmarked link always wins, and only once, so clearing the filters does
  // not bounce straight back to the default.
  useEffect(() => {
    if (appliedDefault || !views) return;
    setAppliedDefault(true);
    if (current) return;
    const fallback = views.find((v) => v.is_default);
    if (fallback?.query) setParams(new URLSearchParams(fallback.query), { replace: true });
  }, [views, current, appliedDefault, setParams]);

  const active = views?.find((v) => v.query === current && current !== '') ?? null;

  const apply = (id: string) => {
    if (!id) {
      setParams(new URLSearchParams(), { replace: true });
      return;
    }
    const view = views?.find((v) => v.id === id);
    if (view) setParams(new URLSearchParams(view.query), { replace: true });
  };

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await api<{ view: SavedView }>('/saved-views', {
        method: 'POST',
        body: { name: name.trim(), query: current, visibility, is_default: makeDefault },
      });
      setSaveOpen(false);
      setName('');
      setMakeDefault(false);
      setVisibility('private');
      await load();
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : 'Could not save the view.',
      );
    } finally {
      setBusy(false);
    }
  };

  const update = async (view: SavedView, patch: Record<string, unknown>) => {
    setError(null);
    try {
      await api(`/saved-views/${view.id}`, { method: 'PATCH', body: patch });
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not update the view.');
    }
  };

  const remove = async (view: SavedView) => {
    setError(null);
    try {
      await api(`/saved-views/${view.id}`, { method: 'DELETE' });
      if (active?.id === view.id) setParams(new URLSearchParams(), { replace: true });
      await load();
    } catch {
      setError('Could not delete the view.');
    }
  };

  if (!views) return null;

  return (
    <div className="mt-4 flex flex-wrap items-center gap-2">
      <Select
        aria-label="Saved view"
        value={active?.id ?? ''}
        onChange={(e) => apply(e.target.value)}
        className="!w-auto min-w-48"
      >
        <option value="">
          {views.length ? 'Saved views…' : 'No saved views yet'}
        </option>
        {views
          .filter((v) => v.is_owner)
          .map((v) => (
            <option key={v.id} value={v.id}>
              {v.name}
              {v.is_default ? ' ★' : ''}
            </option>
          ))}
        {views.some((v) => !v.is_owner) && (
          <optgroup label="Shared by the team">
            {views
              .filter((v) => !v.is_owner)
              .map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name} — {v.owner_name}
                </option>
              ))}
          </optgroup>
        )}
      </Select>

      {/* Saving an empty filter set would store "everything", which the
          unfiltered list already is. */}
      <Button variant="secondary" onClick={() => setSaveOpen(true)} disabled={!current}>
        Save this view
      </Button>

      {active?.is_owner && (
        <>
          <Button variant="ghost" onClick={() => void update(active, { is_default: !active.is_default })}>
            {active.is_default ? 'Unset default' : 'Make default'}
          </Button>
          {ops && (
            <Button
              variant="ghost"
              onClick={() =>
                void update(active, {
                  visibility: active.visibility === 'shared' ? 'private' : 'shared',
                })
              }
            >
              {active.visibility === 'shared' ? 'Unshare' : 'Share with team'}
            </Button>
          )}
          <Button variant="ghost" onClick={() => void remove(active)}>
            Delete view
          </Button>
        </>
      )}

      {error && <span className="text-xs font-semibold text-red-700">{error}</span>}

      <Modal open={saveOpen} onClose={() => setSaveOpen(false)} title="Save this view">
        <div className="space-y-4 px-5 py-4">
          <p className="text-sm text-ink-600">
            Saves the filters, tab and sort currently on screen. It does not save which page you
            are on.
          </p>
          <label className="block text-xs font-semibold text-ink-600">
            Name
            <div className="mt-1">
              <TextInput
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="My reviews due this week"
                maxLength={80}
              />
            </div>
          </label>
          {ops && (
            <label className="block text-xs font-semibold text-ink-600">
              Visibility
              <div className="mt-1">
                <Select
                  value={visibility}
                  onChange={(e) => setVisibility(e.target.value as 'private' | 'shared')}
                >
                  <option value="private">Only me</option>
                  <option value="shared">Share with the operations team</option>
                </Select>
              </div>
            </label>
          )}
          <label className="flex items-center gap-2 text-xs font-semibold text-ink-600">
            <input
              type="checkbox"
              className="h-4 w-4 accent-bond-600"
              checked={makeDefault}
              onChange={(e) => setMakeDefault(e.target.checked)}
            />
            Open the worklist on this view
          </label>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setSaveOpen(false)}>
              Cancel
            </Button>
            <Button onClick={() => void save()} disabled={busy || !name.trim()}>
              {busy ? 'Saving…' : 'Save view'}
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
