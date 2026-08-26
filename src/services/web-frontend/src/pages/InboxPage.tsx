import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import { useLatestOnly } from '../lib/useLatestOnly';
import { useAuth } from '../lib/auth';
import { isOps } from '../lib/rbac';
import { displayName, formatDateTime } from '../lib/format';
import {
  Button,
  EmptyState,
  ErrorNote,
  Pagination,
  ResultCount,
  Spinner,
  TextInput,
  pageCountOf,
} from '../components/ui';

/**
 * The shared inbox (409.ai §17) — every engagement thread in one list.
 *
 * The workspace's own comment tab answers "what has been said on this
 * engagement". Nobody works that way: an analyst carrying nine files does not
 * open nine tabs to find out which of them a client replied to overnight.
 *
 * Read state is per reader and per thread.
 *
 * Replying happens inline (design §15.2) but the write does not: the box POSTs
 * to `/valuations/:id/comments`, the engagement's own thread endpoint, which
 * owns the kind rules, the mention parsing and the realtime broadcast. There
 * is deliberately no inbox write endpoint — a second write path is how those
 * three drift apart, and the drift shows up as a mention that never notified
 * anyone rather than as an error.
 */

interface InboxItem {
  id: string;
  valuation_id: string;
  valuation_number: string;
  company_name: string;
  valuation_kind: string;
  valuation_state: string;
  kind: 'chat' | 'note' | 'email';
  body: string;
  author_name: string | null;
  author_email: string | null;
  email_meta: { from?: string; subject?: string } | null;
  pinned: boolean;
  created_at: string;
  unread: boolean;
}

interface InboxResponse {
  items: InboxItem[];
  total: number;
  unread_total: number;
  page: number;
  per_page: number;
}

const KIND_STYLES: Record<InboxItem['kind'], string> = {
  chat: 'bg-bond-50 text-bond-800 border-bond-200',
  note: 'bg-amber-50 text-amber-800 border-amber-200',
  email: 'bg-paper-200 text-ink-600 border-paper-300',
};

const KIND_LABELS: Record<InboxItem['kind'], string> = {
  chat: 'Client chat',
  note: 'Internal note',
  email: 'Email',
};

const PER_PAGE = 25;

/** What the reply posts as, per the kind of the message being answered. */
type ReplyKind = 'chat' | 'note';

/**
 * An inbound email is threaded onto the engagement but cannot be replied to
 * *as* email — `canPostComment` refuses kind `email` outright, because email
 * arrives through the ingest endpoint and nothing on this platform sends it
 * back out of a comment box. Answering one is a client chat message.
 */
function defaultReplyKind(kind: InboxItem['kind']): ReplyKind {
  return kind === 'note' ? 'note' : 'chat';
}

function ReplyBox({
  item,
  canPostNote,
  senderName,
  onSent,
}: {
  item: InboxItem;
  canPostNote: boolean;
  senderName: string;
  onSent: (comment: InboxItem) => void;
}) {
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<ReplyKind>(defaultReplyKind(item.kind));
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const text = body.trim();
    if (text === '') return;
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ comment: { id: string; created_at: string; author_name: string | null } }>(
        `/valuations/${item.valuation_id}/comments`,
        { method: 'POST', body: { kind, body: text } },
      );
      setBody('');
      setOpen(false);
      onSent({
        ...item,
        id: res.comment.id,
        kind,
        body: text,
        // The insert returns the row it wrote, which carries an author id and
        // not the joined display name. We are the author, so the fallback is
        // exact rather than a guess.
        author_name: res.comment.author_name ?? senderName,
        author_email: null,
        email_meta: null,
        pinned: false,
        created_at: res.comment.created_at,
        unread: false,
      });
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 403
          ? 'You cannot post to this engagement’s thread.'
          : 'Could not send — try again.',
      );
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="mt-2 cursor-pointer text-xs font-semibold text-bond-600 hover:text-bond-700"
      >
        Reply
      </button>
    );
  }

  return (
    <form onSubmit={(e) => void submit(e)} className="mt-3">
      {canPostNote && (
        <div className="mb-2 flex items-center gap-2">
          {(['chat', 'note'] as const).map((k) => (
            <button
              key={k}
              type="button"
              onClick={() => setKind(k)}
              aria-pressed={kind === k}
              className={`tap-area cursor-pointer rounded-full px-2.5 py-1 text-[0.65rem] font-semibold transition-colors ${
                kind === k
                  ? 'bg-ink-900 text-paper-50'
                  : 'border border-ink-200 bg-surface text-ink-600 hover:border-ink-400'
              }`}
            >
              {k === 'chat' ? 'Reply to client' : 'Post as note'}
            </button>
          ))}
        </div>
      )}
      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        rows={3}
        autoFocus
        aria-label={`Reply to ${item.company_name}`}
        placeholder={
          kind === 'note'
            ? 'Internal note — the client never sees this.'
            : 'Reply to the client on this engagement’s thread.'
        }
        className="w-full rounded-md border border-ink-200 bg-surface px-3 py-2 text-sm text-ink-800 focus:border-bond-500 focus:outline-none"
      />
      {/* Announced: a reply that failed to send is the one thing on this form
          the user must not miss, and by the time it appears focus is on Send. */}
      {error && (
        <p role="alert" className="mt-1 text-xs text-red-700">
          {error}
        </p>
      )}
      <div className="mt-2 flex items-center gap-2">
        <Button type="submit" disabled={busy || body.trim() === ''}>
          {busy ? 'Sending…' : 'Send'}
        </Button>
        <button
          type="button"
          onClick={() => {
            setOpen(false);
            setError(null);
          }}
          className="cursor-pointer text-xs font-semibold text-ink-500 hover:text-ink-700"
        >
          Cancel
        </button>
        <span className="text-xs text-ink-400">
          Posts to the engagement thread — the same place the workspace posts.
        </span>
      </div>
    </form>
  );
}

