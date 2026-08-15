import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { isUlid, problems } from '@n409/shared';
import { FixedWindowRateLimiter } from '../plugins/rateLimit.js';
import { isOps, REPORT_VISIBLE_STATES, type Principal } from '../auth/rbac.js';
import { findValuationById } from '../repos/valuations.js';
import { findParams } from '../repos/params.js';
import { findReportByValuation, getVersion } from '../repos/reports.js';
import { latestSucceededCalculation } from '../repos/calculations.js';
import { listQaReviews } from '../repos/qaReviews.js';
import {
  createAuditorAccess,
  listAuditorAccess,
  redeemAuditorToken,
  revokeAuditorAccess,
  toPublic,
} from '../repos/auditorAccess.js';
import { requirePrincipal } from '../plugins/auth.js';

/**
 * External auditor portal (feature 8). An ops user (or the valuation owner)
 * mints a shareable, expiring link; an outside auditor opens it — without an
 * account — and sees a read-only bundle for that one valuation: the report
 * (once it has been shared), the assumptions, an evidence summary and the
 * audit-defense Q&A. No billing, no other clients, no admin surface is
 * reachable through the token.
 */

const MAX_EXPIRY_DAYS = 180;
const CreateBody = z.object({
  label: z.string().trim().max(200).optional(),
  expires_in_days: z.number().int().min(1).max(MAX_EXPIRY_DAYS).default(30),
});
const RedeemBody = z.object({ token: z.string().min(1) });

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
  deps: { pool: pg.Pool; publicBaseUrl: string; limiter?: FixedWindowRateLimiter },
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
    if (!parsed.success) throw problems.unprocessable('Invalid request', { errors: parsed.error.issues });

    const expiresAt = new Date(Date.now() + parsed.data.expires_in_days * 24 * 60 * 60 * 1000);
    const { access, token } = await createAuditorAccess(deps.pool, {
      valuationId: valuation.id,
      label: parsed.data.label,
      expiresAt,
      createdBy: principal.id,
    });
    const url = `${deps.publicBaseUrl.replace(/\/$/, '')}/auditor#token=${token}`;
    // The raw token + URL are returned once and never again.
    return reply.status(201).send({ access: toPublic(access), token, url });
  });

  app.get('/api/v1/valuations/:id/auditor-access', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    const { id } = req.params as { id: string };
    const valuation = await loadManageable(principal, id);
    const rows = await listAuditorAccess(deps.pool, valuation.id);
    return { access: rows.map(toPublic) };
  });

  app.delete(
    '/api/v1/valuations/:id/auditor-access/:accessId',
    { preHandler: app.authenticate },
    async (req, reply) => {
      const principal = requirePrincipal(req);
      const { id, accessId } = req.params as { id: string; accessId: string };
      const valuation = await loadManageable(principal, id);
      if (!(await revokeAuditorAccess(deps.pool, valuation.id, accessId))) throw problems.notFound();
      return reply.status(204).send();
    },
  );

  // ── Public portal: token-authenticated, read-only, single valuation ──────
  // POST so the token stays out of URLs/server logs (the SPA reads it from the
  // link fragment and posts it here).
  app.post('/api/v1/auditor/portal', async (req) => {
    const { allowed, resetAt } = limiter.check(req.ip);
    if (!allowed) {
      throw problems.tooManyRequests(
        'Too many requests — please try again later',
        Math.max(1, Math.ceil((resetAt - Date.now()) / 1000)),
      );
    }
    const parsed = RedeemBody.safeParse(req.body);
    if (!parsed.success) throw problems.unprocessable('Invalid request', { errors: parsed.error.issues });
    const access = await redeemAuditorToken(deps.pool, parsed.data.token);
    if (!access) throw problems.unauthorized('This auditor link is invalid, expired, or revoked');

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
      const version = await getVersion(deps.pool, reportRow.id, reportRow.current_version);
      report = version
        ? { template_version: reportRow.template_version, status: reportRow.status, content: version.content }
        : null;
    }

    // Assumptions: methodology params + the analyst-entered engine inputs, plus
    // the concluded figures from the latest calculation.
    const params = await findParams(deps.pool, valuation.id);
    const calc = await latestSucceededCalculation(deps.pool, valuation.id);
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

    const qa = await listQaReviews(deps.pool, valuation.id);

    return {
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
          }
        : null,
      qa: qa.map((q) => ({ id: q.id, status: q.status, checks: q.checks, created_at: q.created_at })),
      evidence_summary: {
        // The full evidence ZIP stays ops-only; the portal confirms what backs
        // the conclusion without exposing raw client documents.
        has_report: report !== null,
        has_conclusion: calc !== null,
        qa_count: qa.length,
        assumptions_recorded: assumptions !== null,
      },
      access_expires_at: access.expires_at,
    };
  });
}
