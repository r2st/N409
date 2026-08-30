import type pg from 'pg';
import type { FastifyBaseLogger } from 'fastify';
import { describeTransportFailure, flagEnabled, FLAGS } from '@n409/shared';
import { claimRetryableEmails, settleClaimedEmail } from '../repos/emailOutbox.js';
import { recordSendFailure } from '../repos/emailDelivery.js';
import { EMAIL_MAX_ATTEMPTS } from '../domain/emailRetry.js';
import { sendAndRecord } from '../email/sendAttempt.js';
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
    // A settle is a database write standing after a send that has already
    // happened, and until R228 it shared a `catch` with the send itself: a blip
    // on that one UPDATE was recorded as the relay refusing the message, which
    // put a delivered row back on the ladder to be delivered again. The two
    // halves are separate callbacks now — see email/sendAttempt.ts.
    const outcome = await sendAndRecord(transport, email, {
      log: deps.log,
      context: { originRequestId: email.request_id, attempts: email.attempts },
      onSent: async () => {
        // `email.attempts` is the count the claim stamped on this row. A settle
        // that matches nothing means a second sweeper re-claimed the row while
        // this send was in flight and has already settled it — see
        // `settleClaimedEmail`. Counted as sent all the same, because it was.
        const settled = await settleClaimedEmail(deps.pool, email.id, 'sent', undefined, email.attempts, {
          maxAttempts,
        });
        if (!settled) {
          deps.log?.warn(
            { emailId: email.id, originRequestId: email.request_id, attempts: email.attempts },
            'email sent on a claim another sweeper had already taken over — outcome not recorded',
          );
        }
      },
      onFailed: async (err) => {
        const settled = await settleClaimedEmail(
          deps.pool,
          email.id,
          'failed',
          describeTransportFailure(err),
          email.attempts,
          { maxAttempts },
        ).catch((settleErr: unknown) => {
          // The rest of this batch is nothing to do with this row, and a claim is
          // up to five hundred messages: letting a settle failure out of the loop
          // strands every one of them holding a lease and one attempt poorer for
          // a send nobody tried.
          deps.log?.error(
            { err: settleErr, cause: err, emailId: email.id },
            'could not settle a failed send; outbox row left claimed for the next sweep',
          );
          return true;
        });
        // The row has moved on: another sweeper owns it, and writing this failure
        // over its outcome is precisely what the pin refuses. The bounce below is
        // still recorded — a hard rejection is a fact about the *address*, not
        // about this claim, and it has to reach the suppression list either way.
        if (!settled) {
          deps.log?.warn(
            { emailId: email.id, originRequestId: email.request_id, attempts: email.attempts },
            'email retry failed on a claim another sweeper had already taken over',
          );
        }
        // A permanent rejection of the recipient takes the row out of the claim
        // and the address out of future sends (0163). Never allowed to throw:
        // the row is already settled, and losing the sweep over the bookkeeping
        // would strand every remaining claimed message.
        const bounce = await recordSendFailure(deps.pool, email, err).catch((bookErr: unknown) => {
          deps.log?.warn({ err: bookErr, emailId: email.id }, 'could not record bounce');
          return null;
        });
        // `originRequestId` is the row's own `request_id` (migration 0185): the
        // request that queued this message, which for a receipt is the Stripe
        // webhook delivery that took the money. This line is written under a
        // sweep and so carries no `requestId` of its own — correctly, nobody
        // asked for it — and this is the field that reaches back across the
        // handoff to the request that did.
        deps.log?.warn(
          {
            err,
            emailId: email.id,
            originRequestId: email.request_id,
            attempts: email.attempts,
            bounce,
          },
          'email retry failed',
        );
      },
    });
    // 'unrecorded' counts too: the message left the building, which is what
    // this number reports. The row not saying so is the line logged above.
    if (outcome !== 'failed') sent += 1;
  }
  return { attempted: claimed.length, sent };
}
