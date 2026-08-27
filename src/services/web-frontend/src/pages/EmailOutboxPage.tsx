import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import { useLatestOnly } from '../lib/useLatestOnly';
import { useClearOnChange } from '../lib/useClearOnChange';
import { formatDateTime } from '../lib/format';
import type { DeliveryState, OutboxEmail, OutboxStatus } from '../lib/types';
import { Button, EmptyState, ErrorNote, LoadingBlock, SkeletonTable } from '../components/ui';
import { SuppressionList } from '../components/SuppressionList';

/**
 * `sent` is deliberately not green. It means the relay accepted the message,
 * which is not the same fact as the recipient having it — the distinction
 * migration 0163 exists to draw. Green is reserved for the states that are
 * evidence of arrival.
 */
const DELIVERY_STYLES: Record<DeliveryState, string> = {
  queued: 'bg-amber-50 text-amber-800 border-amber-200',
  sent: 'bg-sky-50 text-sky-800 border-sky-200',
  delivered: 'bg-emerald-50 text-emerald-800 border-emerald-200',
  opened: 'bg-emerald-50 text-emerald-800 border-emerald-200',
  bounced: 'bg-red-50 text-red-700 border-red-200',
  complained: 'bg-red-50 text-red-700 border-red-200',
  failed: 'bg-red-50 text-red-700 border-red-200',
  skipped: 'bg-paper-200 text-ink-600 border-paper-300',
};

/** What each state is evidence of, for the operator who has to act on it. */
const DELIVERY_TITLES: Record<DeliveryState, string> = {
  queued: 'Waiting for the outbox worker.',
  sent: 'Accepted by the relay. No confirmation of mailbox delivery yet.',
  delivered: 'Confirmed delivered to the mailbox.',
  opened: 'Delivered, and the tracking pixel was fetched at least once.',
  bounced: 'Rejected by the recipient’s mail system.',
  complained: 'Reported as spam by the recipient. The address is suppressed.',
  failed: 'The platform could not hand the message to the relay.',
  skipped: 'Not sent — the address is suppressed.',
};

function DeliveryBadge({ email }: { email: OutboxEmail }) {
  // Fall back to the platform status when the field is absent, which is only
  // a response cached from a build older than the derivation.
  const state: DeliveryState = email.delivery_state ?? email.status;
  return (
    <span
      title={DELIVERY_TITLES[state]}
      className={`inline-block rounded-full border px-2.5 py-0.5 text-xs font-semibold ${DELIVERY_STYLES[state]}`}
    >
      {state[0]!.toUpperCase() + state.slice(1)}
    </span>
  );
}

