import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, describeActionFailure, describeLoadFailure } from '../lib/api';
import { formatDateTime } from '../lib/format';
import type { AppNotification } from '../lib/types';
import { Button, EmptyState, ErrorNote, LoadError, LoadingBlock, Skeleton } from '../components/ui';

/**
 * In-app notification centre (M4).
 *
 * Three things about this list are only true for someone looking at it, and
 * each is fixed below.
 *
 * **Unread was a colour.** The state of a row was carried by a tinted border, a
 * tinted background and a 8px dot with no text in it — three spellings of one
 * fact, all of them visual (WCAG 1.4.1). The nearest thing to a textual cue was
 * that unread rows have a "Mark read" button and read rows do not, which asks
 * the reader to infer the state from the absence of a control. The dot is now
 * `aria-hidden` and carries an `sr-only` word instead, so the row announces
 * "Unread" before its title.
 *
 * **Every row's controls had the same name.** Pulling up the control list of a
 * screenful gave "Mark read, Mark read, Mark read…" and "Open, Open, Open…",
 * which is a list of buttons with no way to tell which notification each one is
 * about. Both now name their row.
 *
 * **Pressing either control destroyed the reader's place.** "Mark read" is a
 * button that removes itself: the row becomes read, the branch that renders the
 * button stops rendering it, and focus — which was on it — falls back to
 * `<body>`. The next Tab starts again from the top of the document, so working
 * down a list of ten and marking them off sent the user back to the skip link
 * ten times. "Mark all read" does the same at the page level. Focus is now
 * moved deliberately: to the row that was marked, which still exists and now
 * reads as read, and to the heading for the bulk action, whose count has just
 * changed.
 *
 * The move alone is silent, though — focusing an element announces *it*, not
 * what happened — so the outcome is also spoken through a live region that is
 * always mounted. `ResultCount`'s note in components/ui explains why a region
 * inserted with its message already in it commonly says nothing at all.
 */
/**
 * Where this row's "Open →" goes, or null for a row with nowhere to go.
 *
 * `valuation_id` was the only destination the table could name, so the
 * account-scoped notifications — a declined renewal, a cancelled
 * subscription, a stalled queue — arrived as a sentence naming an action
 * ("Update your card from the billing page") with nothing to click, while the
 * email sent in the same breath carried the link. `link` (migration 0188) is
 * the general answer and takes precedence; the valuation path stays the
 * fallback so every existing row keeps working without a backfill.
 *
 * The shape is re-checked here even though the server refuses anything else at
 * the write and a CHECK constraint refuses it at the column. This is the place
 * the value becomes a navigation: React Router hands `//host` to the browser
 * as a protocol-relative URL, and a reader who leaves the application from a
 * link inside their own inbox has no way to tell it was not ours.
 */
function destinationOf(n: AppNotification): string | null {
  if (n.link && /^\/[^/\\]/.test(n.link)) return n.link;
  return n.valuation_id ? `/valuations/${n.valuation_id}` : null;
}

