import { describeTransportFailure } from '@n409/shared';
import type pg from 'pg';
import type { FastifyBaseLogger } from 'fastify';
import type { EmailTransport } from '../hooks/stateChange.js';
import { enqueueEmail, markEmail } from '../repos/emailOutbox.js';
import { recordSendFailure } from '../repos/emailDelivery.js';
import { renderTemplate, type TemplateVars } from '../domain/communications.js';
import { findTemplateByKey } from '../repos/communications.js';

/**
 * Transactional must-sends (password reset, invitations). Same
 * outbox-then-deliver contract as the workflow emails: the row is written
 * first, so a transport outage leaves it 'queued'/'failed' instead of
 * losing the mail. Delivery errors never propagate to the caller.
 *
 * An enabled communication_templates row matching templateKey re-templates
 * subject/body (§15.5), rendered with `vars`. Transactional emails always
 * deliver — a disabled row just means the built-in content is used.
 */
export async function sendTransactionalEmail(
  deps: { pool: pg.Pool; transport?: EmailTransport; log?: FastifyBaseLogger },
  input: {
    toUserId?: string | null;
    toEmail: string;
    templateKey: string;
    subject: string;
    body: string;
    /** Values for {{var}} placeholders when a DB template overrides content. */
    vars?: TemplateVars;
  },
): Promise<void> {
  let { subject, body } = input;
  try {
    const override = await findTemplateByKey(deps.pool, input.templateKey);
    if (override?.enabled && override.subject && override.body) {
      subject = renderTemplate(override.subject, input.vars ?? {});
      body = renderTemplate(override.body, input.vars ?? {});
    }
  } catch (err) {
    deps.log?.warn({ err }, 'template override lookup failed; using built-in content');
  }
  const { vars: _vars, ...rest } = input;
  const email = await enqueueEmail(deps.pool, { ...rest, subject, body });
  if (!deps.transport) return;
  try {
    await deps.transport.send(email);
    await markEmail(deps.pool, email.id, 'sent');
  } catch (err) {
    // The marking is itself a query, so it fails when the reason the send failed
    // was the database. Losing the 'failed' stamp is a bookkeeping problem; a
    // rejection escaping this function is not — see below.
    try {
      await markEmail(deps.pool, email.id, 'failed', describeTransportFailure(err));
    } catch (markErr) {
      deps.log?.warn({ err: markErr, emailId: email.id }, 'could not mark transactional email failed');
    }
    // Terminal rejection of the recipient stops the ladder and suppresses the
    // address (0163). Same containment as the marking above: a bookkeeping
    // failure must not escape into the caller's request.
    const bounce = await recordSendFailure(deps.pool, email, err).catch((bookErr: unknown) => {
      deps.log?.warn({ err: bookErr, emailId: email.id }, 'could not record bounce');
      return null;
    });
    deps.log?.warn({ err, emailId: email.id, bounce }, 'transactional email delivery failed; left in outbox');
  }
}

/**
 * Send without waiting, and without a rejection ever escaping.
 *
 * `sendTransactionalEmail` swallows *delivery* errors, as its contract says, but
 * the outbox insert in front of them is a plain query: a pool timeout, a lost
 * connection, an address longer than the column all reject. Awaited by a route
 * that is a 500 — honest enough. Not awaited, it is an unhandled rejection, and
 * `installCrashHandlers` answers one of those by logging and exiting so systemd
 * restarts the service. `POST /api/v1/auth/forgot-password` is unauthenticated
 * and deliberately does not await (response latency must not reveal whether an
 * account exists), so the whole valuation service went down on a database
 * hiccup that a caller could pick the moment for.
 *
 * Callers that want the failure to reach the client keep awaiting the function
 * above; this one is for the sites that have already decided they don't.
 */
export function sendTransactionalEmailInBackground(
  deps: { pool: pg.Pool; transport?: EmailTransport; log?: FastifyBaseLogger },
  input: Parameters<typeof sendTransactionalEmail>[1],
): void {
  void sendTransactionalEmail(deps, input).catch((err: unknown) => {
    deps.log?.warn({ err, templateKey: input.templateKey }, 'background transactional email failed');
  });
}
