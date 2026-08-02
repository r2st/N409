import type pg from 'pg';
import type { FastifyBaseLogger } from 'fastify';
import { isCampaignDue, renderTemplate, valuationTemplateVars } from '../domain/communications.js';
import {
  dueCandidates,
  findTemplateByKey,
  listAutoEmails,
  recordAutoEmailSend,
} from '../repos/communications.js';
import { enqueueEmail, markEmail } from '../repos/emailOutbox.js';
import { withClientTransaction } from '../db/pool.js';
import type { EmailTransport } from './stateChange.js';

/**
 * Serializes the scan across every caller and every service instance. The scan
 * decides whether a campaign still owes a valuation a message by counting the
 * auto_email_sends rows it can see, so two scanners that overlap both read
 * "none sent yet" and both send — the same failure the retry sweep had before
 * 0095, reached the same way. Two scanners is the normal case, not a rare one:
 * the interval in index.ts and POST /admin/auto-emails/run are the same
 * function, an ops double-click fires it twice, and a deployment can run more
 * than one instance against this database.
 *
 * `try` rather than a blocking lock: a scanner that waits its turn would only
 * wake up to re-read a backlog the holder has just drained. Skipping is also
 * the honest answer to an ops-triggered run that collides with the interval —
 * the scan it asked for is already happening.
 */
const SCAN_LOCK_KEY = 0x6e34_4145; // 'n4AE' — distinct from the migrate lock

/**
 * Drip campaign scan (409.ai §15.6). Called on an interval from the service
 * entrypoint and on demand from POST /admin/auto-emails/run. For every
 * enabled campaign, finds valuations that have sat in the trigger state past
 * the delay (condition applied), renders the campaign's template, and queues
 * an outbox row per hit. The outbox row and its send record are written in one
 * transaction, so a crash mid-scan can neither double-send nor leave a queued
 * message the campaign has no record of.
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
  const client = await deps.pool.connect();
  try {
    const { rows } = await client.query<{ locked: boolean }>('SELECT pg_try_advisory_lock($1) AS locked', [
      SCAN_LOCK_KEY,
    ]);
    if (!rows[0]!.locked) {
      deps.log?.info('auto email scan already in progress; skipping this pass');
      return { queued: 0, skipped: 0 };
    }
    try {
      // The whole scan runs on this client: the lock is session-scoped, so work
      // moved to another connection would not be covered by it.
      return await scan(client, deps);
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [SCAN_LOCK_KEY]).catch(() => {});
    }
  } finally {
    client.release();
  }
}

async function scan(
  db: pg.PoolClient,
  deps: {
    transport?: EmailTransport;
    smsTransport?: EmailTransport;
    log?: FastifyBaseLogger;
    now?: Date;
  },
): Promise<{ queued: number; skipped: number }> {
  const now = deps.now ?? new Date();
  let queued = 0;
  let skipped = 0;

  const campaigns = (await listAutoEmails(db)).filter((c) => c.enabled);
  for (const campaign of campaigns) {
    const template = await findTemplateByKey(db, campaign.template_key);
    if (!template?.enabled) {
      deps.log?.warn(
        { campaign: campaign.name, template: campaign.template_key },
        'auto email skipped: template missing or disabled',
      );
      continue;
    }

    for (const candidate of await dueCandidates(db, campaign)) {
      if (!isCampaignDue(campaign, candidate.state_entered_at, candidate.prior_sends_at, now)) {
        continue;
      }
      const destination = campaign.channel === 'sms' ? candidate.to_phone : candidate.to_email;
      const vars = valuationTemplateVars({
        company_name: candidate.company_name,
        kind: candidate.kind,
        number: candidate.number,
      });
      // One transaction: a queued message with no send record would be
      // delivered by the retry sweep and then queued again by the next scan,
      // which is the double-send this is here to prevent. The record counts
      // against max_sends even if delivery later fails — retries are the
      // outbox's job; the campaign must not re-fire on a flaky transport.
      const email = await withClientTransaction(db, async (tx) => {
        const row = await enqueueEmail(tx, {
          valuationId: candidate.valuation_id,
          toUserId: candidate.user_id,
          toEmail: destination ?? candidate.to_email,
          channel: campaign.channel,
          templateKey: campaign.template_key,
          subject: renderTemplate(template.subject, vars),
          body: renderTemplate(template.body, vars),
        });
        await recordAutoEmailSend(tx, {
          autoEmailId: campaign.id,
          valuationId: candidate.valuation_id,
          outboxId: row.id,
        });
        return row;
      });

      if (campaign.channel === 'sms' && !candidate.to_phone) {
        await markEmail(db, email.id, 'skipped', 'no phone number on file');
        skipped += 1;
        continue;
      }
      queued += 1;

      const transport = campaign.channel === 'sms' ? deps.smsTransport : deps.transport;
      if (!transport) continue;
      try {
        await transport.send(email);
        await markEmail(db, email.id, 'sent');
      } catch (err) {
        await markEmail(db, email.id, 'failed', err instanceof Error ? err.message : String(err));
        deps.log?.warn({ err, emailId: email.id }, 'auto email delivery failed; left in outbox');
      }
    }
  }

  return { queued, skipped };
}
