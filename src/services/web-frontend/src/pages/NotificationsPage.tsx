import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { formatDateTime } from '../lib/format';
import type { AppNotification } from '../lib/types';
import { Button, EmptyState, ErrorNote, LoadingBlock, Skeleton } from '../components/ui';

/** In-app notification center (M4). */
export function NotificationsPage() {
  const [notifications, setNotifications] = useState<AppNotification[] | null>(null);
  const [unread, setUnread] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await api<{ notifications: AppNotification[]; unread_count: number }>('/notifications');
      setNotifications(data.notifications);
      setUnread(data.unread_count);
    } catch {
      setError('Could not load notifications.');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const markRead = async (id: string) => {
    try {
      await api(`/notifications/${id}/read`, { method: 'POST' });
      await load();
    } catch {
      /* non-fatal — the row simply stays unread */
    }
  };

  const markAllRead = async () => {
    try {
      await api('/notifications/read-all', { method: 'POST' });
      await load();
    } catch {
      setError('Could not mark notifications as read.');
    }
  };

  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="overline text-ink-400">Inbox</div>
          <h1 className="mt-1 font-display text-3xl font-semibold text-ink-900">
            Notifications{unread > 0 && <span className="ml-2 text-lg text-bond-600">({unread} unread)</span>}
          </h1>
        </div>
        {unread > 0 && (
          <Button variant="secondary" onClick={markAllRead}>
            Mark all read
          </Button>
        )}
      </div>

      {error && (
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
              className={`rounded-lg border p-4 shadow-card transition-colors ${
                n.read_at ? 'border-paper-300 bg-surface' : 'border-bond-200 bg-bond-50/50'
              }`}
            >
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    {!n.read_at && <span className="h-2 w-2 shrink-0 rounded-full bg-bond-600" />}
                    <span className="text-sm font-semibold text-ink-900">{n.title}</span>
                  </div>
                  {n.body && <p className="mt-1 text-sm text-ink-600">{n.body}</p>}
                  <div className="tnum mt-1.5 text-xs text-ink-400">{formatDateTime(n.created_at)}</div>
                </div>
                <div className="flex shrink-0 items-center gap-3">
                  {n.valuation_id && (
                    <Link
                      to={`/valuations/${n.valuation_id}`}
                      onClick={() => void markRead(n.id)}
                      className="text-xs font-semibold text-bond-600 hover:text-bond-700"
                    >
                      Open →
                    </Link>
                  )}
                  {!n.read_at && (
                    <button
                      onClick={() => void markRead(n.id)}
                      className="cursor-pointer text-xs font-semibold text-ink-400 hover:text-ink-700"
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
