import type pg from 'pg';
import type { FastifyBaseLogger } from 'fastify';
import { withTransaction } from '../db/pool.js';
import type { ValuationState } from '../domain/valuation.js';
import {
  applyPartnerEmailTemplates,
  emailsForTransition,
  notificationsForTransition,
  type PartnerEmailTemplates,
  type Recipient,
  type ValuationSnapshot,
} from '../domain/emailWorkflows.js';
import { createNotification } from '../repos/notifications.js';
import { findUsersByIds } from '../repos/users.js';
import { channelsFor, preferenceOverrides } from '../repos/notificationPreferences.js';
import { enqueueEmail, markEmail, type EmailOutboxRow } from '../repos/emailOutbox.js';
import { applyTemplateOverrides, valuationTemplateVars } from '../domain/communications.js';
import { templateOverrides } from '../repos/communications.js';
import { firePartnerWebhooksForTransition } from './partnerWebhooks.js';

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

/** The user id a recipient role resolves to on this engagement, if any. */
function userIdFor(v: ValuationSnapshot, recipient: Recipient): string | null {
  return recipient === 'owner' ? v.user_id : v.assigned_reviewer_id;
}

/**
 * Every recipient of this transition, in one read.
 *
 * A transition addresses at most two roles, and each was a separate
 * `SELECT ... WHERE id = $1` — so an owner-and-reviewer transition paid two
 * round trips for two rows of the same table, and an engagement whose owner
 * *is* its reviewer paid two for one row. It is not the largest N in the
 * service, but it is on the path of every state change on the platform, and
 * `findUsersByIds` already de-duplicates ids and answers in a single query.
 *
 * Roles with no user (no reviewer assigned) map to null rather than being
 * dropped: the callers below distinguish "this transition has no reviewer" —
 * skip the spec — from "the reviewer's row is missing", which is the same
 * skip, and neither should turn into an unaddressed email.
 */
async function resolveRecipients(
  pool: pg.Pool,
  v: ValuationSnapshot,
  recipients: readonly Recipient[],
): Promise<Map<Recipient, { id: string; email: string } | null>> {
  const wanted = recipients.map((r) => [r, userIdFor(v, r)] as const);
  const users = await findUsersByIds(
    pool,
    wanted.map(([, id]) => id).filter((id): id is string => id !== null),
  );
  return new Map(wanted.map(([r, id]) => [r, (id !== null ? users.get(id) : null) ?? null]));
}

export async function onStateChanged(
  deps: { pool: pg.Pool; transport?: EmailTransport; log?: FastifyBaseLogger },
  valuation: ValuationSnapshot,
  to: ValuationState,
): Promise<void> {
  // Partner webhooks ride every transition of a partner engagement — including
  // the many transitions that trigger no email. Delivery failures are recorded
  // on the delivery row, never thrown into the state change that caused them.
  if (valuation.partner_id) {
    try {
      await firePartnerWebhooksForTransition({ pool: deps.pool, log: deps.log }, valuation.id, to);
    } catch (err) {
      deps.log?.warn({ err, valuationId: valuation.id }, 'partner webhook dispatch failed');
    }
  }

  let emailSpecs = emailsForTransition(valuation, to);
  const notifySpecs = notificationsForTransition(valuation, to);
  if (emailSpecs.length === 0 && notifySpecs.length === 0) return;

  // DB communication templates (§15.5): enabled rows re-template the built-in
  // workflow content. Applied before partner overrides so white-label still wins.
  if (emailSpecs.length > 0) {
    const overrides = await templateOverrides(
      deps.pool,
      emailSpecs.map((s) => s.templateKey),
    );
    emailSpecs = applyTemplateOverrides(emailSpecs, overrides, valuationTemplateVars(valuation));
  }

  // White-label (improvement 8): partner engagements use the partner's own
  // email templates where defined; missing keys fall back to the defaults.
  if (valuation.partner_id && emailSpecs.length > 0) {
    const { rows } = await deps.pool.query<{
      name: string;
      email_templates: PartnerEmailTemplates;
    }>('SELECT name, email_templates FROM partners WHERE id = $1', [valuation.partner_id]);
    const partner = rows[0];
    if (partner && Object.keys(partner.email_templates ?? {}).length > 0) {
      emailSpecs = applyPartnerEmailTemplates(emailSpecs, partner.email_templates, {
        company_name: valuation.company_name,
        kind: valuation.kind,
        partner_name: partner.name,
      });
    }
  }

  const recipients = await resolveRecipients(deps.pool, valuation, [
    ...new Set<Recipient>([
      ...emailSpecs.map((s) => s.recipient),
      ...notifySpecs.map((s) => s.recipient),
    ]),
  ]);

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
