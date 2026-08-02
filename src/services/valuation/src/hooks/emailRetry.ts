import type pg from 'pg';
import type { FastifyBaseLogger } from 'fastify';
import { claimFailedEmails, settleClaimedEmail } from '../repos/emailOutbox.js';
import type { EmailTransport } from './stateChange.js';

/**
 * Retries outbox rows left 'failed' by a transient transport error (SMTP
 * connect refused, timeout, ...). Both the state-change and auto-email send
 * paths already leave a failed row in the outbox for "later retry" — this
 * sweep is that later retry; nothing else ever revisits a 'failed' row.
 *
 * Rows that have already failed `maxAttempts` times are left alone: past
 * that point a transient-failure retry is unlikely to help, and retrying
 * forever would mask a real, permanent problem (bad address, disabled
 * account) behind an ever-growing attempts counter.
 *
 * The batch is claimed before anything is sent (see claimFailedEmails), so two
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

  const claimed = await claimFailedEmails(deps.pool, {
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
