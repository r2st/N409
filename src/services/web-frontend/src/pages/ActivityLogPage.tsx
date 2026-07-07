import { useCallback, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import { formatDateTime } from '../lib/format';
import { Button, EmptyState, ErrorNote, Select, Spinner, TextInput } from '../components/ui';

const PER_PAGE = 50;

interface ActivityEvent {
  id: string;
  scope: 'valuation' | 'admin';
  type: string;
  actor_type: string;
  actor_id: string | null;
  actor_email: string | null;
  source: string | null;
  subject_type: string;
  subject_id: string | null;
  subject_label: string | null;
  payload: Record<string, unknown>;
  occurred_at: string;
}

interface ActivityList {
  events: ActivityEvent[];
  page: number;
  per_page: number;
  total: number;
}

interface UserOption {
  id: string;
  email: string;
}

const ACTOR_TYPES = ['human', 'ai', 'engine', 'system'] as const;

function payloadSummary(payload: Record<string, unknown>): string {
  const parts = Object.entries(payload)
    .filter(([, v]) => v !== null && v !== undefined && v !== '')
    .slice(0, 4)
    .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : typeof v === 'object' ? '…' : String(v)}`);
  return parts.join(' · ');
}

function ActorCell({ e }: { e: ActivityEvent }) {
  if (e.actor_type !== 'human')
    return <span className="font-mono text-xs text-ink-400">{e.actor_type}</span>;
  return <span className="text-ink-700">{e.actor_email ?? e.actor_id ?? 'unknown'}</span>;
}

/** P2 #12 — global, filterable "who did what, when" across valuations and
 * admin actions (users, partners, prompts, templates). Ops-only. */
export function ActivityLogPage() {
  const [params, setParams] = useSearchParams();
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actors, setActors] = useState<UserOption[]>([]);
  const [typeDraft, setTypeDraft] = useState(params.get('type') ?? '');

  const scope = params.get('scope') ?? 'all';
  const actorId = params.get('actor') ?? '';
  const actorType = params.get('actor_type') ?? '';
  const type = params.get('type') ?? '';
  const from = params.get('from') ?? '';
  const to = params.get('to') ?? '';

  const buildQuery = useCallback(
    (forPage: number) => {
      const query = new URLSearchParams({ page: String(forPage), per_page: String(PER_PAGE) });
      if (scope !== 'all') query.set('scope', scope);
      if (actorId) query.set('actor_id', actorId);
      if (actorType) query.set('actor_type', actorType);
      if (type) query.set('type', type);
      if (from) query.set('from', from);
      if (to) query.set('to', `${to}T23:59:59Z`);
      return query;
    },
    [scope, actorId, actorType, type, from, to],
  );

  // Filter changes restart from page 1; "Load more" appends the next page.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    api<ActivityList>(`/admin/events?${buildQuery(1)}`)
      .then((d) => {
        if (cancelled) return;
        setEvents(d.events);
        setTotal(d.total);
        setPage(1);
      })
      .catch((err) => {
        if (!cancelled)
          setError(
            err instanceof ApiError && err.status === 403
              ? 'The activity log is operations-only.'
              : 'Could not load the activity log.',
          );
      })
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [buildQuery]);

  useEffect(() => {
    api<{ options: UserOption[] }>('/users/options')
      .then((d) => setActors(d.options))
      .catch(() => {});
  }, []);

  const loadMore = async () => {
    setLoading(true);
    try {
      const d = await api<ActivityList>(`/admin/events?${buildQuery(page + 1)}`);
      setEvents((prev) => [...prev, ...d.events]);
      setTotal(d.total);
      setPage(page + 1);
    } catch {
      setError('Could not load more activity.');
    } finally {
      setLoading(false);
    }
  };

  const setFilter = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
  };

  return (
    <div>
      <div className="overline text-ink-400">Operations</div>
      <h1 className="mt-1 font-display text-3xl font-semibold text-ink-900">Activity log</h1>
      <p className="mt-2 max-w-2xl text-sm text-ink-500">
        Every valuation mutation and admin console action, newest first. The log is append-only —
        entries can never be edited or removed.
      </p>

      <form
        className="mt-6 flex flex-wrap gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          setFilter('type', typeDraft.trim());
        }}
      >
        <Select
          aria-label="Scope"
          value={scope}
          onChange={(e) => setFilter('scope', e.target.value === 'all' ? '' : e.target.value)}
          className="!w-auto min-w-36"
        >
          <option value="all">All activity</option>
          <option value="valuations">Valuations</option>
          <option value="admin">Administration</option>
        </Select>
        <Select
          aria-label="Actor"
          value={actorId}
          onChange={(e) => setFilter('actor', e.target.value)}
          className="!w-auto min-w-44"
        >
          <option value="">Any actor</option>
          {actors.map((a) => (
            <option key={a.id} value={a.id}>
              {a.email}
            </option>
          ))}
        </Select>
        <Select
          aria-label="Actor type"
          value={actorType}
          onChange={(e) => setFilter('actor_type', e.target.value)}
          className="!w-auto min-w-32"
        >
          <option value="">Any actor type</option>
          {ACTOR_TYPES.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </Select>
        <div className="w-44">
          <TextInput
            aria-label="Event type"
            placeholder="Event type…"
            value={typeDraft}
            onChange={(e) => setTypeDraft(e.target.value)}
            onBlur={() => setFilter('type', typeDraft.trim())}
          />
        </div>
        <TextInput
          aria-label="From date"
          type="date"
          value={from}
          onChange={(e) => setFilter('from', e.target.value)}
          className="!w-auto"
        />
        <TextInput
          aria-label="To date"
          type="date"
          value={to}
          onChange={(e) => setFilter('to', e.target.value)}
          className="!w-auto"
        />
        <button type="submit" hidden />
      </form>

      {error && <div className="mt-6"><ErrorNote>{error}</ErrorNote></div>}
      {loading && events.length === 0 && <Spinner />}

      {!error && !loading && events.length === 0 && (
        <div className="mt-6">
          <EmptyState title="No activity matches these filters" />
        </div>
      )}

      {events.length > 0 && (
        <div className="mt-6 overflow-x-auto rounded-lg border border-paper-300 bg-white shadow-card">
          <table className="w-full min-w-[860px] text-sm" aria-label="Activity log">
            <thead>
              <tr className="border-b border-paper-300 text-left">
                <th className="overline px-5 py-3 font-semibold text-ink-400">When</th>
                <th className="overline px-5 py-3 font-semibold text-ink-400">Actor</th>
                <th className="overline px-5 py-3 font-semibold text-ink-400">Event</th>
                <th className="overline px-5 py-3 font-semibold text-ink-400">Subject</th>
                <th className="overline px-5 py-3 font-semibold text-ink-400">Details</th>
              </tr>
            </thead>
            <tbody>
              {events.map((e) => (
                <tr key={e.id} className="border-b border-paper-200 align-top last:border-0">
                  <td className="tnum px-5 py-3 whitespace-nowrap text-ink-600">
                    {formatDateTime(e.occurred_at)}
                  </td>
                  <td className="px-5 py-3">
                    <ActorCell e={e} />
                  </td>
                  <td className="px-5 py-3">
                    <span className="rounded border border-ink-200 bg-paper-50 px-1.5 py-0.5 font-mono text-[0.7rem] font-semibold text-ink-700">
                      {e.type}
                    </span>
                  </td>
                  <td className="px-5 py-3">
                    {e.scope === 'valuation' && e.subject_id ? (
                      <Link
                        to={`/valuations/${e.subject_id}`}
                        className="font-medium text-bond-600 hover:text-bond-700"
                      >
                        {e.subject_label ?? e.subject_id}
                      </Link>
                    ) : (
                      <span className="text-ink-700">
                        {e.subject_label ?? e.subject_id ?? '—'}
                        <span className="ml-1.5 text-xs text-ink-400">({e.subject_type})</span>
                      </span>
                    )}
                  </td>
                  <td className="max-w-72 px-5 py-3 text-xs break-words text-ink-500">
                    {payloadSummary(e.payload) || '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {events.length > 0 && (
        <div className="mt-5 flex items-center justify-between text-sm text-ink-600">
          <span className="tnum">
            Showing {events.length} of {total}
          </span>
          {events.length < total && (
            <Button variant="secondary" disabled={loading} onClick={() => void loadMore()}>
              {loading ? 'Loading…' : 'Load more'}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
