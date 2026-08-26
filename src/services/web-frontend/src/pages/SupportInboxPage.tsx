import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../lib/api';
import { useLatestOnly } from '../lib/useLatestOnly';
import { useClearOnChange } from '../lib/useClearOnChange';
import { formatDateTime } from '../lib/format';
import {
  Button,
  EmptyState,
  ErrorNote,
  ListTruncationNote,
  LoadingBlock,
  SkeletonCardList,
} from '../components/ui';

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

export interface ContactSubmission {
  id: string;
  name: string;
  email: string;
  company: string | null;
  phone: string | null;
  message: string;
  status: 'new' | 'handled';
  handled_at: string | null;
  created_at: string;
}

/**
 * Ops triage for inbound messages: the in-app help widget, and the public
 * marketing contact form.
 *
 * The contact queue is here rather than on a page of its own because it is the
 * same job — read an inbound message, act on it elsewhere, mark it done — and
 * because it had no page at all. `POST /api/v1/contact` has been writing rows
 * since the marketing site shipped, and `GET /contact/submissions` and the
 * status PATCH beside it have existed for as long, with nothing in the product
 * calling either. Every enquiry from the website landed in a table only a
 * `psql` session could read; from the operator's side that is indistinguishable
 * from a contact form that posts nowhere.
 */
export function SupportInboxPage() {
  const [queue, setQueue] = useState<'support' | 'contact'>('support');
  return (
    <div>
      <h1 className="font-display text-3xl font-semibold text-ink-900">Inbound</h1>
      {/*
        Chips with `aria-pressed`, not the ARIA tab pattern. That pattern
        carries a keyboard contract this platform enforces (rovingFocus.test):
        arrow keys move between the tabs and only the selected one is a tab
        stop. These are two toggle buttons over two independent queues — the
        same control the status filters below already are — and claiming the
        role without honouring the contract announces a keyboard behaviour that
        is not there.
      */}
      <div className="mt-6 flex gap-2">
        {(
          [
            ['support', 'Support widget'],
            ['contact', 'Contact form'],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            onClick={() => setQueue(key)}
            aria-pressed={queue === key}
            className={`tap-area cursor-pointer rounded-full px-3.5 py-1.5 text-xs font-semibold transition-colors ${
              queue === key
                ? 'bg-ink-900 text-paper-50'
                : 'border border-ink-200 bg-surface text-ink-600 hover:border-ink-400'
            }`}
          >
            {label}
          </button>
        ))}
      </div>
      {queue === 'support' ? <SupportQueue /> : <ContactQueue />}
    </div>
  );
}

/** Ops triage view for help-widget messages. */
function SupportQueue() {
  const [messages, setMessages] = useState<SupportMessage[] | null>(null);
  const [capped, setCapped] = useState(false);
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
      const { messages: items, truncated } = await api<{
        messages: SupportMessage[];
        truncated: boolean;
      }>(`/support/messages${qs}`);
      if (!current()) return;
      setMessages(items);
      setCapped(truncated);
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
      <h2 className="mt-8 font-display text-xl font-semibold text-ink-900">Support inbox</h2>
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
              <h3 className="text-sm font-semibold text-ink-900">{m.subject}</h3>
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
        {/* Ordered by status before date, so the row that falls off this cap is
            the oldest message of the *lowest* priority status — precisely the
            one an operator would assume had been dealt with. */}
        <ListTruncationNote
          truncated={capped}
          shown={messages?.length ?? 0}
          noun="messages"
          hint="narrow with the status filter"
        />
      </div>
    </div>
  );
}

/**
 * The public contact form's inbox.
 *
 * Deliberately the same shape as {@link SupportQueue} — same scope chips, same
 * stale-reply guard, same truncation note — because it is the same triage and
 * an operator switching queues should not have to learn a second one. The two
 * differences are what the rows carry (a name, company and phone from someone
 * who has no account yet, rather than a signed-in user's email) and the words
 * for the states: a contact submission is `new` or `handled`.
 */