function Sender({ item }: { item: InboxItem }) {
  // An inbound email has no author row — the address it came from is the only
  // thing we know about who sent it, and it is the useful thing.
  const label = item.author_name ?? item.author_email ?? item.email_meta?.from ?? 'Unknown sender';
  return <span className="font-semibold text-ink-800">{label}</span>;
}

export function InboxPage() {
  const { user } = useAuth();
  const [data, setData] = useState<InboxResponse | null>(null);
  const [kind, setKind] = useState<'all' | InboxItem['kind']>('all');
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  /*
   * Four controls feed this one address — the kind tabs, the unread toggle, the
   * debounced search and the pager — and none of them waits for the reply
   * already outstanding. The late one repaints the previous filter's messages
   * under the current tabs, and the unread counts beside them come off the same
   * response, so the whole panel agrees with itself about the wrong query. See
   * `useLatestOnly`.
   */
  const claim = useLatestOnly();

  const load = useCallback(async () => {
    const current = claim();
    const params = new URLSearchParams({ page: String(page), per_page: String(PER_PAGE) });
    if (kind !== 'all') params.set('kind', kind);
    if (unreadOnly) params.set('unread', 'true');
    if (query) params.set('q', query);
    try {
      const res = await api<InboxResponse>(`/inbox?${params}`);
      if (!current()) return;
      setData(res);
      setError(null);
    } catch (err) {
      if (!current()) return;
      setError(
        err instanceof ApiError && err.status === 403
          ? 'You do not have access to the shared inbox.'
          : 'Could not load the inbox.',
      );
    }
  }, [kind, unreadOnly, query, page, claim]);

  useEffect(() => {
    void load();
  }, [load]);

  // Filters change what "page 1" means, so a filter change resets the page
  // rather than leaving the reader on an empty page 4.
  useEffect(() => {
    setPage(1);
  }, [kind, unreadOnly, query]);

  const markRead = async (valuationId: string) => {
    try {
      await api('/inbox/read', { method: 'POST', body: { valuation_id: valuationId } });
      // Optimistic: every row on this engagement, not just the one clicked —
      // read state is per thread.
      setData((d) =>
        d
          ? {
              ...d,
              items: d.items.map((i) => (i.valuation_id === valuationId ? { ...i, unread: false } : i)),
              unread_total: d.items.filter((i) => i.valuation_id !== valuationId && i.unread).length,
            }
          : d,
      );
    } catch {
      // A failed read mark is not worth interrupting navigation for; the next
      // load restores the truth.
    }
  };

  const markAllRead = async () => {
    setBusy(true);
    try {
      await api('/inbox/read-all', { method: 'POST' });
      await load();
    } catch {
      setError('Could not clear the inbox.');
    } finally {
      setBusy(false);
    }
  };

  if (error && !data) return <ErrorNote>{error}</ErrorNote>;
  if (!data) return <Spinner />;

  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="overline text-ink-400">Operations</div>
          <h1 className="mt-1 font-display text-3xl font-semibold text-ink-900">Inbox</h1>
          <p className="mt-1 text-sm text-ink-400">
            Every engagement thread in one list.{' '}
            {data.unread_total > 0 ? `${data.unread_total} unread.` : 'Nothing unread.'}
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="secondary" onClick={() => void load()}>
            Refresh
          </Button>
          <Button variant="secondary" disabled={busy || data.unread_total === 0} onClick={markAllRead}>
            Mark all read
          </Button>
        </div>
      </div>

      <div className="mt-6 flex flex-wrap items-center gap-2">
        {(['all', 'chat', 'note', 'email'] as const).map((k) => (
          <button
            key={k}
            onClick={() => setKind(k)}
            aria-pressed={kind === k}
            className={`tap-area cursor-pointer rounded-full px-3.5 py-1.5 text-xs font-semibold transition-colors ${
              kind === k
                ? 'bg-ink-900 text-paper-50'
                : 'border border-ink-200 bg-surface text-ink-600 hover:border-ink-400'
            }`}
          >
            {k === 'all' ? 'All' : KIND_LABELS[k]}
          </button>
        ))}
        <label className="ml-2 flex cursor-pointer items-center gap-2 text-xs font-semibold text-ink-600">
          <input
            type="checkbox"
            checked={unreadOnly}
            onChange={(e) => setUnreadOnly(e.target.checked)}
            className="cursor-pointer"
          />
          Unread only
        </label>
        <form
          className="ml-auto flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            setQuery(search.trim());
          }}
        >
          <TextInput
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search messages, company or number"
            aria-label="Search the inbox"
            className="w-64"
          />
          <Button variant="secondary" type="submit">
            Search
          </Button>
          <ResultCount count={data.total} noun="message" query={query} />
        </form>
      </div>

      {error && (
        <div className="mt-4">
          <ErrorNote>{error}</ErrorNote>
        </div>
      )}

      {data.items.length === 0 ? (
        <div className="mt-6">
          <EmptyState title={unreadOnly ? 'Nothing unread' : 'No messages'}>
            Client chat, internal notes and threaded email appear here as they arrive.
          </EmptyState>
        </div>
      ) : (
        <ul className="mt-6 divide-y divide-paper-300 rounded-lg border border-paper-300 bg-surface shadow-card">
          {data.items.map((item) => (
            <li
              key={item.id}
              className={`px-5 py-4 transition-colors hover:bg-paper-100 ${
                item.unread ? 'border-l-2 border-l-brass-400' : ''
              }`}
            >
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <Link
                  to={`/valuations/${item.valuation_id}`}
                  onClick={() => void markRead(item.valuation_id)}
                  className="font-semibold text-ink-900 hover:text-bond-700"
                >
                  {item.company_name}
                </Link>
                <span className="tnum text-xs text-ink-400">#{item.valuation_number}</span>
                <span className="text-xs uppercase text-ink-400">{item.valuation_kind}</span>
                <span
                  className={`inline-block rounded-full border px-2 py-0.5 text-[0.65rem] font-semibold ${KIND_STYLES[item.kind]}`}
                >
                  {KIND_LABELS[item.kind]}
                </span>
                {item.pinned && <span className="text-[0.65rem] font-semibold text-brass-600">Pinned</span>}
                <span className="ml-auto text-xs text-ink-400">{formatDateTime(item.created_at)}</span>
              </div>
              <p className="mt-1.5 text-sm text-ink-600">
                <Sender item={item} />
                {item.email_meta?.subject ? ` — ${item.email_meta.subject}` : ''}
              </p>
              {/* Clamped rather than truncated in JS: the full text is in the
                  DOM for search-in-page, and the thread itself is one click
                  away for reading it properly. */}
              <p className="mt-1 line-clamp-2 text-sm text-ink-500">{item.body}</p>
              <ReplyBox
                item={item}
                canPostNote={isOps(user)}
                senderName={user ? displayName(user) : 'You'}
                onSent={(sent) => {
                  // Prepend rather than replace: the row that was answered is
                  // still the message that arrived, and the reply is a new
                  // message on the same thread. Marking the thread read at the
                  // same time is the honest state — you have now read it.
                  setData((d) =>
                    d
                      ? {
                          ...d,
                          items: [
                            sent,
                            ...d.items.map((i) =>
                              i.valuation_id === sent.valuation_id ? { ...i, unread: false } : i,
                            ),
                          ],
                          unread_total: d.items.filter(
                            (i) => i.valuation_id !== sent.valuation_id && i.unread,
                          ).length,
                        }
                      : d,
                  );
                  void markRead(sent.valuation_id);
                }}
              />
            </li>
          ))}
        </ul>
      )}

      <Pagination
        page={data.page}
        pageCount={pageCountOf(data.total, data.per_page)}
        onPage={setPage}
        className="mt-6"
      />
    </div>
  );
}
