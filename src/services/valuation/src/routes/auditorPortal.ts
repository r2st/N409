import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { isUlid, logUnretried, problems } from '@n409/shared';
import { FixedWindowRateLimiter } from '../plugins/rateLimit.js';
import { isOps, REPORT_VISIBLE_STATES, type Principal } from '../auth/rbac.js';
import { reportStatusFor } from '../domain/report.js';
import { findValuationById } from '../repos/valuations.js';
import { findParams } from '../repos/params.js';
import { deliverableVersion, findReportByValuation, getVersionContent } from '../repos/reports.js';
import { latestCalculationForKind } from '../repos/calculations.js';
import { listQaReviews } from '../repos/qaReviews.js';
import { headlineLabels } from '../domain/specialty.js';
import {
  AUDITOR_ACCESS_PAGE_LIMIT,
  createAuditorAccess,
  listAuditorAccess,
  redeemAuditorToken,
  revokeAuditorAccess,
  toPublic,
  verifyAuditorToken,
} from '../repos/auditorAccess.js';
import { createComment } from '../repos/comments.js';
import { createNotifications } from '../repos/notifications.js';
import { findUsersByIds, listUserIdsWithRoles } from '../repos/users.js';
import { AUDITOR_NOTE_ROLES } from '../domain/roles.js';
import { sliceChars } from '../domain/textSlice.js';
import type { ValuationHub } from '../realtime/hub.js';
import { requirePrincipal } from '../plugins/auth.js';
import { invalidBody } from '../domain/validationProblem.js';
import { DEAD_LINK_DETAIL } from '../domain/linkRefusal.js';
import { recordThrottleRefusal } from '../observability/requestThrottle.js';

/**
 * External auditor portal (feature 8). An ops user (or the valuation owner)
 * mints a shareable, expiring link; an outside auditor opens it — without an
 * account — and sees a read-only bundle for that one valuation: the report
 * (once it has been shared), the assumptions, an evidence summary and the
 * audit-defense Q&A. No billing, no other clients, no admin surface is
 * reachable through the token.
 */

const MAX_EXPIRY_DAYS = 180;
const CreateBody = z
  .object({
    label: z.string().trim().max(200).optional(),
    expires_in_days: z.number().int().min(1).max(MAX_EXPIRY_DAYS).default(30),
  })
  .strict();
const RedeemBody = z.object({ token: z.string().min(1) });

/**
 * What an auditor can put on the record, and the three things they ever want to
 * say about a deliverable they have been sent.
 *
 * Not a workflow state. Recording an auditor's disposition as an engagement
 * state would make an outside party — one holding a link, with no account and
 * no seat in the firm — able to move a valuation through its lifecycle, and the
 * lifecycle is exactly where the QA gate and the signature live. It is a
 * heading on a message: it tells the reviewer whether to read this now, and it
 * is the reviewer who then acts.
 */
const DISPOSITIONS = {
  question: 'Auditor question',
  change_requested: 'Auditor requested a change',
  approved: 'Auditor signed off',
} as const;
type Disposition = keyof typeof DISPOSITIONS;

const NoteBody = z.object({
  token: z.string().min(1),
  disposition: z.enum(['question', 'change_requested', 'approved']),
  body: z.string().trim().min(1).max(20_000),
});

/**
 * The portal redeem route authenticates with nothing but the link's token, so
 * an unlimited endpoint is an oracle for guessing one — and a hit returns an
 * entire client valuation. 30 per IP per 10 minutes: an auditor reloads the
 * page a handful of times, an enumeration run does not.
 */
const PORTAL_RATE_LIMIT = 30;
const PORTAL_RATE_WINDOW_MS = 10 * 60 * 1000;

