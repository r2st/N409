import { logFailure, logUnretried, type FailureLogger } from '@n409/shared';
import { ReconnectRequiredError } from '../clients/deadline.js';
import type { IntegrationFamily } from '../events/integrationEvents.js';

/**
 * What a failed connector sync writes to the log, at the level the failure
 * earned.
 *
 * Since R252 a sync failure is two different events wearing one word. A 503, a
 * timeout or a 429 puts the connection on the backoff `recordSyncError` sets —
 * 15m, 30m, 1h, up to 8h — and the sweep comes back on its own. A
 * `ReconnectRequiredError` sets `next_sync_at = NULL` and
 * `reconnect_required = true`: no sweep will ever pick that row up again, the
 * schedule the client chose is over, and the only thing that changes it is a
 * person clicking Reconnect.
 *
 * Both were `log.warn({ err, connectionId }, 'scheduled … sync failed')`, which
 * is wrong in the one way this estate has written down. `shared/failure.ts`
 * says what `warn` promises: transient is `warn` *because the retry is going to
 * handle it*. For the terminal arm there is no retry, and the row it left
 * behind says so. So the two lines a person needs to tell apart — "a provider
 * was briefly unwell" and "this engagement's payroll feed is dead until
 * somebody re-authorises it" — were the same line, at the same level, with no
 * field between them, and the only other notice of the second is a pill on a
 * panel nobody is looking at.
 *
 * The classification is not left to `classifyFailure` here. It cannot answer
 * this: the terminal/transient split is a decision *this* code already made,
 * one statement earlier, when it passed `terminal` to `recordSyncError` — and
 * the same `invalid_grant` 400 that is terminal for a token endpoint is an
 * ordinary permanent failure anywhere else. `logUnretried` exists for exactly
 * this shape, work nothing will come back for, and stamps `retried: false`
 * beside the `alert: true`.
 *
 * The subject travels with the line for the reason `logSubjectCensus` states:
 * "is this one engagement or the whole book" is the first question asked of a
 * spike, and a `connectionId` alone is answerable only through the database.
 */
export interface ConnectorSyncSubject {
  family: IntegrationFamily;
  provider: string;
  connectionId: string;
  valuationId: string;
  /**
   * Consecutive failures *before* this one, as the caller read them off the
   * row. What it buys is the shape neither level can show on its own: a
   * connection failing transiently for the eighth time is on the eight-hour
   * step of the backoff and has been broken for a day and a half, which reads
   * from the log as eight ordinary warns spread over that day and a half.
   */
  priorFailures?: number;
}

const FAMILY_LABEL: Record<IntegrationFamily, string> = {
  hris: 'HRIS',
  cap_table: 'cap-table',
  accounting: 'accounting',
};

/**
 * Log a connector sync/import failure.
 *
 * `scheduled` says which door this came through, and is a field rather than a
 * separate function because the two doors differ in exactly one respect a
 * reader cares about: an unattended tick has nobody to tell, and a manual pull
 * answered a person who is looking at the screen. The terminal arm alerts from
 * either — the connection is equally dead, and what the analyst saw was one
 * 422.
 */
export function logConnectorSyncFailure(
  log: FailureLogger,
  err: unknown,
  subject: ConnectorSyncSubject,
  opts: { scheduled: boolean },
): void {
  const label = FAMILY_LABEL[subject.family];
  const context: Record<string, unknown> = {
    connectionId: subject.connectionId,
    valuationId: subject.valuationId,
    family: subject.family,
    provider: subject.provider,
    scheduled: opts.scheduled,
    ...(subject.priorFailures === undefined ? {} : { priorFailures: subject.priorFailures }),
  };
  if (err instanceof ReconnectRequiredError) {
    logUnretried(
      log,
      err,
      { ...context, reconnect_required: true },
      `${label} connection needs reconnecting — its schedule has stopped`,
    );
    return;
  }
  // Everything else takes the classifier's answer, warn/error split and all.
  // A *permanent* failure that is not terminal — a driver error from the
  // import loop, a provider 404 — does get another attempt on the backoff, so
  // this is not quite the "no retry is coming" the contract describes; it is
  // the nearer of the two answers, because that attempt will fail identically
  // and the thing that clears it is still a person.
  logFailure(log, err, context, `${opts.scheduled ? 'scheduled ' : ''}${label} sync failed`);
}
