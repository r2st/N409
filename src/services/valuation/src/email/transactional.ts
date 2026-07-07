import type pg from 'pg';
import type { FastifyBaseLogger } from 'fastify';
import type { EmailTransport } from '../hooks/stateChange.js';
import { enqueueEmail, markEmail } from '../repos/emailOutbox.js';

/**
 * Transactional must-sends (password reset, invitations). Same
 * outbox-then-deliver contract as the workflow emails: the row is written
 * first, so a transport outage leaves it 'queued'/'failed' instead of
 * losing the mail. Delivery errors never propagate to the caller.
 */
export async function sendTransactionalEmail(
  deps: { pool: pg.Pool; transport?: EmailTransport; log?: FastifyBaseLogger },
  input: {
    toUserId?: string | null;
    toEmail: string;
    templateKey: string;
    subject: string;
    body: string;
  },
): Promise<void> {
  const email = await enqueueEmail(deps.pool, input);
  if (!deps.transport) return;
  try {
    await deps.transport.send(email);
    await markEmail(deps.pool, email.id, 'sent');
  } catch (err) {
    await markEmail(deps.pool, email.id, 'failed', err instanceof Error ? err.message : String(err));
    deps.log?.warn({ err, emailId: email.id }, 'transactional email delivery failed; left in outbox');
  }
}
