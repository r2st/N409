import type pg from 'pg';
import type { FastifyBaseLogger } from 'fastify';
import { withTransaction } from '../db/pool.js';
import type { ValuationState } from '../domain/valuation.js';
import {
  emailsForTransition,
  notificationsForTransition,
  type Recipient,
  type ValuationSnapshot,
} from '../domain/emailWorkflows.js';
import { createNotification } from '../repos/notifications.js';
import { channelsFor, preferenceOverrides } from '../repos/notificationPreferences.js';
import { enqueueEmail, markEmail, type EmailOutboxRow } from '../repos/emailOutbox.js';

/**
 * Fires the auto email workflows + in-app notifications for a state change
 * (M4). Outbox rows and notifications are written atomically; actual delivery
 * happens after commit through the transport, so a transport outage delays
 * email but never loses it (rows stay 'queued').
 */

export interface EmailTransport {
  send(email: EmailOutboxRow): Promise<void>;
}

/** Dev/default transport: delivery is just a structured log line. */
export function logTransport(log: FastifyBaseLogger): EmailTransport {
  return {
    async send(email) {
      log.info(
        { to: email.to_email, subject: email.subject, template: email.template_key },
        'email delivered (log transport)',
      );
    },
  };
}

async function resolveRecipient(
  pool: pg.Pool,
  v: ValuationSnapshot,
  recipient: Recipient,
): Promise<{ id: string; email: string } | null> {
  const userId = recipient === 'owner' ? v.user_id : v.assigned_reviewer_id;
  if (!userId) return null;
  const { rows } = await pool.query<{ id: string; email: string }>(
    'SELECT id, email FROM users WHERE id = $1',
    [userId],
  );
  return rows[0] ?? null;
}

export async function onStateChanged(
  deps: { pool: pg.Pool; transport?: EmailTransport; log?: FastifyBaseLogger },
  valuation: ValuationSnapshot,
  to: ValuationState,
): Promise<void> {
  const emailSpecs = emailsForTransition(valuation, to);
  const notifySpecs = notificationsForTransition(valuation, to);
  if (emailSpecs.length === 0 && notifySpecs.length === 0) return;

  const recipients = new Map<Recipient, { id: string; email: string } | null>();
  for (const r of new Set<Recipient>([
    ...emailSpecs.map((s) => s.recipient),
    ...notifySpecs.map((s) => s.recipient),
  ])) {
    recipients.set(r, await resolveRecipient(deps.pool, valuation, r));
  }

  // Per-user channel preferences (P2 #11): the workflow templateKey / notify
  // type doubles as the preference event type. Absent rows mean channel on.
  const recipientIds = [...recipients.values()].filter((u) => u !== null).map((u) => u.id);
  const prefs = await preferenceOverrides(deps.pool, recipientIds);

  const queued = await withTransaction(deps.pool, async (client) => {
    const out: EmailOutboxRow[] = [];
    for (const spec of emailSpecs) {
      const user = recipients.get(spec.recipient);
      if (!user) continue;
      if (!channelsFor(prefs, user.id, spec.templateKey).email) continue;
      out.push(
        await enqueueEmail(client, {
          valuationId: valuation.id,
          toUserId: user.id,
          toEmail: user.email,
          templateKey: spec.templateKey,
          subject: spec.subject,
          body: spec.body,
        }),
      );
    }
    for (const spec of notifySpecs) {
      const user = recipients.get(spec.recipient);
      if (!user) continue;
      if (!channelsFor(prefs, user.id, spec.type).in_app) continue;
      await createNotification(client, {
        userId: user.id,
        valuationId: valuation.id,
        type: spec.type,
        title: spec.title,
        body: spec.body,
      });
    }
    return out;
  });

  if (!deps.transport) return;
  for (const email of queued) {
    try {
      await deps.transport.send(email);
      await markEmail(deps.pool, email.id, 'sent');
    } catch (err) {
      await markEmail(deps.pool, email.id, 'failed', err instanceof Error ? err.message : String(err));
      deps.log?.warn({ err, emailId: email.id }, 'email delivery failed; left in outbox');
    }
  }
}
