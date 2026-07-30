import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import { formatDateTime } from '../lib/format';
import type { OutboxEmail, OutboxStatus } from '../lib/types';
import { Button, EmptyState, ErrorNote, Spinner } from '../components/ui';

const STATUS_STYLES: Record<OutboxStatus, string> = {
  queued: 'bg-amber-50 text-amber-800 border-amber-200',
  sent: 'bg-emerald-50 text-emerald-800 border-emerald-200',
  failed: 'bg-red-50 text-red-700 border-red-200',
  skipped: 'bg-paper-200 text-ink-600 border-paper-300',
};

function StatusBadge({ status }: { status: OutboxStatus }) {
  return (
    <span
      className={`inline-block rounded-full border px-2.5 py-0.5 text-xs font-semibold ${STATUS_STYLES[status]}`}
    >
      {status[0]!.toUpperCase() + status.slice(1)}
    </span>
  );
}

/** Ops window into the transactional email outbox (P0 #1; API from P1 #21). */
export function EmailOutboxPage() {
  const [emails, setEmails] = useState<OutboxEmail[] | null>(null);
  const [scope, setScope] = useState<OutboxStatus | 'all'>('all');
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const qs = scope === 'all' ? '' : `?status=${scope}`;
      const { emails: items } = await api<{ emails: OutboxEmail[] }>(`/admin/email-outbox${qs}`);
      setEmails(items);
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 403
          ? 'The email outbox is operations-only.'
          : 'Could not load the email outbox.',
      );
    }
  }, [scope]);

  useEffect(() => {
    void load();
  }, [load]);

  if (error && !emails) return <ErrorNote>{error}</ErrorNote>;
  if (!emails) return <Spinner />;

  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="overline text-ink-400">Operations</div>
          <h1 className="mt-1 font-display text-3xl font-semibold text-ink-900">Email outbox</h1>
          <p className="mt-1 text-sm text-ink-400">
            Transactional emails queued by workflow events. Failed sends are retried automatically
            by the outbox worker.
          </p>
        </div>
        <Button variant="secondary" onClick={() => void load()}>
          Refresh
        </Button>
      </div>

      <div className="mt-6 flex flex-wrap gap-2">
        {(['all', 'queued', 'sent', 'failed', 'skipped'] as const).map((s) => (
          <button
            key={s}
            onClick={() => setScope(s)}
            className={`cursor-pointer rounded-full px-3.5 py-1.5 text-xs font-semibold transition-colors ${
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

      {emails.length === 0 ? (
        <div className="mt-6">
          <EmptyState title={scope === 'all' ? 'The outbox is empty' : `No ${scope} emails`}>
            Workflow emails appear here as they are queued and delivered.
          </EmptyState>
        </div>
      ) : (
        <div className="mt-6 overflow-x-auto rounded-lg border border-paper-300 bg-surface shadow-card">
          <table className="w-full min-w-[860px] text-sm" aria-label="Email outbox">
            <thead>
              <tr className="border-b border-paper-300 text-left">
                <th className="overline px-5 py-3 font-semibold text-ink-400">Recipient</th>
                <th className="overline px-4 py-3 font-semibold text-ink-400">Template</th>
                <th className="overline px-4 py-3 font-semibold text-ink-400">Subject</th>
                <th className="overline px-4 py-3 font-semibold text-ink-400">Status</th>
                <th className="overline px-4 py-3 text-right font-semibold text-ink-400">Attempts</th>
                <th className="overline px-4 py-3 font-semibold text-ink-400">Queued</th>
                <th className="overline px-4 py-3 font-semibold text-ink-400">Sent</th>
              </tr>
            </thead>
            <tbody>
              {emails.map((e) => (
                <tr key={e.id} className="border-b border-paper-200 last:border-0 align-top">
                  <td className="px-5 py-3.5 text-ink-900">{e.to_email}</td>
                  <td className="px-4 py-3.5 font-mono text-xs text-ink-500">
                    {e.template_key}
                    {e.valuation_id && (
                      <div className="mt-1">
                        <Link
                          to={`/valuations/${e.valuation_id}`}
                          className="font-sans font-semibold text-bond-600 hover:text-bond-700"
                        >
                          View valuation →
                        </Link>
                      </div>
                    )}
                  </td>
                  <td className="max-w-64 px-4 py-3.5 text-ink-600">
                    <div className="truncate" title={e.subject}>
                      {e.subject}
                    </div>
                  </td>
                  <td className="px-4 py-3.5">
                    <StatusBadge status={e.status} />
                    {e.error && (
                      <div className="mt-1 max-w-52 text-xs text-red-600" title={e.error}>
                        <span className="line-clamp-2">{e.error}</span>
                      </div>
                    )}
                  </td>
                  <td className="tnum px-4 py-3.5 text-right text-ink-600">{e.attempts}</td>
                  <td className="tnum px-4 py-3.5 text-ink-600">{formatDateTime(e.created_at)}</td>
                  <td className="tnum px-4 py-3.5 text-ink-600">{formatDateTime(e.sent_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
