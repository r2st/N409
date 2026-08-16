import type pg from 'pg';
import type { FastifyBaseLogger } from 'fastify';
import { FLAGS, flagEnabled } from '@n409/shared';
import { claimRetryableEmails, settleClaimedEmail } from '../repos/emailOutbox.js';
import { recordSendFailure } from '../repos/emailDelivery.js';
import { EMAIL_MAX_ATTEMPTS } from '../domain/emailRetry.js';
import type { EmailTransport } from './stateChange.js';

/**
 * Retries outbox rows left 'failed' by a transient transport error (SMTP
 * connect refused, timeout, ...). Both the state-change and auto-email send
 * paths already leave a failed row in the outbox for "later retry" — this
 * sweep is that later retry; nothing else ever revisits a 'failed' row.
 *
 * It also picks up rows still sitting on 'queued' past the claim lease. Those
 * are the ones a crash stranded between the outbox INSERT and the transport
 * call — the row exists exactly so the mail is not lost there, but nothing came
 * back for it until this sweep did. See claimRetryableEmails.
 *
 * Rows that have already failed `maxAttempts` times are left alone: past
 * that point a transient-failure retry is unlikely to help, and retrying
 * forever would mask a real, permanent problem (bad address, disabled
 * account) behind an ever-growing attempts counter.
 *
 * *When* a failed row comes back is the ladder in domain/emailRetry.ts, stamped
 * on the row as `next_attempt_at` (0159). Before that this sweep had a ceiling
 * and no schedule, so the attempts were spaced by the sweep interval alone and
 * a message spent all of them inside a single relay outage.
 *
 * The batch is claimed before anything is sent (see claimRetryableEmails), so two
 * sweepers running at once split the backlog instead of both delivering all of
 * it — this function is reachable from the interval, from the ops retry route,
 * and from every instance of the service at the same time.
 */
export async function retryFailedEmails(deps: {
  pool: pg.Pool;
  transport?: EmailTransport;
  smsTransport?: EmailTransport;
  log?: FastifyBaseLogger;
  maxAttempts?: number;
  limit?: number;
  leaseMs?: number;
}): Promise<{ attempted: number; sent: number }> {
  // FLAG_RETRY_LADDERS off stops the sweep *claiming*, which is what makes this
  // a pause rather than a loss: nothing is claimed, so nothing has its attempt
  // counter spent or its lease taken, and every row sits exactly where it is
  // with its ladder intact. Turning the flag back on resumes the backlog from
  // where it stopped.
  //
  // Checked here rather than at the interval in index.ts because this function
  // is reachable three ways — the timer, the ops retry route, and any future
  // caller — and a kill switch that only covers one of them is not one.
  if (!flagEnabled(FLAGS.retryLadders)) return { attempted: 0, sent: 0 };

  const channels: Array<'email' | 'sms'> = [];
  if (deps.transport) channels.push('email');
  if (deps.smsTransport) channels.push('sms');

  // One ceiling for both halves. The claim refuses a row past it and the
  // settle stops scheduling at the same number, so "out of attempts" is one
  // fact rather than two that can disagree — a schedule stamped past the
  // ceiling would be a row waiting for a sweep that will never take it.
  const maxAttempts = deps.maxAttempts ?? EMAIL_MAX_ATTEMPTS;
  const claimed = await claimRetryableEmails(deps.pool, {
    channels,
    maxAttempts,
    limit: deps.limit,
    leaseMs: deps.leaseMs,
  });

  let sent = 0;
  for (const email of claimed) {
    const transport = email.channel === 'sms' ? deps.smsTransport : deps.transport;
    // The claim filters by channel, so this is belt-and-braces.
    if (!transport) continue;
    try {
      await transport.send(email);
      await settleClaimedEmail(deps.pool, email.id, 'sent', undefined, { maxAttempts });
      sent += 1;
    } catch (err) {
      await settleClaimedEmail(
        deps.pool,
        email.id,
        'failed',
        err instanceof Error ? err.message : String(err),
        { maxAttempts },
      );
      // A permanent rejection of the recipient takes the row out of the claim
      // and the address out of future sends (0163). Never allowed to throw:
      // the row is already settled, and losing the sweep over the bookkeeping
      // would strand every remaining claimed message.
      const bounce = await recordSendFailure(deps.pool, email, err).catch((bookErr: unknown) => {
        deps.log?.warn({ err: bookErr, emailId: email.id }, 'could not record bounce');
        return null;
      });
      deps.log?.warn(
        { err, emailId: email.id, attempts: email.attempts, bounce },
        'email retry failed',
      );
    }
  }
  return { attempted: claimed.length, sent };
}
