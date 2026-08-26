import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../lib/api';
import { useLatestOnly } from '../lib/useLatestOnly';
import { useClearOnChange } from '../lib/useClearOnChange';
import { formatDateTime } from '../lib/format';
import { Button, EmptyState, ErrorNote, LoadingBlock, SkeletonCardList } from '../components/ui';

export interface SupportMessage {
  id: string;
  user_id: string;
  user_email: string;
  subject: string;
  body: string;
  page_path: string | null;
  status: 'open' | 'resolved';
  created_at: string;
  resolved_at: string | null;
}

/** Ops triage view for help-widget messages. */
export function SupportInboxPage() {
  const [messages, setMessages] = useState<SupportMessage[] | null>(null);
  const [scope, setScope] = useState<'open' | 'resolved' | 'all'>('open');
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  /*
   * The scope filter re-issues this without waiting, so the open and resolved
   * queues can be outstanding at once and the slower reply wins — leaving
   * resolved messages under the Open tab, with the Resolve button beside every
   * one of them. See `useLatestOnly`.
   */
  const claim = useLatestOnly();

  const load = useCallback(async () => {
    const current = claim();
    try {
      const qs = scope === 'all' ? '' : `?status=${scope}`;
      const { messages: items } = await api<{ messages: SupportMessage[] }>(`/support/messages${qs}`);
      if (!current()) return;
      setMessages(items);
    } catch (err) {
      if (!current()) return;
      setError(
        err instanceof ApiError && err.status === 403
          ? 'The support inbox is operations-only.'
          : 'Could not load support messages.',
      );
    }
  }, [scope, claim]);

  // Otherwise the open queue stays under the Resolved chip until the reply
  // lands — with a Resolve button beside every row of it.
  useClearOnChange(scope, () => setMessages(null));

  useEffect(() => {
    void load();
  }, [load]);

  const setStatus = async (id: string, status: 'open' | 'resolved') => {
    setBusyId(id);
    setError(null);
    try {
      await api(`/support/messages/${id}`, { method: 'PATCH', body: { status } });
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not update the message.');
    } finally {
      setBusyId(null);
    }
  };

  /*
   * No early return for the wait: a bare `<Spinner />` here took the scope
   * chips with it, so pressing Resolved blanked the page and left nothing
   * saying which queue had been asked for. Only the message list swaps.
   */
  return (
    <div>
      <h1 className="font-display text-3xl font-semibold text-ink-900">Support inbox</h1>
      <p className="mt-2 text-sm text-ink-500">
        Messages sent through the in-app help widget. Reply on the valuation's chat thread or by email, then
        mark the message resolved.
      </p>

      <div className="mt-6 flex gap-2">
        {(['open', 'resolved', 'all'] as const).map((s) => (
          <button
            key={s}
            onClick={() => setScope(s)}
            aria-pressed={scope === s}
            className={`tap-area cursor-pointer rounded-full px-3.5 py-1.5 text-xs font-semibold transition-colors ${
              scope === s
                ? 'bg-ink-900 text-paper-50'
                : 'border border-ink-200 bg-surface text-ink-600 hover:border-ink-400'
            }`}
          >
            {s[0]!.toUpperCase() + s.slice(1)}
          </button>
        ))}
      </div>

      {error && (
        <div className="mt-4">
          <ErrorNote>{error}</ErrorNote>
        </div>
      )}

      <div className="mt-6 space-y-4">
        {!messages && !error && (
          <LoadingBlock label={`Loading ${scope === 'all' ? 'all' : scope} support messages…`}>
            <SkeletonCardList rows={3} badges={1} />
          </LoadingBlock>
        )}
        {messages?.length === 0 && (
          <EmptyState title={scope === 'open' ? 'Inbox zero' : 'Nothing here'}>
            {scope === 'open' ? 'No open support messages — nice.' : 'No messages match this filter.'}
          </EmptyState>
        )}
        {messages?.map((m) => (
          <article key={m.id} className="rounded-lg border border-paper-300 bg-surface p-5 shadow-card">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-sm font-semibold text-ink-900">{m.subject}</h2>
              <span
                className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold ring-1 ring-inset ${
                  m.status === 'open'
                    ? 'bg-amber-50 text-amber-800 ring-amber-200'
                    : 'bg-bond-50 text-bond-700 ring-bond-200'
                }`}
              >
                {m.status}
              </span>
              <span className="tnum ml-auto text-xs text-ink-400">{formatDateTime(m.created_at)}</span>
            </div>
            <p className="mt-1 text-xs text-ink-400">
              {m.user_email}
              {m.page_path && (
                <>
                  {' '}
                  · from <span className="font-mono">{m.page_path}</span>
                </>
              )}
            </p>
            <p className="mt-3 text-sm whitespace-pre-wrap text-ink-700">{m.body}</p>
            <div className="mt-4">
              <Button
                variant="secondary"
                disabled={busyId === m.id}
                onClick={() => void setStatus(m.id, m.status === 'open' ? 'resolved' : 'open')}
              >
                {m.status === 'open' ? 'Mark resolved' : 'Reopen'}
              </Button>
            </div>
          </article>
        ))}
      </div>
    </div>
  );
}
