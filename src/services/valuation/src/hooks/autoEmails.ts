import { describeTransportFailure, logUnretried } from '@n409/shared';
import type pg from 'pg';
import type { FastifyBaseLogger } from 'fastify';
import {
  alwaysTemplateVars,
  applyPromotionalFooter,
  isCampaignDue,
  isSuppressed,
  renderTemplate,
  valuationLinkVars,
  valuationTemplateVars,
} from '../domain/communications.js';
import {
  eachDueCandidate,
  findTemplatesByKeys,
  listAutoEmails,
  recordAutoEmailSend,
} from '../repos/communications.js';
import { enqueueEmail, markEmail } from '../repos/emailOutbox.js';
import { recordSendFailure } from '../repos/emailDelivery.js';
import { withClientTransaction } from '../db/pool.js';
import { SWEEP_LOCKS, withSweepLock } from '../db/sweepLock.js';
import { sendAndRecord } from '../email/sendAttempt.js';
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
 * The argument generalised, along with the lock's mechanics, into
 * `db/sweepLock.ts` — R292 found the overdue-reminder sweep making every part
 * of it true and holding no lock at all.
 */
const SCAN_LOCK_KEY = SWEEP_LOCKS.autoEmailScan;

/**
 * Just the one read the rendering needs, rather than the whole settings store,
 * so a test can pass an object literal and so this hook does not depend on the
 * store's shape. `SystemSettingsStore` satisfies it structurally.
 */
export interface SupportEmailSource {
  get(key: 'support_email'): Promise<string>;
}

