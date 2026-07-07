import { useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { isOps } from '../lib/rbac';
import { formatDateTime } from '../lib/format';
import type { Comment } from '../lib/types';
import { Button, ErrorNote, Spinner } from './ui';

/**
 * M3 features 10 + 11 — per-valuation conversation (chat + threaded email)
 * and, for ops, internal sticky notes.
 */
export function CommentsSection({
  valuationId,
  refreshKey = 0,
}: {
  valuationId: string;
  /** Bump to re-fetch the thread (improvement 4 — live SSE comment pushes). */
  refreshKey?: number;
}) {
  const { user } = useAuth();
  const ops = isOps(user);
  const [comments, setComments] = useState<Comment[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [noteDraft, setNoteDraft] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api<{ comments: Comment[] }>(`/valuations/${valuationId}/comments`)
      .then((res) => setComments(res.comments))
      .catch(() => setError('Could not load the conversation.'));
  }, [valuationId]);

  useEffect(() => {
    load();
  }, [load, refreshKey]);

  const post = async (kind: 'chat' | 'note', body: string, reset: () => void) => {
    if (!body.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await api(`/valuations/${valuationId}/comments`, {
        method: 'POST',
        body: { kind, body: body.trim(), ...(kind === 'note' ? { pinned: true } : {}) },
      });
      reset();
      load();
    } catch {
      setError('Could not post — try again.');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    try {
      await api(`/comments/${id}`, { method: 'DELETE' });
      load();
    } catch {
      setError('Could not delete the comment.');
    }
  };

  const togglePin = async (comment: Comment) => {
    try {
      await api(`/comments/${comment.id}`, { method: 'PATCH', body: { pinned: !comment.pinned } });
      load();
    } catch {
      setError('Could not update the note.');
    }
  };

  if (!comments && !error) return <Spinner />;

  const thread = (comments ?? []).filter((c) => c.kind !== 'note');
  const notes = (comments ?? []).filter((c) => c.kind === 'note');

  const canModerate = (c: Comment) => ops || c.author_id === user?.id;

  return (
    <div className="space-y-8">
      {/* Sticky notes — internal, ops only (the API never returns them otherwise) */}
      {ops && (
        <section className="rounded-lg border border-amber-300 bg-amber-50/50 p-6 shadow-card">
          <h2 className="overline mb-4 text-amber-800">Sticky notes · internal</h2>
          <ul className="space-y-3">
            {notes.map((n) => (
              <li key={n.id} className="rounded-md border border-amber-200 bg-white px-4 py-3">
                <p className="text-sm whitespace-pre-wrap text-ink-800">{n.body}</p>
                <div className="mt-2 flex items-center gap-3 text-xs text-ink-400">
                  <span>{n.author_name ?? n.author_email ?? 'ops'}</span>
                  <span className="tnum">{formatDateTime(n.created_at)}</span>
                  <button
                    onClick={() => togglePin(n)}
                    className="cursor-pointer font-semibold text-amber-700 hover:text-amber-800"
                  >
                    {n.pinned ? 'Unpin' : 'Pin'}
                  </button>
                  <button
                    onClick={() => remove(n.id)}
                    className="cursor-pointer font-semibold text-red-600 hover:text-red-700"
                  >
                    Delete
                  </button>
                </div>
              </li>
            ))}
            {notes.length === 0 && <li className="text-sm text-ink-400">No notes yet.</li>}
          </ul>
          <form
            className="mt-4 flex gap-2"
            onSubmit={(e: FormEvent) => {
              e.preventDefault();
              void post('note', noteDraft, () => setNoteDraft(''));
            }}
          >
            <input
              value={noteDraft}
              onChange={(e) => setNoteDraft(e.target.value)}
              placeholder="Add an internal note…"
              className="w-full rounded-md border border-amber-200 bg-white px-3 py-2 text-sm text-ink-900 placeholder:text-ink-300 focus:border-brass-500 focus:ring-2 focus:ring-brass-500/20 focus:outline-none"
            />
            <Button type="submit" variant="secondary" disabled={busy || !noteDraft.trim()}>
              Add note
            </Button>
          </form>
        </section>
      )}

      {/* Conversation: chat + (for ops) threaded inbound email */}
      <section className="rounded-lg border border-paper-300 bg-white p-6 shadow-card">
        <h2 className="overline mb-4 text-ink-400">Conversation</h2>
        {error && <div className="mb-4"><ErrorNote>{error}</ErrorNote></div>}
        <ul className="space-y-4">
          {thread.map((c) => (
            <li key={c.id} className="flex gap-3">
              <div
                className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[0.65rem] font-bold ${
                  c.kind === 'email' ? 'bg-sky-100 text-sky-800' : 'bg-bond-100 text-bond-800'
                }`}
              >
                {c.kind === 'email' ? '@' : (c.author_name ?? c.author_email ?? '?').slice(0, 2).toUpperCase()}
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-x-2 text-xs text-ink-400">
                  <span className="font-semibold text-ink-700">
                    {c.kind === 'email' ? (c.email_meta?.from ?? 'email') : (c.author_name ?? c.author_email ?? 'unknown')}
                  </span>
                  {c.kind === 'email' && (
                    <span className="rounded bg-sky-50 px-1.5 py-0.5 font-semibold text-sky-700 ring-1 ring-sky-200 ring-inset">
                      Email{c.email_meta?.subject ? ` · ${c.email_meta.subject}` : ''}
                    </span>
                  )}
                  <span className="tnum">{formatDateTime(c.created_at)}</span>
                  {c.kind === 'chat' && canModerate(c) && (
                    <button
                      onClick={() => remove(c.id)}
                      className="cursor-pointer font-semibold text-red-600 hover:text-red-700"
                    >
                      Delete
                    </button>
                  )}
                </div>
                <p className="mt-1 text-sm whitespace-pre-wrap text-ink-800">{c.body}</p>
              </div>
            </li>
          ))}
          {thread.length === 0 && (
            <li className="text-sm text-ink-400">No messages yet — start the conversation below.</li>
          )}
        </ul>

        <form
          className="mt-5 flex gap-2 border-t border-paper-200 pt-5"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            void post('chat', draft, () => setDraft(''));
          }}
        >
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Write a message…"
            aria-label="Write a message"
            className="w-full rounded-md border border-ink-200 bg-white px-3 py-2 text-sm text-ink-900 placeholder:text-ink-300 focus:border-bond-600 focus:ring-2 focus:ring-bond-600/20 focus:outline-none"
          />
          <Button type="submit" disabled={busy || !draft.trim()}>
            Send
          </Button>
        </form>
      </section>
    </div>
  );
}
