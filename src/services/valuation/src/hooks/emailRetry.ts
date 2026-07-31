import type pg from 'pg';
import type { FastifyBaseLogger } from 'fastify';
import { listOutbox, markEmail } from '../repos/emailOutbox.js';
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
 */
export async function retryFailedEmails(deps: {
  pool: pg.Pool;
  transport?: EmailTransport;
  smsTransport?: EmailTransport;
  log?: FastifyBaseLogger;
  maxAttempts?: number;
}): Promise<{ attempted: number; sent: number }> {
  const failed = await listOutbox(deps.pool, {
    status: 'failed',
    maxAttempts: deps.maxAttempts ?? 5,
    limit: 100,
  });

  let sent = 0;
  for (const email of failed) {
    const transport = email.channel === 'sms' ? deps.smsTransport : deps.transport;
    if (!transport) continue;
    try {
      await transport.send(email);
      await markEmail(deps.pool, email.id, 'sent');
      sent += 1;
    } catch (err) {
      await markEmail(deps.pool, email.id, 'failed', err instanceof Error ? err.message : String(err));
      deps.log?.warn({ err, emailId: email.id, attempts: email.attempts + 1 }, 'email retry failed');
    }
  }
  return { attempted: failed.length, sent };
}