function ContactQueue() {
  const [submissions, setSubmissions] = useState<ContactSubmission[] | null>(null);
  const [capped, setCapped] = useState(false);
  const [scope, setScope] = useState<'new' | 'handled' | 'all'>('new');
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  // Same race as the support queue's, for the same reason: the chips re-issue
  // the request without waiting, so the slower reply can win.
  const claim = useLatestOnly();

  const load = useCallback(async () => {
    const current = claim();
    try {
      const qs = scope === 'all' ? '' : `?status=${scope}`;
      const { submissions: items, truncated } = await api<{
        submissions: ContactSubmission[];
        truncated: boolean;
      }>(`/contact/submissions${qs}`);
      if (!current()) return;
      setSubmissions(items);
      setCapped(truncated);
    } catch (err) {
      if (!current()) return;
      setError(
        err instanceof ApiError && err.status === 403
          ? 'The contact inbox is operations-only.'
          : 'Could not load contact submissions.',
      );
    }
  }, [scope, claim]);

  useClearOnChange(scope, () => setSubmissions(null));

  useEffect(() => {
    void load();
  }, [load]);

  const setStatus = async (id: string, status: 'new' | 'handled') => {
    setBusyId(id);
    setError(null);
    try {
      await api(`/contact/submissions/${id}`, { method: 'PATCH', body: { status } });
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not update the submission.');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div>
      <h2 className="mt-8 font-display text-xl font-semibold text-ink-900">Contact form</h2>
      <p className="mt-2 text-sm text-ink-500">
        Enquiries sent from the public site. Reply by email, then mark the enquiry handled.
      </p>

      <div className="mt-6 flex gap-2">
        {(['new', 'handled', 'all'] as const).map((s) => (
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
        {!submissions && !error && (
          <LoadingBlock label={`Loading ${scope === 'all' ? 'all' : scope} contact enquiries…`}>
            <SkeletonCardList rows={3} badges={1} />
          </LoadingBlock>
        )}
        {submissions?.length === 0 && (
          <EmptyState title={scope === 'new' ? 'Inbox zero' : 'Nothing here'}>
            {scope === 'new' ? 'No new enquiries.' : 'No enquiries match this filter.'}
          </EmptyState>
        )}
        {submissions?.map((c) => (
          <article key={c.id} className="rounded-lg border border-paper-300 bg-surface p-5 shadow-card">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-sm font-semibold text-ink-900">{c.name}</h3>
              <span
                className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold ring-1 ring-inset ${
                  c.status === 'new'
                    ? 'bg-amber-50 text-amber-800 ring-amber-200'
                    : 'bg-bond-50 text-bond-700 ring-bond-200'
                }`}
              >
                {c.status}
              </span>
              <span className="tnum ml-auto text-xs text-ink-400">{formatDateTime(c.created_at)}</span>
            </div>
            <p className="mt-1 text-xs text-ink-400">
              {/* A mailto rather than plain text: the only action this queue
                  has is replying, and the address is the whole of it. */}
              <a className="underline hover:text-ink-600" href={`mailto:${c.email}`}>
                {c.email}
              </a>
              {c.company && <> · {c.company}</>}
              {c.phone && <> · {c.phone}</>}
            </p>
            <p className="mt-3 text-sm whitespace-pre-wrap text-ink-700">{c.message}</p>
            <div className="mt-4">
              <Button
                variant="secondary"
                disabled={busyId === c.id}
                onClick={() => void setStatus(c.id, c.status === 'new' ? 'handled' : 'new')}
              >
                {c.status === 'new' ? 'Mark handled' : 'Reopen'}
              </Button>
            </div>
          </article>
        ))}
        <ListTruncationNote
          truncated={capped}
          shown={submissions?.length ?? 0}
          noun="enquiries"
          hint="narrow with the status filter"
        />
      </div>
    </div>
  );
}
