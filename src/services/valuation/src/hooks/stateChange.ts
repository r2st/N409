import { describeTransportFailure, logUnretried } from '@n409/shared';
import type pg from 'pg';
import type { FastifyBaseLogger } from 'fastify';
import { withTransaction } from '../db/pool.js';
import type { ValuationState } from '../domain/valuation.js';
import {
  applyPartnerEmailTemplates,
  emailsForTransition,
  notificationsForTransition,
  type EmailSpec,
  type PartnerEmailTemplates,
  type Recipient,
  type ValuationSnapshot,
} from '../domain/emailWorkflows.js';
import { createNotification } from '../repos/notifications.js';
import { findUsersByIds } from '../repos/users.js';
import { channelsFor, preferenceOverrides } from '../repos/notificationPreferences.js';
import { enqueueEmail, markEmail, type EmailOutboxRow } from '../repos/emailOutbox.js';
import { recordSendFailure } from '../repos/emailDelivery.js';
import {
  alwaysTemplateVars,
  applyTemplateOverrides,
  valuationLinkVars,
  valuationTemplateVars,
} from '../domain/communications.js';
import { sendAndRecord } from '../email/sendAttempt.js';
import type { SupportEmailSource } from './autoEmails.js';

export type { SupportEmailSource };
import { templateOverrides } from '../repos/communications.js';
import { publicPartnerName } from '../domain/branding.js';
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

/**
 * What a caller must carry so a transition's templates can be *rendered*.
 *
 * `publicBaseUrl` answers the `link` scope and `settings` answers
 * `{{support_email}}`. Both optional, and deliberately: a transition must
 * still be announced when neither is wired — an unset base URL costs a link,
 * not the message. Extracted as its own type because four route modules and
 * `applyValuationState` all have to pass them through to `onStateChanged`, and
 * a spread-out list of two optional fields is how one of them ends up with
 * only the first.
 */
export interface TransitionRenderDeps {
  publicBaseUrl?: string;
  settings?: SupportEmailSource;
}

/** Everything {@link onStateChanged} needs. */
export interface TransitionDeps extends TransitionRenderDeps {
  pool: pg.Pool;
  transport?: EmailTransport;
  log?: FastifyBaseLogger;
}

/**
 * Dev/default transport: delivery is just a structured log line.
 *
 * The recipient is deliberately not on it. `to_email` is on the redact list
 * and this line logged it under the key `to`, which pino matches against the
 * *key* — so the redaction the list was extended to provide was undone by the
 * name chosen at the call site. "Dev transport" is not a defence either: this
 * is what `EMAIL_MODE=smtp` falls back to when `SMTP_HOST` is unset, which is
 * a state production can reach by a missing environment variable, and it is
 * what `SMS_MODE=log` uses — where `to_email` carries a *phone number* (see
 * migration 0051). The outbox id identifies the message; the address is one
 * join away for anyone entitled to it.
 */