export function registerAuditorPortalRoutes(
  app: FastifyInstance,
  deps: { pool: pg.Pool; publicBaseUrl: string; limiter?: FixedWindowRateLimiter; hub?: ValuationHub },
): void {
  const limiter = deps.limiter ?? new FixedWindowRateLimiter(PORTAL_RATE_LIMIT, PORTAL_RATE_WINDOW_MS);
  const loadManageable = async (principal: Principal, id: string) => {
    if (!isUlid(id)) throw problems.notFound();
    const valuation = await findValuationById(deps.pool, id);
    // Only ops or the valuation owner may grant/see auditor access.
    if (!valuation || (!isOps(principal) && valuation.user_id !== principal.id)) {
      throw problems.notFound();
    }
    return valuation;
  };

  /**
   * A retired engagement is not shareable, and stops being shared.
   *
   * `archived_at` is the platform's soft delete — stamped by the retention
   * sweep when a policy period runs out, and by `retireValuations` when a firm
   * withdraws a piece of work. R55/R56 took retired engagements out of every
   * list, and R57 found the residue: a list that no longer offers something is
   * not the same as a write that refuses it, because the page stays reachable
   * by id.
   *
   * This is the same shape one step further out. The reader here holds a link
   * rather than an account, and what the link returns is the conclusion, the
   * assumptions and the report itself — so the gap was not a stale page, it was
   * a third party still being served a deliverable the firm has withdrawn, for
   * as much as 180 days after the sweep that was supposed to end its retention.
   * Nothing revokes the outstanding links when a valuation is archived, and
   * nothing could reasonably be expected to: they are minted per auditor and
   * live in their inboxes. So the check belongs at redemption, where the
   * current state of the engagement is known.
   *
   * The mint route refuses for the same reason — R57's lesson, that stopping
   * the read without stopping the write leaves the write.
   */
  const RETIRED = 'This engagement has been retired and is no longer available.';

  app.post('/api/v1/valuations/:id/auditor-access', { preHandler: app.authenticate }, async (req, reply) => {
    const principal = requirePrincipal(req);
    const { id } = req.params as { id: string };
    const valuation = await loadManageable(principal, id);
    if (valuation.archived_at !== null) throw problems.conflict(RETIRED);
    const parsed = CreateBody.safeParse(req.body ?? {});
    if (!parsed.success) throw invalidBody('Invalid request', parsed.error);

    const expiresAt = new Date(Date.now() + parsed.data.expires_in_days * 24 * 60 * 60 * 1000);
    const { access, token } = await createAuditorAccess(
      deps.pool,
      {
        valuationId: valuation.id,
        label: parsed.data.label,
        expiresAt,
        createdBy: principal.id,
      },
      // On the engagement's spine, in the transaction that mints the row. See
      // `createAuditorAccess` for why the register of grants is not the record.
      { actorType: 'human', actorId: principal.id, source: 'api' },
    );
    const url = `${deps.publicBaseUrl.replace(/\/$/, '')}/auditor#token=${token}`;
    // The raw token + URL are returned once and never again.
    return reply.status(201).send({ access: toPublic(access), token, url });
  });

  app.get('/api/v1/valuations/:id/auditor-access', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    const { id } = req.params as { id: string };
    const valuation = await loadManageable(principal, id);
    const { grants, truncated } = await listAuditorAccess(deps.pool, valuation.id);
    return { access: grants.map(toPublic), truncated, page_limit: AUDITOR_ACCESS_PAGE_LIMIT };
  });

  app.delete(
    '/api/v1/valuations/:id/auditor-access/:accessId',
    { preHandler: app.authenticate },
    async (req, reply) => {
      const principal = requirePrincipal(req);
      const { id, accessId } = req.params as { id: string; accessId: string };
      const valuation = await loadManageable(principal, id);
      const revoked = await revokeAuditorAccess(deps.pool, valuation.id, accessId, {
        actorType: 'human',
        actorId: principal.id,
        source: 'api',
      });
      // 404 covers both "no such grant" and "already revoked" — the statement's
      // `revoked_at IS NULL` makes the second a no-op, and the event is written
      // only on the pass that changed something.
      if (!revoked) throw problems.notFound();
      return reply.status(204).send();
    },
  );

  // ── Public portal: token-authenticated, read-only, single valuation ──────
  // POST so the token stays out of URLs/server logs (the SPA reads it from the
  // link fragment and posts it here).
  app.post('/api/v1/auditor/portal', async (req) => {
    const { allowed, resetAt } = limiter.check(req.ip);
    if (!allowed) {
      // See `observability/requestThrottle.ts`: the person refused here has no
      // account and no console, so this box is the only place the refusal can
      // be seen at all — and a firm behind one office NAT spends this budget
      // collectively.
      recordThrottleRefusal('auditor-portal');
      throw problems.tooManyRequests(
        'Too many requests to this auditor link from your connection',
        Math.max(1, Math.ceil((resetAt - Date.now()) / 1000)),
      );
    }
    const parsed = RedeemBody.safeParse(req.body);
    if (!parsed.success) throw invalidBody('Invalid request', parsed.error);
    const access = await redeemAuditorToken(deps.pool, parsed.data.token);
    if (!access) throw problems.unauthorized(DEAD_LINK_DETAIL.auditor);

    const valuation = await findValuationById(deps.pool, access.valuation_id);
    if (!valuation) throw problems.notFound();
    // Not `unauthorized`: the token is genuine and the holder was authorised
    // for this engagement, so telling them it has been withdrawn discloses
    // nothing they did not already know and is the answer they can act on.
    if (valuation.archived_at !== null) throw problems.notFound(RETIRED);

    // Report content (current shared version), if any.
    //
    // Gated on the same states `canReadReport` gates every other reader on. A
    // report row exists from the moment an analyst instantiates the template,
    // and ops render and re-render it to check their own work long before
    // `drafted` — so serving `current_version` on state alone handed an outside
    // auditor a working draft that the client themselves is answered 404 for.
    //
    // Which mattered most for the one reader who is not outside: `loadManageable`
    // lets the valuation's *owner* mint a link, so a client who wanted to see
    // the draft early could mint themselves an auditor token and read through
    // this endpoint exactly what `GET /report` had just refused them. A token
    // that grants more than the account that minted it is not a sharing link,
    // it is a way around the gate.
    //
    // The rest of the bundle is unchanged: the conclusion, the assumptions and
    // the QA record are what an auditor is here for and are not the deliverable.
    let report: { template_version: string; status: string; content: unknown } | null = null;
    const reportShared = REPORT_VISIBLE_STATES.has(valuation.state);
    const reportRow = reportShared ? await findReportByValuation(deps.pool, valuation.id) : null;
    if (reportRow) {
      // The version that was issued, not the newest one somebody has typed.
      // Saving a body after publication is allowed and the publish gate never
      // runs again, so on a published engagement the two are different
      // questions — see `deliverableVersion`, which is where R319's answer for
      // the PDF now lives so this door gives the same one.
      const version = await getVersionContent(
        deps.pool,
        reportRow.id,
        await deliverableVersion(deps.pool, reportRow, valuation.state),
      );
      report = version
        ? {
            template_version: reportRow.template_version,
            status: reportStatusFor(valuation.state),
            content: version.content,
          }
        : null;
    }

    /*
     * Why there is no report, when there is no report.
     *
     * `report: null` carries two entirely different facts and the portal could
     * not tell them apart, so it rendered nothing at all and said nothing —
     * which is the third possibility a reader assumes: that the page is broken,
     * or that they are being refused. An auditor sent a link and shown a
     * company name with no document underneath it has no way to know whether to
     * wait, to ask, or to report a fault, and no account through which to find
     * out. The states are the server's to distinguish, so it does.
     */
    const reportStatus: 'available' | 'not_shared' | 'not_started' = report
      ? 'available'
      : reportShared
        ? 'not_started'
        : 'not_shared';

    // Assumptions: methodology params + the analyst-entered engine inputs, plus
    // the concluded figures from the latest calculation.
    const params = await findParams(deps.pool, valuation.id);
    // The run this bundle's captions are describing — see
    // `latestCalculationForKind`. Simply the newest succeeded run let a 409A
    // compute on a specialty engagement put its equity value under the other
    // engine's heading, to an outside reader with nobody present to correct it.
    const calc = await latestCalculationForKind(deps.pool, valuation.id, valuation.kind);
    const assumptions = params
      ? {
          allocation_method: params.allocation_method,
          weights: {
            asset: params.weight_asset,
            opm: params.weight_opm,
            income: params.weight_income,
            market: params.weight_market,
          },
          dloc: params.dloc,
          dlom: params.dlom,
          dlom_method: params.dlom_method,
          exit_timeline: params.exit_timeline,
          engine_inputs: params.engine_inputs ?? {},
        }
      : null;

    const { reviews: qa, truncated: qaTruncated } = await listQaReviews(deps.pool, valuation.id);

    return {
      report_status: reportStatus,
      valuation: {
        id: valuation.id,
        number: valuation.number,
        company_name: valuation.company_name,
        kind: valuation.kind,
        state: valuation.state,
        currency: valuation.currency,
      },
      report,
      assumptions,
      conclusion: calc
        ? {
            equity_value: calc.equity_value,
            fmv_per_share: calc.fmv_per_share,
            engine_version: calc.engine_version,
            /*
             * What those two columns hold on this kind, captioned here rather
             * than in the page.
             *
             * A specialty engine writes its headline into the 409A-named
             * columns (domain/specialty.ts), so the portal was captioning an
             * IFRS 2 total expense "Equity value" and an EMI actual market
             * value "Concluded FMV / share" — the two figures an outside
             * auditor reads first, and the only context they are given. Sent
             * with the figures so the portal and the exported workbook cannot
             * disagree about what a number is called.
             */
            equity_label: headlineLabels(valuation.kind).equity,
            fmv_per_share_label: headlineLabels(valuation.kind).perShare,
          }
        : null,
      qa: qa.map((q) => ({ id: q.id, status: q.status, checks: q.checks, created_at: q.created_at })),
      evidence_summary: {
        // The full evidence ZIP stays ops-only; the portal confirms what backs
        // the conclusion without exposing raw client documents.
        has_report: report !== null,
        has_conclusion: calc !== null,
        qa_count: qa.length,
        // `qa_count` is a count of the rows this response carries, so the flag
        // has to travel with it: an auditor reading "3 QA reviews" off a capped
        // page is being told a number, not shown a list.
        qa_truncated: qaTruncated,
        assumptions_recorded: assumptions !== null,
      },
      access_expires_at: access.expires_at,
      /** Whether this link may write back — see the notes route below. */
      can_submit_notes: valuation.archived_at === null,
    };
  });

  /**
   * The auditor's half of the review, which did not exist.
   *
   * The portal served a report, a conclusion, the assumptions and the QA record
   * to an outside reviewer and gave them nowhere to put the answer. Every other
   * route into this engagement's thread requires an account, and an auditor is
   * the one reader defined by not having one — so a reviewer who found a
   * problem in a signed deliverable had to leave the product, find someone's
   * email address, and describe which valuation they meant. That round trip is
   * the whole reason the link was minted, and it happened entirely off the
   * record: nothing in the engagement's audit trail showed that an auditor had
   * ever raised anything.
   *
   * The note lands in the engagement's own comment thread as an `email`-kind
   * comment. That kind is not a guess at the transport — it is this platform's
   * vocabulary for a message from a correspondent with no account (see
   * `visibleCommentKinds`), which is exactly what this is, and it is the kind
   * the thread already renders with the sender's name rather than an avatar.
   * Ops-visible, like every other message of that kind: an auditor's finding is
   * addressed to the engagement team, and routing it to the client before an
   * analyst has read it would forward a criticism of our own work.
   *
   * What the auditor may *not* do here is move the engagement. See DISPOSITIONS.
   */
  app.post('/api/v1/auditor/portal/notes', async (req, reply) => {
    // The same limiter and the same window as the read. A write is at least as
    // good an oracle for guessing a token as a read is, and it is worth less to
    // the honest caller: an auditor writes a note once, and reloads the page a
    // dozen times to write it.
    const { allowed, resetAt } = limiter.check(req.ip);
    if (!allowed) {
      // See `observability/requestThrottle.ts`: the person refused here has no
      // account and no console, so this box is the only place the refusal can
      // be seen at all — and a firm behind one office NAT spends this budget
      // collectively.
      recordThrottleRefusal('auditor-portal');
      throw problems.tooManyRequests(
        'Too many requests to this auditor link from your connection',
        Math.max(1, Math.ceil((resetAt - Date.now()) / 1000)),
      );
    }
    const parsed = NoteBody.safeParse(req.body);
    if (!parsed.success) throw invalidBody('Invalid note', parsed.error);
    const { token, disposition, body } = parsed.data;

    // Verified rather than redeemed: submitting a note is not opening the link,
    // and `access_count` is what ops read to decide whether a link is still in
    // use. See `verifyAuditorToken`.
    const access = await verifyAuditorToken(deps.pool, token);
    if (!access) throw problems.unauthorized(DEAD_LINK_DETAIL.auditor);

    const valuation = await findValuationById(deps.pool, access.valuation_id);
    // Not a bare 404. The reader is outside the product with no account to ask
    // from, and a bare "Not Found" on a link that just rendered a report is
    // indistinguishable to them from a bug in the form they typed into — so it
    // reads as "resend it" rather than "ask for a new link".
    if (!valuation) throw problems.notFound('The valuation this link was issued for is no longer available.');
    // The same refusal the read gives, for the same reason and in the same
    // words: a withdrawn engagement is not accepting anything, and an auditor
    // whose note vanished into one would have no way to discover that.
    if (valuation.archived_at !== null) throw problems.notFound(RETIRED);

    const heading = DISPOSITIONS[disposition as Disposition];
    // The label is what ops named this link when they minted it — the auditor's
    // firm, usually. It is the only identity the holder of a token has, so a
    // link minted without one says so rather than being attributed to nobody.
    const from = access.label?.trim() ? `Auditor · ${access.label.trim()}` : 'Auditor (unlabelled link)';

    const { comment } = await createComment(
      deps.pool,
      {
        valuationId: valuation.id,
        kind: 'email',
        authorId: null,
        body,
        emailMeta: { from, subject: heading },
        // Not `email_received`. See CreateCommentInput.eventType: the kind says
        // how it arrived, this says what happened.
        eventType: 'auditor_note_received',
      },
      { actorType: 'system', actorId: access.id, source: 'auditor_portal' },
    );
    deps.hub?.broadcast(valuation.id, 'comment', { comment_id: comment.id, kind: comment.kind });

    /*
     * Somebody has to be told, or this is a message in a thread nobody opened.
     *
     * The assigned reviewer because it is their file, and AUDITOR_NOTE_ROLES
     * because an engagement with no reviewer assigned — or one whose reviewer
     * has left — must not be the case where an auditor's finding is silently
     * filed. Best-effort: the note is already committed and reporting a
     * notification failure as a 5xx would tell the auditor their submission had
     * failed when it had not, and the obvious response to that is to send it
     * again.
     */
    try {
      const recipients = new Set([
        ...(valuation.assigned_reviewer_id ? [valuation.assigned_reviewer_id] : []),
        ...(await listUserIdsWithRoles(deps.pool, AUDITOR_NOTE_ROLES)),
      ]);
      // `listUserIdsWithRoles` drops deactivated accounts; the reviewer id came
      // off the engagement row, which records who was assigned and not whether
      // they still work here. The comment above names "one whose reviewer has
      // moved on" as the case the role set covers — it only covers it if the
      // departed reviewer is dropped rather than sent a notification nobody can
      // sign in to read.
      const live = await findUsersByIds(deps.pool, [...recipients]);
      await createNotifications(
        deps.pool,
        [...recipients]
          .filter((userId) => live.has(userId))
          .map((userId) => ({
            userId,
            valuationId: valuation.id,
            type: 'auditor_note_received',
            title: `${heading} — ${valuation.company_name}`,
            // `sliceChars`, not `slice`: an auditor's note ending in an astral
            // character cut at 300 leaves an unpaired surrogate, which Postgres
            // stores as U+FFFD (domain/textSlice.ts).
            body: `${from} on ${valuation.number}: ${sliceChars(body, 300)}`,
          })),
      );
    } catch (err) {
      logUnretried(req.log, err, { valuationId: valuation.id }, 'auditor note notification failed');
    }

    // Echoed back so the portal can show the auditor what it recorded rather
    // than only that it succeeded — a submission whose only feedback is the
    // form clearing reads as a submission that was lost.
    return reply.status(201).send({
      note: { disposition, heading, from, body, created_at: comment.created_at },
    });
  });
}
