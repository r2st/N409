import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError, describeLoadFailure } from '../lib/api';
import { useLatestOnly } from '../lib/useLatestOnly';
import { useClearOnChange } from '../lib/useClearOnChange';
import { formatDateTime } from '../lib/format';
import type { BounceKind, DeliveryState, OutboxEmail, OutboxStatus } from '../lib/types';
import {
  Button,
  EmptyState,
  ErrorNote,
  LoadError,
  LoadingBlock,
  SkeletonTable,
  SkeletonStatStrip,
  StatCard,
  SuccessNote,
} from '../components/ui';
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

/** `/admin/email/delivery-stats` — the window's counts, its derived rates, and
 *  the per-template breakdown behind them. */
interface DeliveryStats {
  totals: {
    window_days: number;
    total: number;
    queued: number;
    sent: number;
    failed: number;
    skipped: number;
    delivered: number;
    bounced: number;
    complained: number;
    opened: number;
    suppressed_addresses: number;
  };
  /**
   * Null below the server's sample floor rather than zero — see the route.
   * A tile that renders `null` as "0%" reports an outage that is not happening,
   * so every reader here has to keep the two apart.
   */
  rates: {
    delivered: number | null;
    bounced: number | null;
    opened: number | null;
    send_failure: number | null;
  };
  by_template: Array<{
    template_key: string;
    total: number;
    delivered: number;
    bounced: number;
    failed: number;
  }>;
}

type DeliveryEventKind = 'delivered' | 'bounced' | 'complained' | 'deferred' | 'opened';

/** One line of the delivery ledger (migration 0163), newest first. */
interface DeliveryEvent {
  id: string;
  kind: DeliveryEventKind;
  occurred_at: string;
  received_at: string;
  /** 'webhook:<provider>', 'dsn', or 'pixel' — who told us. */
  source: string;
  bounce_kind: BounceKind | null;
  detail: string | null;
}

/** A rate the server declined to derive is "—", never "0%". */
function percent(rate: number | null): string {
  return rate === null ? '—' : `${(rate * 100).toFixed(1)}%`;
}

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

const EVENT_STYLES: Record<DeliveryEventKind, string> = {
  delivered: 'text-emerald-700',
  opened: 'text-emerald-700',
  bounced: 'text-red-600',
  complained: 'text-red-600',
  deferred: 'text-amber-700',
};

/**
 * The delivery ledger for one message, on demand.
 *
 * The row above shows the *state* — the one fact the server derived from these
 * events. That is the right summary and the wrong thing to hand somebody
 * arguing with a mail administrator, who needs the provider's own words, when
 * each signal arrived, and how many times. `/admin/email-outbox/:id/delivery-
 * events` has served exactly that since migration 0163 and nothing asked for
 * it.
 *
 * Fetched on first open rather than with the listing: a page of 50 rows would
 * otherwise be 51 requests to draw a column nobody has expanded.
 */
