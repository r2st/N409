import type pg from 'pg';
import type { FastifyBaseLogger } from 'fastify';
import type { EmailTransport } from '../hooks/stateChange.js';
import { enqueueEmail, markEmail } from '../repos/emailOutbox.js';
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
    await markEmail(deps.pool, email.id, 'failed', err instanceof Error ? err.message : String(err));
    deps.log?.warn({ err, emailId: email.id }, 'transactional email delivery failed; left in outbox');
  }
}