/** Ops window into the transactional email outbox (P0 #1; API from P1 #21). */
export function EmailOutboxPage() {
  const [emails, setEmails] = useState<OutboxEmail[] | null>(null);
  const [scope, setScope] = useState<OutboxStatus | 'all'>('all');
  const [error, setError] = useState<string | null>(null);

  /*
   * The scope filter re-issues this without waiting, so two scopes can be
   * outstanding at once and the slower reply wins. What that shows is a set of
   * queued or failed emails filed under a status none of them has. See
   * `useLatestOnly`.
   */
  const claim = useLatestOnly();

  const load = useCallback(async () => {
    const current = claim();
    try {
      const qs = scope === 'all' ? '' : `?status=${scope}`;
      const { emails: items } = await api<{ emails: OutboxEmail[] }>(`/admin/email-outbox${qs}`);
      if (!current()) return;
      setEmails(items);
    } catch (err) {
      if (!current()) return;
      setError(
        err instanceof ApiError && err.status === 403
          ? 'The email outbox is operations-only.'
          : 'Could not load the email outbox.',
      );
    }
  }, [scope, claim]);

  // The scope chips are the question; the table is the answer to it. Without
  // this the previous scope's rows sit under the newly pressed chip for a
  // whole round trip, unmarked. See `useClearOnChange`.
  useClearOnChange(scope, () => setEmails(null));

  useEffect(() => {
    void load();
  }, [load]);

  /*
   * The wait replaces the answer, not the page. Returning a bare `<Spinner />`
   * from here took the scope chips with it, so pressing Failed blanked the
   * screen the user had just filtered — no way to see which scope was selected,
   * and no way to change their mind without waiting for a request they no
   * longer wanted. The header and the filters are the same whatever the answer
   * turns out to be, so they render either way and only the table swaps.
   */
  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="overline text-ink-400">Operations</div>
          <h1 className="mt-1 font-display text-3xl font-semibold text-ink-900">Email outbox</h1>
          <p className="mt-1 text-sm text-ink-400">
            Transactional emails queued by workflow events. Failed sends are retried automatically by the
            outbox worker. The filters below select on what the platform did with a message; the delivery
            column shows what became of it, which is not the same fact — a message the relay accepted can
            still bounce.
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

      {!emails ? (
        // A load that failed has reported itself above; a skeleton beside that
        // note would be a wait with nothing behind it, running forever.
        !error && (
          <div className="mt-6">
            <LoadingBlock label={scope === 'all' ? 'Loading emails…' : `Loading ${scope} emails…`}>
              <SkeletonTable columns={7} rows={6} />
            </LoadingBlock>
          </div>
        )
      ) : emails.length === 0 ? (
        <div className="mt-6">
          <EmptyState title={scope === 'all' ? 'The outbox is empty' : `No ${scope} emails`}>
            Workflow emails appear here as they are queued and delivered.
          </EmptyState>
        </div>
      ) : (
        <div className="mt-6 overflow-x-auto overscroll-x-contain rounded-lg border border-paper-300 bg-surface shadow-card">
          <table className="w-full min-w-[860px] text-sm" aria-label="Email outbox">
            <thead>
              <tr className="border-b border-paper-300 text-left">
                <th className="overline px-5 py-3 font-semibold text-ink-400">Recipient</th>
                <th className="overline px-4 py-3 font-semibold text-ink-400">Template</th>
                <th className="overline px-4 py-3 font-semibold text-ink-400">Subject</th>
                <th className="overline px-4 py-3 font-semibold text-ink-400">Delivery</th>
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
                    <DeliveryBadge email={e} />
                    {e.error && (
                      <div className="mt-1 max-w-52 text-xs text-red-600" title={e.error}>
                        <span className="line-clamp-2">{e.error}</span>
                      </div>
                    )}
                    {/*
                      Why it bounced, in the recipient's mail system's own
                      words. The kind decides what happens next — hard and
                      complaint suppress the address and end the retry ladder,
                      soft leaves it running — so it is named, not just colored.
                    */}
                    {e.bounce_kind && (
                      <div className="mt-1 max-w-52 text-xs text-red-600">
                        <span className="font-semibold">{e.bounce_kind} bounce</span>
                        {e.bounce_detail && (
                          <span className="line-clamp-2" title={e.bounce_detail}>
                            {e.bounce_detail}
                          </span>
                        )}
                      </div>
                    )}
                  </td>
                  <td className="tnum px-4 py-3.5 text-right text-ink-600">{e.attempts}</td>
                  <td className="tnum px-4 py-3.5 text-ink-600">{formatDateTime(e.created_at)}</td>
                  <td className="tnum px-4 py-3.5 text-ink-600">
                    {formatDateTime(e.sent_at)}
                    {e.delivered_at && (
                      <div className="mt-1 text-xs text-ink-500">
                        Delivered {formatDateTime(e.delivered_at)}
                      </div>
                    )}
                    {e.open_count !== undefined && e.open_count > 0 && (
                      // A floor, not a count: image blockers hide real opens and
                      // caching proxies invent them. Never a per-person figure.
                      <div
                        className="mt-1 text-xs text-ink-500"
                        title="Tracking-pixel fetches — a floor, not a count of readers."
                      >
                        Opened {e.open_count}×
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/*
       * The recovery path for a `skipped` row above. It is on this page rather
       * than a page of its own because the two are read in one motion: the
       * reason to look at the suppression list is a message the platform
       * declined to send, and that message is in the table.
       */}
      <SuppressionList />
    </div>
  );
}