/** What one drip pass did, plus whether it happened at all. */
export interface AutoEmailScanResult {
  /** Outbox rows written. */
  queued: number;
  /** Candidates passed over for want of a recipient detail (an SMS with no phone). */
  skipped: number;
  /** Promotional messages withheld for want of marketing consent. */
  suppressed: number;
  /** Candidates this pass owed a message and did not send one to. */
  failed: number;
  /**
   * True when another scan held the lock and this one did not run. Every count
   * above is then zero because nothing was looked at, not because nothing was
   * due — see `runDueAutoEmails`.
   */
  declined: boolean;
}

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
  /** Answers `{{support_email}}`; omitted, the variable renders empty. */
  settings?: SupportEmailSource;
  /**
   * Candidates read per page. Defaults to AUTO_EMAIL_PAGE_LIMIT, which is well
   * above any plausible backlog — a small value here is how a test exercises
   * the paging without seeding hundreds of engagements.
   */
  pageSize?: number;
}): Promise<AutoEmailScanResult> {
  // The whole scan runs on the locked client: the lock is session-scoped, so
  // work moved to another connection would not be covered by it.
  const run = await withSweepLock(deps.pool, SCAN_LOCK_KEY, deps.log, (client) => scan(client, deps));
  if (!run.ran) {
    deps.log?.info(
      { event: 'auto_email_scan_skipped' },
      'auto email scan already in progress; skipping this pass',
    );
    // `declined`, and not four zeros on their own (round 340, methodology M5).
    // A pass that never ran reported exactly what a pass with nothing due
    // reports, on both of this function's surfaces: the sweep's tally, where
    // `background_sweep_items_total` then shows the shape of a healthy idle
    // scheduler, and `POST /admin/auto-emails/run`, where the operator who
    // pressed the button is told "nothing to send" rather than "your scan did
    // not happen". `runJobAlertScan` carries `skipped` for this exact reason
    // and says so; this is the same field under a name that does not collide
    // with the `skipped` already in this result, which counts recipients with
    // no phone on file.
    //
    // It matters more here than a collision between two healthy readings would
    // suggest, because the lock can be held by nobody: `withSweepLock`'s own
    // note describes a failed unlock returning a live connection to the pool
    // still holding a session-scoped key, after which every later pass declines
    // forever and the log line for it is the benign one. That is the drip
    // campaigns stopping, permanently, with nothing above `info` to say so.
    return { queued: 0, skipped: 0, suppressed: 0, failed: 0, declined: true };
  }
  return { ...run.value, declined: false };
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
    settings?: SupportEmailSource;
    pageSize?: number;
  },
): Promise<{ queued: number; skipped: number; suppressed: number; failed: number }> {
  // Read once, before the candidate query, so the whole pass judges every
  // campaign against one instant.
  const now = deps.now ?? (await dbNow(db));
  let queued = 0;
  let skipped = 0;
  // Promotional messages withheld for want of marketing consent. Counted
  // separately from `skipped` (no phone on file) because they are not the same
  // event: one is a missing detail to chase, the other is a decision to honour.
  let suppressed = 0;
  // Candidates this pass was due to message and did not, because something
  // threw while it was messaging them. See the per-candidate catch below.
  let failed = 0;
  const settingsUrl = deps.publicBaseUrl ? `${deps.publicBaseUrl.replace(/\/$/, '')}/settings` : null;
  // Once per pass, not once per message: it is a cached read, but the scan
  // renders a whole backlog and the address does not change inside one pass.
  // swallow: the settings store logs its own read failures and serves the last
  // values it read (repos/systemSettings.ts).
  const supportEmail = (await deps.settings?.get('support_email').catch(() => null)) ?? null;

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

    // A page at a time, not the whole trigger state at once. The candidate
    // query is the only read on this path that had no LIMIT, and it is the one
    // that grows with the table: every valuation in the state, each carrying
    // four correlated subqueries' worth of columns, held in this process while
    // the scan works through them. Paged rather than capped — see
    // eachDueCandidate — because a campaign's tail must still be mailed.
    for await (const page of eachDueCandidate(db, campaign, { pageSize: deps.pageSize })) {
      for (const candidate of page) {
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
        /*
         * One candidate's bad minute costs that candidate, not the pass.
         *
         * The two sibling send loops already say why, in as many words:
         * `hooks/stateChange.ts` — "letting one of them abort the loop hands
         * the sweep every remaining recipient of the same transition, each
         * waiting out the claim lease before anyone hears anything" — and
         * `hooks/emailRetry.ts`, which contains its settle for the same reason.
         * This is the widest of the three and was the only one uncontained: the
         * scan walks every enabled campaign's entire backlog, so a statement
         * timeout on one enqueue took the tail of that campaign *and every
         * campaign after it* with it, and the pass reported a failure carrying
         * none of what it had already queued.
         *
         * The bookkeeping calls inside are the ones that reach the database
         * after a message has left the building — `markEmail`, and `onFailed`'s
         * mark, which is the one arm `stateChange` guards and this did not.
         *
         * Counted, not swallowed: `failed` is a candidate this pass was due to
         * message and did not, which is the one thing an operator reading a
         * scan's tally has to be told.
         */
        try {
          const destination = campaign.channel === 'sms' ? candidate.to_phone : candidate.to_email;
          // Every scope the catalog declares for an engagement-scoped send, not
          // the three names this scan happened to have in hand. A campaign
          // template naming `{{due_date}}` or `{{recipient_name}}` previewed
          // correctly for the operator who wrote it and shipped a blank — or, for
          // the `always` and `link` scopes, literal braces — to the client.
          const vars = {
            ...alwaysTemplateVars({
              recipient_name: candidate.recipient_name,
              recipient_email: candidate.to_email,
              platform_name: candidate.partner_name,
              support_email: supportEmail,
            }),
            ...valuationLinkVars(deps.publicBaseUrl, candidate.valuation_id),
            ...valuationTemplateVars({
              company_name: candidate.company_name,
              kind: candidate.kind,
              number: candidate.number,
              valuation_date: candidate.valuation_date,
              due_date: candidate.due_date,
              state: candidate.state,
              partner_name: candidate.partner_name,
            }),
          };
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
          // Recording a delivery and recording a refusal are separate callbacks,
          // so a blip on the marking UPDATE cannot be written down as the relay
          // refusing a message it in fact accepted — which would put the row on
          // the ladder to be delivered a second time. See email/sendAttempt.ts.
          await sendAndRecord(transport, email, {
            log: deps.log,
            context: { campaign: campaign.name, valuationId: candidate.valuation_id },
            onSent: async () => { await markEmail(db, email.id, 'sent'); },
            onFailed: async (err) => {
              /*
               * Contained on its own, so the bounce record below runs whether or
               * not the stamp landed.
               *
               * These are two writes about two different things — what became of
               * this *message*, and what the relay told us about this *address* —
               * and leaving the first uncaught made the second conditional on it.
               * A blip on the `email_outbox` UPDATE threw out of `onFailed`, out
               * of `sendAndRecord`, and into the per-candidate catch below, which
               * counts the candidate failed and moves on: `recordSendFailure`
               * never ran, so a mailbox that had just permanently rejected us
               * stayed off the suppression list and the ladder kept sending to
               * it. That is the outcome the comment below names, reached one line
               * earlier than the catch written to stop it.
               */
              try {
                await markEmail(db, email.id, 'failed', describeTransportFailure(err));
              } catch (markErr) {
                // The row stays 'queued' and the retry sweep takes it once the
                // lease lapses, so this is a delay rather than a loss — but
                // nothing else would say so, and it means this client is
                // refusing writes the rest of the scan is about to use.
                if (deps.log) {
                  logUnretried(
                    deps.log,
                    markErr,
                    { emailId: email.id, campaign: campaign.name },
                    'could not stamp an auto email failed; outbox row left queued for the retry sweep',
                  );
                }
              }
              // Terminal rejection of the recipient stops the ladder and suppresses
              // the address (0163). Uses this sweep's own client rather than taking
              // a second one from the pool.
              /*
               * `null` from this write is not the same `null` as "the provider
               * did not reject the recipient" (round 267, methodology M11), and
               * the line below prints both as `bounce: null`. A terminal bounce
               * that could not be recorded leaves the address *unsuppressed*, so
               * the ladder keeps sending to a mailbox that has hard-rejected us —
               * the one outcome `recordSendFailure` exists to stop, reached
               * through the catch written so it could not stop the send loop.
               */
              const bounce = await recordSendFailure(db, email, err).catch((bookErr: unknown) => {
                if (deps.log) {
                  logUnretried(
                    deps.log,
                    bookErr,
                    { emailId: email.id, campaign: campaign.name },
                    'send failure could not be recorded — a terminal bounce has not suppressed the address',
                  );
                }
                return null;
              });
              deps.log?.warn(
                { err, emailId: email.id, bounce },
                'auto email delivery failed; left in outbox',
              );
            },
          });
        } catch (err) {
          // `logUnretried` for the reason the overdue sweep uses it: nothing
          // comes back for this candidate on this pass. The campaign's own
          // record decides whether the next one will — a message whose
          // `recordAutoEmailSend` committed is not owed again, and one whose
          // enqueue transaction rolled back is.
          if (deps.log) {
            logUnretried(
              deps.log,
              err,
              { campaign: campaign.name, valuationId: candidate.valuation_id },
              'auto email scan could not process one candidate; the rest of the scan continues',
            );
          }
          failed += 1;
        }
      }
    }
  }

  return { queued, skipped, suppressed, failed };
}
