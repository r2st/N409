import { describeTransportFailure } from '@n409/shared';
import type pg from 'pg';
import type { FastifyBaseLogger } from 'fastify';
import type { EmailTransport } from '../hooks/stateChange.js';
import { enqueueEmail, markEmail } from '../repos/emailOutbox.js';
import { recordSendFailure } from '../repos/emailDelivery.js';
import { alwaysTemplateVars, renderTemplate, type TemplateVars } from '../domain/communications.js';
import { findTemplateByKey } from '../repos/communications.js';
import type { SupportEmailSource } from '../hooks/autoEmails.js';

/**
 * Transactional must-sends (password reset, invitations). Same
 * outbox-then-deliver contract as the workflow emails: the row is written
 * first, so a transport outage leaves it 'queued'/'failed' instead of
 * losing the mail. Delivery errors never propagate to the caller.
 *
 * An enabled communication_templates row matching templateKey re-templates
 * subject/body (§15.5), rendered with `vars`. Transactional emails always
 * deliver — a disabled row just means the built-in content is used.
 *
 * The `always` scope of the variable catalog is supplied here rather than by
 * the call sites, for the reason `alwaysTemplateVars` carries and the drip
 * scan already obeys: `recipient_name`, `platform_name` and `support_email`
 * are declared on every template, filled in the editor's preview from the
 * catalog's samples, and were answered by none of the eleven call sites that
 * reach this function. `renderTemplate` leaves a name nobody supplies verbatim,
 * so an ops-authored `password_reset` override reading "Hi {{recipient_name}}"
 * previewed as "Hi Dana" and was delivered as "Hi {{recipient_name}}".
 *
 * A caller's own `vars` still win: a site that holds a better answer than the
 * floor here — a partner's brand, the invitee's name — passes it and it stands.
 */
export async function sendTransactionalEmail(
  deps: {
    pool: pg.Pool;
    transport?: EmailTransport;
    log?: FastifyBaseLogger;
    /** Answers `{{support_email}}`; omitted, the variable renders empty. */
    settings?: SupportEmailSource;
  },
  input: {
    toUserId?: string | null;
    toEmail: string;
    templateKey: string;
    subject: string;
    body: string;
    /** Values for {{var}} placeholders when a DB template overrides content. */
    vars?: TemplateVars;
    /** The recipient's given name where the call site holds one. */
    recipientName?: string | null;
    /** The partner firm on a white-labelled send; the platform otherwise. */
    platformName?: string | null;
  },
): Promise<void> {
  let { subject, body } = input;
  try {
    const override = await findTemplateByKey(deps.pool, input.templateKey);
    if (override?.enabled && override.subject && override.body) {
      // Read only when an override is actually going to be rendered — the
      // built-in copy carries no placeholders, and this is a query.
      const support = await deps.settings?.get('support_email').catch((err: unknown) => {
        deps.log?.warn({ err }, 'support_email read failed; {{support_email}} renders empty');
        return '';
      });
      const vars: TemplateVars = {
        ...alwaysTemplateVars({
          recipient_name: input.recipientName,
          recipient_email: input.toEmail,
          platform_name: input.platformName,
          support_email: support ?? '',
        }),
        ...(input.vars ?? {}),
      };
      subject = renderTemplate(override.subject, vars);
      body = renderTemplate(override.body, vars);
    }
  } catch (err) {
    deps.log?.warn({ err }, 'template override lookup failed; using built-in content');
  }
  const { vars: _vars, recipientName: _name, platformName: _brand, ...rest } = input;
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
    // `emailId` is what the retry sweep will log this row under when it comes
    // back for it, so this line and every later attempt share one join key.
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
  deps: Parameters<typeof sendTransactionalEmail>[0],
  input: Parameters<typeof sendTransactionalEmail>[1],
): void {
  void sendTransactionalEmail(deps, input).catch((err: unknown) => {
    deps.log?.warn({ err, templateKey: input.templateKey }, 'background transactional email failed');
  });
}
