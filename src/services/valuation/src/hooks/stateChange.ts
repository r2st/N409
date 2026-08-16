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
import { recordSendFailure } from '../repos/emailDelivery.js';
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

/**
 * Announce a transition that has already happened.
 *
 * Every caller commits the state change first and calls this afterwards, so by
 * the time anything in here runs the transition is durable and the decision has
 * been made. Nothing raised here can un-make it, which is why nothing raised
 * here is allowed to travel back to the caller: the request would answer 5xx
 * for a transition that did in fact succeed, and the client would be told to
 * retry a move that has already been applied.
 *
 * The webhook half has always been contained for that reason. The email and
 * notification half was not, and it is the half with four database round trips
 * in front of the write that makes it durable — the template overrides, the
 * partner row, the recipients and their channel preferences. A blip across any
 * of those threw into the caller.
 *
 * The Stripe path is where that was worst, and where it was invisible.
 * `recordStripeEvent` is deliberately not written on the throw path so a failed
 * event is redelivered — but the redelivery re-enters `fulfill()` to find
 * `paid_status` already `paid`, skips the whole block, and settles the event
 * successfully. So the retry that was supposed to recover the notification is
 * the thing that buries it: the client's payment advanced the engagement to
 * `paid` and the mail saying so was never queued, with a 500 in the log
 * attributed to a webhook that Stripe's own dashboard then shows as delivered.
 *
 * Containing it does not make the message arrive; it makes the failure legible
 * and stops it corrupting the answer to a request that worked. Once the outbox
 * rows commit the message is durable and the retry sweep owns delivery — the
 * exposure is only the window before that, and it is logged at error because a
 * dropped notification has nothing else anywhere recording that it was owed.
 */
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

  try {
    await deliverTransitionMessages(deps, valuation, to);
  } catch (err) {
    deps.log?.error(
      { err, valuationId: valuation.id, to },
      'state change notifications failed; the transition stands and the message was not queued',
    );
  }
}

async function deliverTransitionMessages(
  deps: { pool: pg.Pool; transport?: EmailTransport; log?: FastifyBaseLogger },
  valuation: ValuationSnapshot,
  to: ValuationState,
): Promise<void> {
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

  // Past this point the rows are committed, so nothing here can lose a message
  // — the worst case is one left 'queued' for the retry sweep. The containment
  // is still per-email rather than per-batch: `markEmail` is a database write on
  // both the success and the failure path, and letting one of them abort the
  // loop hands the sweep every remaining recipient of the same transition, each
  // waiting out the claim lease before anyone hears anything.
  if (!deps.transport) return;
  for (const email of queued) {
    try {
      await deps.transport.send(email);
      await markEmail(deps.pool, email.id, 'sent');
    } catch (err) {
      try {
        await markEmail(deps.pool, email.id, 'failed', err instanceof Error ? err.message : String(err));
        // Terminal rejection of the recipient stops the ladder and suppresses
        // the address (0163); anything else stays retryable.
        const bounce = await recordSendFailure(deps.pool, email, err).catch(() => null);
        deps.log?.warn({ err, emailId: email.id, bounce }, 'email delivery failed; left in outbox');
      } catch (settleErr) {
        // The row stays 'queued' and the sweep re-sends it once the lease
        // lapses, so this is a delay rather than a loss — but it is a delay
        // nobody would otherwise see, and it means the database is refusing
        // writes on a path the send loop above is about to use again.
        deps.log?.error(
          { err: settleErr, cause: err, emailId: email.id },
          'could not record a failed send; outbox row left queued for the retry sweep',
        );
      }
    }
  }
}