function DeliveryTrail({ email }: { email: OutboxEmail }) {
  const [open, setOpen] = useState(false);
  const [events, setEvents] = useState<DeliveryEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const toggle = async () => {
    const next = !open;
    setOpen(next);
    if (!next || events !== null) return;
    setLoading(true);
    setError(null);
    try {
      const res = await api<{ events: DeliveryEvent[] }>(`/admin/email-outbox/${email.id}/delivery-events`);
      setEvents(res.events);
    } catch (err) {
      setError(describeLoadFailure(err, 'Could not load the delivery trail.'));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="mt-1.5">
      <button
        type="button"
        onClick={() => void toggle()}
        aria-expanded={open}
        className="tap-area cursor-pointer text-xs font-semibold text-bond-600 hover:text-bond-700"
      >
        {open ? 'Hide delivery trail' : 'Delivery trail'}
      </button>
      {open && (
        <div className="mt-1.5">
          {loading && (
            <p role="status" className="text-xs text-ink-400">
              Loading the delivery trail…
            </p>
          )}
          {/* A live region, not just red text: this appears after the reader
              pressed "Delivery trail", by which point focus is on that button
              and nothing would say the fetch had failed. */}
          {error && (
            <p role="alert" className="text-xs text-red-600">
              {error}
            </p>
          )}
          {events !== null && events.length === 0 && !error && (
            <p className="text-xs text-ink-400">
              Nothing reported back yet — the relay accepted it and no provider signal has arrived.
            </p>
          )}
          {events !== null && events.length > 0 && (
            <ul className="space-y-1">
              {events.map((ev) => (
                <li key={ev.id} className="text-xs text-ink-500">
                  <span className={`font-semibold ${EVENT_STYLES[ev.kind]}`}>{ev.kind}</span>{' '}
                  <span className="tnum">{formatDateTime(ev.occurred_at)}</span>
                  {/* Whose word this is. A pixel fetch and a provider webhook
                      are not equally good evidence, and only the source says
                      which one this line is. */}
                  <span className="text-ink-400"> · {ev.source}</span>
                  {ev.bounce_kind && <span className="text-red-600"> · {ev.bounce_kind}</span>}
                  {ev.detail && <span className="text-ink-400"> · {ev.detail}</span>}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

/** Ops window into the transactional email outbox (P0 #1; API from P1 #21). */
export function EmailOutboxPage() {
  const [emails, setEmails] = useState<OutboxEmail[] | null>(null);
  const [scope, setScope] = useState<OutboxStatus | 'all'>('all');
  const [error, setError] = useState<string | null>(null);
  const [stats, setStats] = useState<DeliveryStats | null>(null);
  const [statsError, setStatsError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);
  const [retryNote, setRetryNote] = useState<string | null>(null);
  const [retryError, setRetryError] = useState<string | null>(null);

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

  /*
   * The window totals are asked over the whole outbox, not the selected scope,
   * so they are loaded once rather than re-fetched by every chip. Their own
   * error slot for the same reason: a stats outage must not blank the table,
   * and a table outage must not claim the rates are unknown.
   */
  const loadStats = useCallback(async () => {
    try {
      const res = await api<DeliveryStats>('/admin/email/delivery-stats?days=30');
      // Shape-checked at the boundary rather than trusted into the render. A
      // body without `totals` is a deployment mismatch, and reaching for
      // `totals.failed` on one takes the whole page down — the table, the
      // filters and the suppression list included — over a panel that is not
      // even the reason anybody opened it.
      if (!res || typeof res.totals !== 'object' || res.totals === null) {
        setStats(null);
        setStatsError('Delivery statistics came back in a shape this page cannot read.');
        return;
      }
      setStats(res);
      setStatsError(null);
    } catch (err) {
      setStatsError(describeLoadFailure(err, 'Could not load delivery statistics.'));
    }
  }, []);

  // The scope chips are the question; the table is the answer to it. Without
  // this the previous scope's rows sit under the newly pressed chip for a
  // whole round trip, unmarked. See `useClearOnChange`.
  useClearOnChange(scope, () => setEmails(null));

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    void loadStats();
  }, [loadStats]);

  /**
   * Run the retry sweep now.
   *
   * `POST /admin/outbox/retry` is the same code path the interval runs, and it
   * existed with no caller: an operator who has just fixed the relay had to
   * wait out the sweep to find out whether the fix worked. The result is
   * announced rather than merely reloaded — "attempted 4, sent 4" and
   * "attempted 4, sent 0" leave the table looking identical for the seconds
   * before the states settle, and they mean opposite things.
   *
   * `retired` IS THE HALF OF THE ANSWER THIS BUTTON WAS THROWING AWAY (R414,
   * methodology M5). `retryFailedEmails` returns four numbers and says in its
   * own closing comment why the last two are carried rather than derived:
   * "`retired` is the ladder giving up on a row for good — the only tally here
   * that nothing else ever revisits". The one human-facing reader of that
   * response read `attempted` and `sent`, so the pass in which the sweep
   * permanently abandoned a batch of messages announced itself with a sentence
   * about the messages it *did* send.
   *
   * The worst reading is the empty one. `retireStrandedEmails` runs *before*
   * the claim, so a sweep can retire twenty rows and then claim nothing — and
   * this said "Nothing was eligible for retry." about a pass that had just
   * ended twenty messages for good. That is not a smaller version of the
   * truth; it is the opposite of it, on the screen an operator presses when
   * they have just fixed the relay and want to know what is still owed.
   *
   * Read defensively (`?? 0`) for `ComparablesTab`'s reason: a tab served by
   * an older build must not render `undefined` into the note.
   */
  const retryFailed = async () => {
    setRetrying(true);
    setRetryNote(null);
    setRetryError(null);
    try {
      // `failed` is on the response too and is not read: within one answer it
      // is `attempted - sent`, which the sentence below already states. The
      // server carries it because a *counter series* cannot be subtracted that
      // way, which is a fact about alerting rather than about this note.
      const res = await api<{ attempted: number; sent: number; retired?: number }>(
        '/admin/outbox/retry',
        { method: 'POST' },
      );
      const retired = res.retired ?? 0;
      // Spelled out rather than left to the table: a retired row lands in the
      // same 'failed' status as one that is still on its ladder, so the list
      // behind this note cannot tell an operator which of the two they are
      // looking at.
      const givenUp =
        retired > 0
          ? ` ${retired} message${retired === 1 ? ' had' : 's had'} spent every attempt and ` +
            `${retired === 1 ? 'was' : 'were'} given up on for good — ${
              retired === 1 ? 'it' : 'they'
            } will never send.`
          : '';
      setRetryNote(
        (res.attempted === 0
          ? // "Nothing was eligible" is a claim about the whole pass, and it is
            // false when the retirement half of it settled rows. Only the claim
            // came back empty.
            retired === 0
            ? 'Nothing was eligible for retry.'
            : 'Nothing was left to retry.'
          : `Retried ${res.attempted} message${res.attempted === 1 ? '' : 's'} — ${res.sent} sent.`) +
          givenUp,
      );
      await Promise.all([load(), loadStats()]);
    } catch (err) {
      setRetryError(
        err instanceof ApiError && err.status === 403
          ? 'Retrying the outbox is operations-only.'
          : 'Could not retry the failed messages.',
      );
    } finally {
      setRetrying(false);
    }
  };

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
        <div className="flex gap-2">
          <Button variant="secondary" onClick={() => void load()}>
            Refresh
          </Button>
          {/* Failed rows are already retried by the outbox worker's sweep; this
              is the same sweep, now. Disabled when nothing has failed, and the
              tooltip says so rather than leaving a dead control. */}
          <Button
            variant="secondary"
            disabled={retrying || stats?.totals.failed === 0}
            title={
              stats?.totals.failed === 0
                ? 'No failed messages in the last 30 days.'
                : 'Run the retry sweep now instead of waiting for the outbox worker.'
            }
            onClick={() => void retryFailed()}
          >
            {retrying ? 'Retrying…' : 'Retry failed now'}
          </Button>
        </div>
      </div>

      {retryNote && (
        <div className="mt-4">
          <SuccessNote>{retryNote}</SuccessNote>
        </div>
      )}
      {retryError && (
        <div className="mt-4">
          <ErrorNote>{retryError}</ErrorNote>
        </div>
      )}

      {/* ── Delivery statistics ─────────────────────────────────────────────
          Counts say what the outbox did; the rates say whether it worked. Both
          have been served by `/admin/email/delivery-stats` all along with
          nowhere to land, which left the only answer to "is mail getting
          through" a manual read of the table below. */}
      {statsError ? (
        <div className="mt-6">
          <ErrorNote>{statsError}</ErrorNote>
        </div>
      ) : !stats ? (
        <div className="mt-6">
          <LoadingBlock label="Loading delivery statistics…">
            <SkeletonStatStrip count={4} />
          </LoadingBlock>
        </div>
      ) : (
        <section className="mt-6" aria-label="Delivery statistics">
          <h2 className="overline text-ink-400">Last {stats.totals.window_days} days</h2>
          <div className="mt-3 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard
              label="Delivered"
              value={percent(stats.rates.delivered)}
              hint={`${stats.totals.delivered} of ${stats.totals.sent} handed to the relay`}
            />
            <StatCard
              label="Bounced or complained"
              value={percent(stats.rates.bounced)}
              hint={`${stats.totals.bounced} bounced · ${stats.totals.complained} complaints`}
            />
            <StatCard
              label="Send failures"
              value={percent(stats.rates.send_failure)}
              hint={`${stats.totals.failed} never reached the relay`}
            />
            <StatCard
              label="Suppressed addresses"
              value={String(stats.totals.suppressed_addresses)}
              hint={`${stats.totals.skipped} messages skipped in the window`}
            />
          </div>
          {stats.by_template.length > 0 && (
            <details className="mt-4 rounded-lg border border-paper-300 bg-surface px-5 py-3 shadow-card">
              <summary className="tap-area cursor-pointer text-sm font-semibold text-ink-700">
                By template ({stats.by_template.length})
              </summary>
              <div className="mt-3 overflow-x-auto overscroll-x-contain">
                <table className="w-full min-w-[520px] text-sm" aria-label="Delivery by template">
                  <thead>
                    <tr className="border-b border-paper-300 text-left">
                      <th className="overline px-2 py-2 font-semibold text-ink-400">Template</th>
                      <th className="overline px-2 py-2 text-right font-semibold text-ink-400">Sent</th>
                      <th className="overline px-2 py-2 text-right font-semibold text-ink-400">Delivered</th>
                      <th className="overline px-2 py-2 text-right font-semibold text-ink-400">Bounced</th>
                      <th className="overline px-2 py-2 text-right font-semibold text-ink-400">Failed</th>
                    </tr>
                  </thead>
                  <tbody>
                    {stats.by_template.map((t) => (
                      <tr key={t.template_key} className="border-b border-paper-200 last:border-0">
                        <td className="px-2 py-2 font-mono text-xs text-ink-600">{t.template_key}</td>
                        <td className="tnum px-2 py-2 text-right text-ink-600">{t.total}</td>
                        <td className="tnum px-2 py-2 text-right text-ink-600">{t.delivered}</td>
                        <td className="tnum px-2 py-2 text-right text-ink-600">{t.bounced}</td>
                        <td className="tnum px-2 py-2 text-right text-ink-600">{t.failed}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          )}
        </section>
      )}

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

      {error && !emails && (
        <div className="mt-4">
          <LoadError message={error} onRetry={() => { setError(null); void load(); }} />
        </div>
      )}
      {error && emails && (
        <div className="mt-4">
          <ErrorNote>{error}</ErrorNote>
        </div>
      )}

      {!emails ? (
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
                    <DeliveryTrail email={e} />
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
