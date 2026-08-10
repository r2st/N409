import type pg from 'pg';
import type { FastifyBaseLogger } from 'fastify';
import {
  applyPromotionalFooter,
  isCampaignDue,
  isSuppressed,
  renderTemplate,
  valuationTemplateVars,
} from '../domain/communications.js';
import {
  dueCandidates,
  findTemplatesByKeys,
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
  /**
   * Where the unsubscribe footer points. Optional so the many test call sites
   * need not supply one; a promotional send with no URL to offer goes without
   * a footer rather than with a broken link.
   */
  publicBaseUrl?: string;
}): Promise<{ queued: number; skipped: number; suppressed: number }> {
  const client = await deps.pool.connect();
  try {
    const { rows } = await client.query<{ locked: boolean }>('SELECT pg_try_advisory_lock($1) AS locked', [
      SCAN_LOCK_KEY,
    ]);
    if (!rows[0]!.locked) {
      deps.log?.info('auto email scan already in progress; skipping this pass');
      return { queued: 0, skipped: 0, suppressed: 0 };
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

/**
 * The scan's clock, read from the database.
 *
 * Every timestamp the scan compares against is written by Postgres —
 * `state_entered_at` is `valuation_events.occurred_at` or `valuations.created_at`,
 * and the prior send times are `auto_email_sends.sent_at`. Taking `now` from
 * this process instead compared two clocks that are not the same clock, and
 * the app server and the database are not required to be the same machine.
 *
 * A database even a few milliseconds ahead makes a campaign with
 * `delay_hours: 0` not yet due at the instant its own valuation was created:
 * `now - state_entered_at` is negative, so the message is skipped. Against a
 * container clock 13ms ahead that stopped being a race and became every pass.
 */
async function dbNow(db: pg.PoolClient): Promise<Date> {
  const { rows } = await db.query<{ now: Date }>('SELECT now() AS now');
  return rows[0]!.now;
}

async function scan(
  db: pg.PoolClient,
  deps: {
    transport?: EmailTransport;
    smsTransport?: EmailTransport;
    log?: FastifyBaseLogger;
    now?: Date;
    publicBaseUrl?: string;
  },
): Promise<{ queued: number; skipped: number; suppressed: number }> {
  // Read once, before the candidate query, so the whole pass judges every
  // campaign against one instant.
  const now = deps.now ?? (await dbNow(db));
  let queued = 0;
  let skipped = 0;
  // Promotional messages withheld for want of marketing consent. Counted
  // separately from `skipped` (no phone on file) because they are not the same
  // event: one is a missing detail to chase, the other is a decision to honour.
  let suppressed = 0;
  const settingsUrl = deps.publicBaseUrl ? `${deps.publicBaseUrl.replace(/\/$/, '')}/settings` : null;

  const campaigns = (await listAutoEmails(db)).filter((c) => c.enabled);
  // One read for every campaign's template rather than one per campaign. The
  // keys repeat across campaigns — a renewal template serves several cadences —
  // so the per-campaign lookup was re-fetching the same rows within one pass.
  const templates = await findTemplatesByKeys(
    db,
    campaigns.map((c) => c.template_key),
  );
  for (const campaign of campaigns) {
    const template = templates.get(campaign.template_key);
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
      // Marketing consent, and only for marketing (migration 0118). Checked
      // before the outbox row exists rather than after: a suppressed
      // promotional message was never queued, so there is nothing for the
      // retry sweep to find and nothing counting against max_sends. A
      // transactional campaign never reaches this branch — a client who
      // unsubscribed from renewal offers still has to be told their draft is
      // ready.
      if (isSuppressed(campaign, { marketingEmail: candidate.marketing_email })) {
        suppressed += 1;
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
          // Footer on promotional sends only — see applyPromotionalFooter.
          body: applyPromotionalFooter(renderTemplate(template.body, vars), campaign, settingsUrl),
          // Carried onto the row so the transport can attach `List-Unsubscribe`
          // to this send and to nothing else (migration 0138). The campaign
          // knows; by delivery time only the row is left to ask.
          promotional: campaign.promotional,
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

  return { queued, skipped, suppressed };
}
