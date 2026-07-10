import type pg from 'pg';
import type { FastifyBaseLogger } from 'fastify';
import {
  isCampaignDue,
  renderTemplate,
  valuationTemplateVars,
} from '../domain/communications.js';
import {
  dueCandidates,
  findTemplateByKey,
  listAutoEmails,
  recordAutoEmailSend,
} from '../repos/communications.js';
import { enqueueEmail, markEmail } from '../repos/emailOutbox.js';
import type { EmailTransport } from './stateChange.js';

/**
 * Drip campaign scan (409.ai §15.6). Called on an interval from the service
 * entrypoint and on demand from POST /admin/auto-emails/run. For every
 * enabled campaign, finds valuations that have sat in the trigger state past
 * the delay (condition applied), renders the campaign's template, and queues
 * an outbox row per hit. The send record is written before delivery is
 * attempted, so a crash mid-scan cannot double-send.
 *
 * SMS campaigns deliver to the requester's phone through smsTransport;
 * recipients without a phone on file are recorded as 'skipped'.
 */
export async function runDueAutoEmails(deps: {
  pool: pg.Pool;
  transport?: EmailTransport;
  smsTransport?: EmailTransport;
  log?: FastifyBaseLogger;
  now?: Date;
}): Promise<{ queued: number; skipped: number }> {
  const now = deps.now ?? new Date();
  let queued = 0;
  let skipped = 0;

  const campaigns = (await listAutoEmails(deps.pool)).filter((c) => c.enabled);
  for (const campaign of campaigns) {
    const template = await findTemplateByKey(deps.pool, campaign.template_key);
    if (!template?.enabled) {
      deps.log?.warn(
        { campaign: campaign.name, template: campaign.template_key },
        'auto email skipped: template missing or disabled',
      );
      continue;
    }

    for (const candidate of await dueCandidates(deps.pool, campaign)) {
      if (!isCampaignDue(campaign, candidate.state_entered_at, candidate.prior_sends_at, now)) {
        continue;
      }
      const destination = campaign.channel === 'sms' ? candidate.to_phone : candidate.to_email;
      const vars = valuationTemplateVars({
        company_name: candidate.company_name,
        kind: candidate.kind,
        number: candidate.number,
      });
      const email = await enqueueEmail(deps.pool, {
        valuationId: candidate.valuation_id,
        toUserId: candidate.user_id,
        toEmail: destination ?? candidate.to_email,
        channel: campaign.channel,
        templateKey: campaign.template_key,
        subject: renderTemplate(template.subject, vars),
        body: renderTemplate(template.body, vars),
      });
      // Counts against max_sends even if delivery fails — retries are the
      // outbox's job; the campaign must not re-fire on a flaky transport.
      await recordAutoEmailSend(deps.pool, {
        autoEmailId: campaign.id,
        valuationId: candidate.valuation_id,
        outboxId: email.id,
      });

      if (campaign.channel === 'sms' && !candidate.to_phone) {
        await markEmail(deps.pool, email.id, 'skipped', 'no phone number on file');
        skipped += 1;
        continue;
      }
      queued += 1;

      const transport = campaign.channel === 'sms' ? deps.smsTransport : deps.transport;
      if (!transport) continue;
      try {
        await transport.send(email);
        await markEmail(deps.pool, email.id, 'sent');
      } catch (err) {
        await markEmail(deps.pool, email.id, 'failed', err instanceof Error ? err.message : String(err));
        deps.log?.warn({ err, emailId: email.id }, 'auto email delivery failed; left in outbox');
      }
    }
  }

  return { queued, skipped };
}
