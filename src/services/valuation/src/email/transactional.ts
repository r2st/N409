import { describeTransportFailure, logUnretried } from '@n409/shared';
import type pg from 'pg';
import type { FastifyBaseLogger } from 'fastify';
import type { EmailTransport } from '../hooks/stateChange.js';
import { enqueueEmail, markEmail } from '../repos/emailOutbox.js';
import { recordSendFailure } from '../repos/emailDelivery.js';
import { alwaysTemplateVars, renderTemplate, type TemplateVars } from '../domain/communications.js';
import { sendAndRecord } from './sendAttempt.js';
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
    /**
     * The engagement this message is about, where there is one.
     *
     * Not decoration. `email_outbox.valuation_id` is a predicate, not just a
     * column: `purgeOutbox`'s legal-hold clause reads `h.scope = 'valuation'
     * AND h.reference_id = e.valuation_id`, so a hold placed over an
     * engagement freezes exactly the outbox rows that name it. This function
     * could not set the column — the field was absent from the type while
     * `enqueueEmail` beneath it accepted one — so *every* transactional
     * message the platform sends carried NULL, and a valuation-scoped hold
     * froze none of them while the age sweep went on deleting them. That is
     * the failure the comment above `frozen` calls "the one failure a legal
     * hold exists to prevent", found once already on the user scope and left
     * standing on this one.
     *
     * It is also the join key `buildPersonalDataExport` projects, so an Art.
     * 15 export said `valuation_id: null` against every message a person had
     * been sent about their own engagement.
     *
     * Omitted by the sends that genuinely are not about an engagement — a
     * password reset, an invitation, a firm's invoice receipt.
     */
    valuationId?: string | null;
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
  // Success and failure are recorded by separate callbacks, so the marking —
  // itself a query — cannot fail and be written down as the relay refusing the
  // message. See email/sendAttempt.ts.
  await sendAndRecord(deps.transport, email, {
    log: deps.log,
    onSent: () => markEmail(deps.pool, email.id, 'sent'),
    onFailed: async (err) => {
      // Losing the 'failed' stamp is a bookkeeping problem; a rejection
      // escaping this function is not — see below.
      try {
        await markEmail(deps.pool, email.id, 'failed', describeTransportFailure(err));
      } catch (markErr) {
        deps.log?.warn({ err: markErr, emailId: email.id }, 'could not mark transactional email failed');
      }
      // Terminal rejection of the recipient stops the ladder and suppresses the
      // address (0163). Same containment as the marking above: a bookkeeping
      // failure must not escape into the caller's request.
      /*
       * `null` from this write is not the same `null` as "the provider did not
       * reject the recipient" (round 267, M11; this caller round 352, M5), and
       * the line below prints both as `bounce: null`. A terminal bounce that
       * could not be recorded leaves the address *unsuppressed*, so every
       * later send goes to a mailbox that has hard-rejected us — which is what
       * costs a sending domain its reputation, and is the one outcome
       * `recordSendFailure` exists to stop. The containment stays; the level
       * does not, because nothing revisits this write.
       */
      const bounce = await recordSendFailure(deps.pool, email, err).catch((bookErr: unknown) => {
        if (deps.log) {
          logUnretried(
            deps.log,
            bookErr,
            { emailId: email.id },
            'send failure could not be recorded — a terminal bounce has not suppressed the address',
          );
        }
        return null;
      });
      // `emailId` is what the retry sweep will log this row under when it comes
      // back for it, so this line and every later attempt share one join key.
      deps.log?.warn(
        { err, emailId: email.id, bounce },
        'transactional email delivery failed; left in outbox',
      );
    },
  });
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