export function NotificationsPage() {
  const [notifications, setNotifications] = useState<AppNotification[] | null>(null);
  const [unread, setUnread] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const headingRef = useRef<HTMLHeadingElement>(null);
  /**
   * The rendered `<li>` per notification id. Keyed by `n.id`, which is also the
   * React key, so the element survives the reload that follows a write and is
   * still the right thing to focus once the button inside it has gone.
   */
  const rowRefs = useRef(new Map<string, HTMLLIElement>());

  const load = useCallback(async () => {
    try {
      const data = await api<{ notifications: AppNotification[]; unread_count: number }>('/notifications');
      setNotifications(data.notifications);
      setUnread(data.unread_count);
    } catch (err) {
      setError(describeLoadFailure(err, 'Could not load notifications.'));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const markRead = async (id: string) => {
    try {
      await api(`/notifications/${id}/read`, { method: 'POST' });
      // Before the reload, not after: the row element is the same either way,
      // and taking focus while the button is still mounted means there is no
      // instant in which the document has no focused element at all.
      rowRefs.current.get(id)?.focus();
      setNotice('Marked as read.');
      await load();
    } catch {
      /* non-fatal — the row simply stays unread */
    }
  };

  const markAllRead = async () => {
    try {
      await api('/notifications/read-all', { method: 'POST' });
      headingRef.current?.focus();
      setNotice('All notifications marked as read.');
      await load();
    } catch (err) {
      setError(describeActionFailure(err, 'Could not mark notifications as read.'));
    }
  };

  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="overline text-ink-400">Inbox</div>
          <h1
            ref={headingRef}
            tabIndex={-1}
            className="mt-1 font-display text-3xl font-semibold text-ink-900 focus:outline-none"
          >
            Notifications{unread > 0 && <span className="ml-2 text-lg text-bond-600">({unread} unread)</span>}
          </h1>
        </div>
        {unread > 0 && (
          <Button variant="secondary" onClick={markAllRead}>
            Mark all read
          </Button>
        )}
      </div>

      {/* Always mounted; only the text changes. See the note above. */}
      <p role="status" aria-live="polite" className="sr-only">
        {notice}
      </p>

      {error && !notifications && (
        <div className="mt-6">
          <LoadError message={error} onRetry={() => { setError(null); void load(); }} />
        </div>
      )}
      {error && notifications && (
        <div className="mt-6">
          <ErrorNote>{error}</ErrorNote>
        </div>
      )}
      {!notifications && !error && (
        <LoadingBlock label="Loading notifications…">
          <ul aria-hidden className="mt-6 space-y-2">
            {Array.from({ length: 6 }, (_, i) => (
              <li key={i} className="rounded-lg border border-paper-300 bg-surface p-4 shadow-card">
                <Skeleton className="h-3.5 w-3/5" />
                <Skeleton className="mt-2 h-3 w-1/4" />
              </li>
            ))}
          </ul>
        </LoadingBlock>
      )}

      {notifications && notifications.length === 0 && (
        <div className="mt-6">
          <EmptyState title="Nothing here yet">
            You'll be notified when a valuation needs your attention.
          </EmptyState>
        </div>
      )}

      {notifications && notifications.length > 0 && (
        <ul className="mt-6 space-y-2">
          {notifications.map((n) => (
            <li
              key={n.id}
              ref={(el) => {
                if (el) rowRefs.current.set(n.id, el);
                else rowRefs.current.delete(n.id);
              }}
              tabIndex={-1}
              className={`rounded-lg border p-4 shadow-card transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-bond-500 ${
                n.read_at ? 'border-paper-300 bg-surface' : 'border-bond-200 bg-bond-50/50'
              }`}
            >
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    {!n.read_at && (
                      <>
                        <span aria-hidden className="h-2 w-2 shrink-0 rounded-full bg-bond-600" />
                        <span className="sr-only">Unread. </span>
                      </>
                    )}
                    <span className="text-sm font-semibold text-ink-900">{n.title}</span>
                  </div>
                  {n.body && <p className="mt-1 text-sm text-ink-600">{n.body}</p>}
                  <div className="tnum mt-1.5 text-xs text-ink-400">{formatDateTime(n.created_at)}</div>
                </div>
                <div className="flex shrink-0 items-center gap-3">
                  {destinationOf(n) && (
                    <Link
                      to={destinationOf(n)!}
                      aria-label={`Open the page for “${n.title}”`}
                      onClick={() => void markRead(n.id)}
                      className="text-xs font-semibold text-bond-600 hover:text-bond-700"
                    >
                      Open →
                    </Link>
                  )}
                  {!n.read_at && (
                    <button
                      onClick={() => void markRead(n.id)}
                      aria-label={`Mark “${n.title}” as read`}
                      className="tap-area cursor-pointer text-xs font-semibold text-ink-400 hover:text-ink-700"
                    >
                      Mark read
                    </button>
                  )}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
