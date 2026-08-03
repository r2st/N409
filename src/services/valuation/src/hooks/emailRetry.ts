import type pg from 'pg';
import type { FastifyBaseLogger } from 'fastify';
import { claimRetryableEmails, settleClaimedEmail } from '../repos/emailOutbox.js';
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
  const channels: Array<'email' | 'sms'> = [];
  if (deps.transport) channels.push('email');
  if (deps.smsTransport) channels.push('sms');

  const claimed = await claimRetryableEmails(deps.pool, {
    channels,
    maxAttempts: deps.maxAttempts ?? 5,
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
      await settleClaimedEmail(deps.pool, email.id, 'sent');
      sent += 1;
    } catch (err) {
      await settleClaimedEmail(
        deps.pool,
        email.id,
        'failed',
        err instanceof Error ? err.message : String(err),
      );
      deps.log?.warn({ err, emailId: email.id, attempts: email.attempts }, 'email retry failed');
    }
  }
  return { attempted: claimed.length, sent };
}