export function logTransport(log: FastifyBaseLogger): EmailTransport {
  return {
    async send(email) {
      // Not the subject. It is a *rendered* template, and `{{recipient_name}}`
      // — offered to template authors by name — resolves to the recipient's
      // address whenever we hold no given name for them, so the line that had
      // the address taken out of it above was putting it back one field over.
      // `template_key` says which message this was; see `RENDERED_MESSAGE_FIELDS`.
      log.info({ emailId: email.id, template: email.template_key }, 'email delivered (log transport)');
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
): Promise<Map<Recipient, { id: string; email: string; first_name: string | null } | null>> {
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
  deps: TransitionDeps,
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
  deps: TransitionDeps,
  valuation: ValuationSnapshot,
  to: ValuationState,
): Promise<void> {
  const emailSpecs = emailsForTransition(valuation, to);
  const notifySpecs = notificationsForTransition(valuation, to);
  if (emailSpecs.length === 0 && notifySpecs.length === 0) return;

  // DB communication templates (§15.5): enabled rows re-template the built-in
  // workflow content. Fetched here, applied per recipient below, because two of
  // the names a template may use — `recipient_name` above all — are answers
  // about *who is being written to*, and this transition can address two people.
  const overrides: Awaited<ReturnType<typeof templateOverrides>> =
    emailSpecs.length > 0
      ? await templateOverrides(
          deps.pool,
          emailSpecs.map((s) => s.templateKey),
        )
      : new Map();

  // White-label (improvement 8): partner engagements use the partner's own
  // email templates where defined; missing keys fall back to the defaults.
  //
  // The partner's *name* is read on this same row and was then thrown away —
  // it went into `applyPartnerEmailTemplates`' own vars and nowhere else, so a
  // DB template on a partner engagement rendered `{{partner_name}}` blank
  // while the partner's own template beside it rendered it correctly.
  //
  // The name read here is the *public* one. `partners.name` is the internal
  // label ops picked for the channel — migration 0091 added `brand_name`
  // because it "is not necessarily what clients should read" — and this row
  // fills `{{partner_name}}` and `{{platform_name}}` in a message that goes to
  // the firm's client. A firm that had set its brand name saw it everywhere it
  // looked, and its clients read the ops channel label. See
  // `publicPartnerName`, which is the same rule the app and the report cover
  // resolve through.
  let partner: { name: string; email_templates: PartnerEmailTemplates } | null = null;
  if (valuation.partner_id && emailSpecs.length > 0) {
    const { rows } = await deps.pool.query<{
      name: string;
      brand_name: string | null;
      white_label_enabled: boolean;
      email_templates: PartnerEmailTemplates;
    }>('SELECT name, brand_name, white_label_enabled, email_templates FROM partners WHERE id = $1', [
      valuation.partner_id,
    ]);
    const row = rows[0];
    partner = row ? { name: publicPartnerName(row), email_templates: row.email_templates } : null;
  }

  const recipients = await resolveRecipients(deps.pool, valuation, [
    ...new Set<Recipient>([...emailSpecs.map((s) => s.recipient), ...notifySpecs.map((s) => s.recipient)]),
  ]);

  // Per-user channel preferences (P2 #11): the workflow templateKey / notify
  // type doubles as the preference event type. Absent rows mean channel on.
  const recipientIds = [...recipients.values()].filter((u) => u !== null).map((u) => u.id);
  const prefs = await preferenceOverrides(deps.pool, recipientIds);

  // The measurement date is an engine input in `valuation_params` (0041) and
  // is on no valuation row, so a template naming `{{valuation_date}}` had
  // nothing to read even though every caller passes a full row. Read only when
  // some template will actually be re-rendered — the built-in copy names none
  // of these, so the ordinary transition pays nothing for it.
  const renders = overrides.size > 0 || Object.keys(partner?.email_templates ?? {}).length > 0;
  const [valuationDate, supportEmail] = renders
    ? await Promise.all([
        deps.pool
          .query<{ valuation_date: string | null }>(
            `SELECT engine_inputs->>'valuation_date' AS valuation_date
               FROM valuation_params WHERE valuation_id = $1`,
            [valuation.id],
          )
          .then((r) => r.rows[0]?.valuation_date ?? null)
          /*
           * Swallowed on purpose — a template variable is not worth failing a
           * state transition's mail over — but not silently (round 267, M11).
           * `null` here and "this engagement has no valuation date on file"
           * are the same value, and the consequence reaches a client: a
           * white-label template naming `{{valuation_date}}` goes out with a
           * blank where the date should be, and the send itself succeeds, so
           * nothing downstream has a reason to look. The store beside this read
           * logs its own failures; this raw query had nobody.
           */
          .catch((err: unknown) => {
            deps.log?.warn(
              { err, valuationId: valuation.id },
              'valuation date could not be read — email templates naming it render blank',
            );
            return null;
          }),
        // swallow: the settings store logs its own read failures.
        deps.settings?.get('support_email').catch(() => null) ?? null,
      ])
    : [null, null];

  /**
   * This transition's templates, as this one recipient should read them.
   *
   * DB override first, partner override second, so white-label still wins —
   * the order the two were applied in before they moved in here.
   */
  const renderFor = (spec: EmailSpec, user: { email: string; first_name?: string | null }): EmailSpec => {
    if (!renders) return spec;
    const vars = {
      ...alwaysTemplateVars({
        recipient_name: user.first_name,
        recipient_email: user.email,
        platform_name: partner?.name,
        support_email: supportEmail,
      }),
      ...valuationLinkVars(deps.publicBaseUrl, valuation.id),
      ...valuationTemplateVars({
        ...valuation,
        valuation_date: valuationDate,
        partner_name: partner?.name ?? null,
      }),
    };
    const [withDb] = applyTemplateOverrides([spec], overrides, vars);
    if (!partner || Object.keys(partner.email_templates ?? {}).length === 0) return withDb!;
    // The same var bag the platform template was rendered with, not a
    // three-key subset of it. Rebuilt here, a partner's template writing
    // `{{kind_label}}` or `{{due_date}}` — names the platform's own seeded
    // copy uses — reached that partner's client as literal braces, while the
    // identical placeholder in the DB override beside it rendered correctly.
    // The three named ones stay explicit because the type requires them: they
    // are what the partner editor advertises, so they must never be the ones
    // that go missing.
    return applyPartnerEmailTemplates([withDb!], partner.email_templates, {
      ...vars,
      company_name: valuation.company_name,
      kind: valuation.kind,
      partner_name: partner.name,
    })[0]!;
  };

  const queued = await withTransaction(deps.pool, async (client) => {
    const out: EmailOutboxRow[] = [];
    for (const raw of emailSpecs) {
      const user = recipients.get(raw.recipient);
      if (!user) continue;
      if (!channelsFor(prefs, user.id, raw.templateKey).email) continue;
      const spec = renderFor(raw, user);
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
  const transport = deps.transport;
  for (const email of queued) {
    // The success and failure halves are recorded by different callbacks, so a
    // database blip while marking a *delivered* message cannot be written down
    // as the relay refusing it — see email/sendAttempt.ts.
    await sendAndRecord(transport, email, {
      log: deps.log,
      context: { valuationId: valuation.id },
      onSent: () => markEmail(deps.pool, email.id, 'sent'),
      onFailed: async (err) => {
        try {
          await markEmail(deps.pool, email.id, 'failed', describeTransportFailure(err));
          // Terminal rejection of the recipient stops the ladder and suppresses
          // the address (0163); anything else stays retryable.
          /*
           * `null` from this write is not the same `null` as "the provider
           * did not reject the recipient" (round 267, methodology M11), and
           * the line below prints both as `bounce: null`. A terminal bounce
           * that could not be recorded leaves the address *unsuppressed*, so
           * the ladder keeps sending to a mailbox that has hard-rejected us —
           * the one outcome `recordSendFailure` exists to stop, reached
           * through the catch written so it could not stop the send loop.
           */
          const bounce = await recordSendFailure(deps.pool, email, err).catch((bookErr: unknown) => {
            if (deps.log) {
              logUnretried(
                deps.log,
                bookErr,
                { emailId: email.id, valuationId: valuation.id },
                'send failure could not be recorded — a terminal bounce has not suppressed the address',
              );
            }
            return null;
          });
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
      },
    });
  }
}
