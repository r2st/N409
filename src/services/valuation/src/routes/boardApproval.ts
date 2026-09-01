import type { FastifyInstance, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { isIsoCalendarDate, isUlid, logUnretried, problems } from '@n409/shared';
import { FixedWindowRateLimiter } from '../plugins/rateLimit.js';
import { isOps, type Principal } from '../auth/rbac.js';
import { findValuationById, type ValuationRow } from '../repos/valuations.js';
import { latestSucceededCalculation } from '../repos/calculations.js';
import { concludes409AFmvPerShare, headlineLabels, specialtyRunKind } from '../domain/specialty.js';
import { kindLabel } from '../domain/valuationSelector.js';
import { requirePrincipal } from '../plugins/auth.js';
import { sendTransactionalEmail } from '../email/transactional.js';
import type { EmailTransport } from '../hooks/stateChange.js';
import { todayLocal } from '../domain/calendarDate.js';
import { nonBlankText } from '../domain/nonBlankText.js';
import { DEFAULT_APPRAISER_QUALIFICATIONS, renderBoardResolution } from '../domain/boardResolution.js';
import {
  addBoardMember,
  deleteBoardMember,
  countBoardMembers,
  findResolutionByValuation,
  findSignoffById,
  findSignoffByTokenHash,
  hashToken,
  listBoardMembers,
  markMemberSent,
  mintSignoffToken,
  recordSignoff,
  remintSignoffToken,
  upsertResolution,
  type BoardResolutionRow,
  type BoardSignoffRow,
} from '../repos/boardApprovals.js';
import { invalidBody } from '../domain/validationProblem.js';
import { DEAD_LINK_DETAIL } from '../domain/linkRefusal.js';
import type { SupportEmailSource } from '../hooks/autoEmails.js';

/**
 * Board approval workflow (feature 5). Ops generate a board resolution from the
 * concluded FMV, add board members, and email each a signing link. Board
 * members sign via a public token endpoint; once every member has signed the
 * resolution flips to 'approved' and stamps the safe-harbor approval time.
 */

const GenerateBody = z.object({
  valuation_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'valuation_date must be YYYY-MM-DD')
    .refine(isIsoCalendarDate, 'Not a real calendar date')
    .optional(),
  // Bounded above as well as below: the figure is printed on a board
  // resolution, and `1e999` is Infinity to zod's `.positive()` and `null` to
  // the JSON that stores it. $1e12/share is not a conclusion.
  fmv_conclusion: z.number().positive().max(1e12).optional(),
  methodology_summary: z.string().min(1).max(4000).optional(),
  appraiser_qualifications: z.string().min(1).max(4000).optional(),
});

const MemberBody = z.object({
  name: nonBlankText(2, 200),
  email: z.string().email().max(320),
  title: z.string().max(200).nullable().optional(),
});

const SignBody = z.object({
  token: z.string().min(10).max(200),
  decision: z.enum(['signed', 'rejected']),
  comment: z.string().max(2000).nullable().optional(),
});

const ResolutionBody = z.object({ token: z.string().min(1).max(200) });

/**
 * The two public routes below authenticate with nothing but a sign-off token,
 * so without a limit they are an unbounded oracle for guessing one. 30 requests
 * per IP per 10 minutes is far more than a board member signing a document
 * needs, and useless for a search of the token space.
 */
const BOARD_PUBLIC_RATE_LIMIT = 30;
const BOARD_PUBLIC_RATE_WINDOW_MS = 10 * 60 * 1000;

/**
 * One answer for "no such token" and "that token has expired" alike.
 *
 * These routes authenticate on the token alone, so telling the two apart tells
 * a guesser which of their guesses was once real. Naming expiry as a
 * possibility is still worth doing: a director whose link lapsed needs to know
 * to ask for another rather than to conclude the system is broken, and the
 * sentence says that without saying which case they are in.
 */
const DEAD_TOKEN_DETAIL = DEAD_LINK_DETAIL.board;

function requireOps(principal: Principal): void {
  if (!isOps(principal)) throw problems.forbidden('Board approval is operations-only');
}

async function loadValuation(pool: pg.Pool, id: string): Promise<ValuationRow> {
  if (!isUlid(id)) throw problems.notFound();
  const valuation = await findValuationById(pool, id);
  if (!valuation) throw problems.notFound();
  return valuation;
}

/**
 * A retired engagement does not ask a board to adopt its conclusion.
 *
 * Same shape as the auditor portal, and the same two places: a link minted per
 * outside party, living in their inbox, redeemed later. Nothing revokes those
 * links when `archived_at` is stamped — the retention sweep does not know they
 * exist — so both ends have to be checked, because stopping one leaves the
 * other. R57's lesson was that a list which stops offering something is not a
 * write that refuses it; this is the version one step further out, where the
 * holder has no account at all.
 *
 * What made it worse here than a stale page is what the link is *for*. The
 * auditor's link serves a deliverable; this one asks a director to sign a
 * resolution adopting an FMV as the board's own — a governance record with a
 * date on it, created by someone outside the firm, for a piece of work the firm
 * has withdrawn. `POST /board/members/:memberId/send` re-mints the token on
 * every send, so a retired engagement could go on issuing *fresh* signing links
 * indefinitely.
 *
 * Reads are left alone, deliberately, and so is removing a member: fetching the
 * resolution a token points at tells the holder nothing they were not already
 * given, and cleaning up the member list is the one thing ops should still be
 * able to do on a withdrawn file. What stops is minting, sending, and recording
 * a decision.
 */
const RETIRED = 'This engagement has been retired and is no longer accepting board sign-off.';

function refuseIfRetired(valuation: ValuationRow): void {
  if (valuation.archived_at !== null) throw problems.conflict(RETIRED);
}

/** Public view/DTO for a member sign-off — omits the token hash. */
function memberDto(row: BoardSignoffRow) {
  return {
    id: row.id,
    member_name: row.member_name,
    member_email: row.member_email,
    member_title: row.member_title,
    status: row.status,
    comment: row.comment,
    sent_at: row.sent_at,
    signed_at: row.signed_at,
    // The token's deadline, so the console can show ops a link that has lapsed
    // rather than leaving them to work it out from a member's complaint. The
    // hash itself stays out, as it always has.
    token_expires_at: row.token_expires_at,
    created_at: row.created_at,
  };
}

async function resolutionResponse(pool: pg.Pool, resolution: BoardResolutionRow) {
  const members = await listBoardMembers(pool, resolution.id);
  return { resolution, members: members.map(memberDto) };
}

/**
 * Ceiling on a resolution's sign-off list — see `countBoardMembers`, which is
 * where the reasoning for bounding the write rather than the read is written.
 */
export const MAX_BOARD_MEMBERS = 50;

export function registerBoardApprovalRoutes(
  app: FastifyInstance,
  deps: {
    pool: pg.Pool;
    transport?: EmailTransport;
    publicBaseUrl?: string;
    limiter?: FixedWindowRateLimiter;
    /** Answers `{{support_email}}` in an ops-authored override of the copy below. */
    settings?: SupportEmailSource;
  },
): void {
  const baseUrl = (deps.publicBaseUrl ?? 'http://localhost:3000').replace(/\/$/, '');
  const limiter =
    deps.limiter ?? new FixedWindowRateLimiter(BOARD_PUBLIC_RATE_LIMIT, BOARD_PUBLIC_RATE_WINDOW_MS);

  /** Per-IP throttle for the token-only public routes. */
  const throttlePublic = (req: FastifyRequest): void => {
    const { allowed, resetAt } = limiter.check(req.ip);
    if (!allowed) {
      throw problems.tooManyRequests(
        'Too many requests to this signing link from your connection',
        Math.max(1, Math.ceil((resetAt - Date.now()) / 1000)),
      );
    }
  };

  // Current resolution + member sign-off status (ops).
  app.get('/api/v1/valuations/:id/board', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    requireOps(principal);
    const { id } = req.params as { id: string };
    await loadValuation(deps.pool, id);
    const resolution = await findResolutionByValuation(deps.pool, id);
    if (!resolution) return { resolution: null, members: [] };
    return resolutionResponse(deps.pool, resolution);
  });

  // Generate (or regenerate) the board resolution from the concluded FMV.
  app.post('/api/v1/valuations/:id/board', { preHandler: app.authenticate }, async (req, reply) => {
    const principal = requirePrincipal(req);
    requireOps(principal);
    const { id } = req.params as { id: string };
    const valuation = await loadValuation(deps.pool, id);
    refuseIfRetired(valuation);

    const parsed = GenerateBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      throw invalidBody('Invalid resolution', parsed.error);
    }

    const calc = await latestSucceededCalculation(deps.pool, id);

    /*
     * The figure this document adopts has to be a §409A fair market value of
     * the common stock, because that is what the document says it is: the body
     * below cites Treasury Regulation §1.409A-1(b)(5)(iv)(B) and authorises
     * grants "with an exercise price no less than the fair market value adopted
     * herein", and `routes/grants.ts` then snapshots `fmv_conclusion` as the
     * exercise price of every option issued against it.
     *
     * `calculations.fmv_per_share` is a 409A column by name and every engine
     * writes into it (domain/specialty.ts). On an EMI or CSOP run what lands
     * there is the AMV — the *restricted* value, below the unrestricted market
     * value by the whole restriction discount — so defaulting to the column
     * adopted a below-FMV price and struck options at it, which is the §409A
     * failure this resolution exists to prevent. It failed silently: the number
     * is positive, the document renders, and nothing on the page distinguishes
     * two per-share values that differ by a discount.
     *
     * Asked of the *run* rather than the engagement's kind — `specialtyRunKind`
     * reads which engine wrote the row — because it is that row's number being
     * borrowed. An explicit `fmv_conclusion` is still honoured: an analyst
     * naming the figure has made the judgement themselves, and the API has
     * always offered that escape hatch.
     */
    const runKind = specialtyRunKind(calc?.results ?? null);
    const adoptable = runKind === null || concludes409AFmvPerShare(runKind);
    const derived = adoptable && calc?.fmv_per_share ? Number(calc.fmv_per_share) : null;
    const fmv = parsed.data.fmv_conclusion ?? derived;
    if (fmv === null || !Number.isFinite(fmv) || fmv <= 0) {
      // Two different situations, and "run a calculation" is a false
      // instruction in the second: one ran, it succeeded, and it concluded
      // something this document cannot adopt.
      if (runKind !== null) {
        const held = headlineLabels(runKind).perShare;
        throw problems.unprocessable(
          `A ${kindLabel(runKind)} does not conclude a §409A fair market value per share` +
            `${held === null ? '' : ` — it concludes ${held.toLowerCase()}`}` +
            ', which a board resolution adopting a 409A price may not be generated from. ' +
            'Pass fmv_conclusion to adopt a figure explicitly.',
        );
      }
      throw problems.unprocessable(
        'No concluded fair market value yet — run a calculation or pass fmv_conclusion',
      );
    }

    const valuationDate = parsed.data.valuation_date ?? todayLocal();
    const methodologySummary =
      parsed.data.methodology_summary ??
      'The fair market value was concluded using generally accepted valuation approaches ' +
        '(income, market and/or asset), with an option-pricing method allocation of equity value ' +
        'across the capital structure and a discount for lack of marketability.';
    const appraiserQualifications = parsed.data.appraiser_qualifications ?? DEFAULT_APPRAISER_QUALIFICATIONS;

    const bodyHtml = renderBoardResolution({
      companyName: valuation.company_name,
      valuationKind: valuation.kind,
      valuationDate,
      fmvConclusion: fmv,
      currency: valuation.currency,
      methodologySummary,
      appraiserQualifications,
      reference: valuation.id,
    });

    const resolution = await upsertResolution(
      deps.pool,
      {
        valuationId: id,
        valuationDate,
        fmvConclusion: fmv,
        currency: valuation.currency,
        methodologySummary,
        appraiserQualifications,
        bodyHtml,
        createdBy: principal.id,
      },
      { actorType: 'human', actorId: principal.id },
    );
    return reply.status(201).send(await resolutionResponse(deps.pool, resolution));
  });

  // Add a board member to the sign-off list (ops).
  app.post('/api/v1/valuations/:id/board/members', { preHandler: app.authenticate }, async (req, reply) => {
    const principal = requirePrincipal(req);
    requireOps(principal);
    const { id } = req.params as { id: string };
    refuseIfRetired(await loadValuation(deps.pool, id));
    const resolution = await findResolutionByValuation(deps.pool, id);
    if (!resolution) throw problems.conflict('Generate the resolution before adding board members');
    if (resolution.status === 'approved') {
      throw problems.conflict('The resolution is already approved');
    }

    const parsed = MemberBody.safeParse(req.body);
    if (!parsed.success) throw invalidBody('Invalid member', parsed.error);

    // The sign-off list is read uncapped on purpose — every member on it is
    // one the resolution is waiting for, so a page boundary would hide an
    // outstanding signature — which means the bound belongs here instead. No
    // real board is near this; a loop against this endpoint would be.
    //
    // And a loop that does not wait for each answer walked straight past this:
    // the count is one statement and the insert is another, so N simultaneous
    // adds all read the same figure and all commit. `addBoardMember` re-asks it
    // under the resolution's row lock, which is what actually holds; this stays
    // for the reason the `approved` check on the same route does — it answers
    // the ordinary, uncontended case before a token is minted or a transaction
    // opened.
    if ((await countBoardMembers(deps.pool, resolution.id)) >= MAX_BOARD_MEMBERS) {
      throw problems.conflict(
        `A resolution takes at most ${MAX_BOARD_MEMBERS} board members — remove one first`,
      );
    }

    const { token, hash } = mintSignoffToken();
    let member: BoardSignoffRow;
    try {
      member = await addBoardMember(
        deps.pool,
        {
          resolutionId: resolution.id,
          valuationId: id,
          name: parsed.data.name,
          email: parsed.data.email,
          title: parsed.data.title ?? null,
          tokenHash: hash,
          maxMembers: MAX_BOARD_MEMBERS,
        },
        { actorType: 'human', actorId: principal.id },
      );
    } catch (err) {
      if (err instanceof Error && /duplicate key|unique/i.test(err.message)) {
        throw problems.conflict('That board member is already on the sign-off list');
      }
      throw err;
    }
    // Return the raw token once so the ops UI can copy a link even without email.
    return reply.status(201).send({ member: memberDto(member), sign_token: token });
  });

  // Email a member their signing link (ops).
  app.post(
    '/api/v1/valuations/:id/board/members/:memberId/send',
    { preHandler: app.authenticate },
    async (req) => {
      const principal = requirePrincipal(req);
      requireOps(principal);
      const { id, memberId } = req.params as { id: string; memberId: string };
      const valuation = await loadValuation(deps.pool, id);
      refuseIfRetired(valuation);
      const member = await findSignoffById(deps.pool, memberId);
      if (!member || member.valuation_id !== id) throw problems.notFound();

      // Re-mint the token so the emailed link is always fresh (previous links
      // die), and with it the deadline the new link carries.
      const { token, hash } = mintSignoffToken();
      await remintSignoffToken(deps.pool, member.id, hash);
      const link = `${baseUrl}/board-sign#token=${token}`;

      /*
       * THE SEND AND THE STAMP ARE TWO STEPS, AND ONLY ONE OF THEM IS THE SEND
       * (R301, methodology M6).
       *
       * This route destroys the director's previous link before it does
       * anything else, so from here on the only working link is the one this
       * message carries. Both statements below were bare awaits inside a
       * handler with no catch, which made every failure after the re-mint
       * arrive as "the send failed" — and one of them is not.
       *
       * `markMemberSent` is a bookkeeping UPDATE that runs *after*
       * `sendTransactionalEmail` has enqueued the message and handed it to the
       * transport. Losing it answered 500 for a link that had left the
       * building, and left `sent_at` null so the list still reads "not sent".
       * The operator's reasonable next move is to press Send again — which
       * re-mints, and so revokes the link the director is at that moment
       * reading in their inbox. A bookkeeping blip therefore ends with a
       * director clicking a link they were legitimately sent and being told it
       * is no longer valid.
       *
       * This is the same rule `email/sendAttempt.ts` states for the outbox: the
       * transport step and the bookkeeping step must not share one catch,
       * because the second cannot describe the first. So the stamp is contained
       * and the route still answers `sent: true`, which is the true answer —
       * and `logUnretried`, because nothing revisits `sent_at`.
       *
       * The enqueue in front of it keeps failing the request, which is right:
       * no message exists, and the operator must know to send again. What it
       * needs is to say that the previous link died anyway, which is the one
       * fact a 500 alone does not carry.
       */
      try {
        await sendTransactionalEmail(
          { pool: deps.pool, transport: deps.transport, log: app.log, settings: deps.settings },
          {
            valuationId: valuation.id,
            toEmail: member.member_email,
            recipientName: member.member_name,
            templateKey: 'board_resolution_signoff',
            subject: `Board resolution to sign — ${valuation.company_name}`,
            body:
              `Dear ${member.member_name},\n\n` +
              `The board resolution adopting the fair market value of ${valuation.company_name}'s ` +
              `common stock is ready for your signature.\n\n` +
              `Review and sign here: ${link}\n\n` +
              `This link is unique to you. Thank you.`,
            vars: {
              member_name: member.member_name,
              company_name: valuation.company_name,
              link,
            },
          },
        );
      } catch (err) {
        // The old link is already gone — `remintSignoffToken` committed above —
        // so this is not a no-op failure the operator can ignore. Said out loud
        // because the 500 they see cannot say it.
        logUnretried(
          app.log,
          err,
          { valuationId: valuation.id, memberId: member.id },
          'board sign-off link could not be queued, and the member’s previous link is already revoked',
        );
        throw err;
      }
      await markMemberSent(deps.pool, member.id).catch((err: unknown) => {
        logUnretried(
          app.log,
          err,
          { valuationId: valuation.id, memberId: member.id },
          'board sign-off link was sent but not stamped; the list still reads “not sent” and a re-send would revoke it',
        );
      });
      return { sent: true };
    },
  );

  // Remove a board member (ops).
  app.delete(
    '/api/v1/valuations/:id/board/members/:memberId',
    { preHandler: app.authenticate },
    async (req, reply) => {
      const principal = requirePrincipal(req);
      requireOps(principal);
      const { id, memberId } = req.params as { id: string; memberId: string };
      await loadValuation(deps.pool, id);
      const member = await findSignoffById(deps.pool, memberId);
      if (!member || member.valuation_id !== id) throw problems.notFound();
      await deleteBoardMember(deps.pool, member, { actorType: 'human', actorId: principal.id });
      return reply.status(204).send();
    },
  );

  // Public: fetch the resolution a token grants access to (for the signing page).
  // POST so the token stays out of URLs, and therefore out of access logs,
  // Referer headers and browser history — the same reason /auditor/portal is a
  // POST. A signing token is a bearer credential; a query string is not a
  // private channel for one.
  app.post('/api/v1/board/resolution', async (req) => {
    throttlePublic(req);
    const parsed = ResolutionBody.safeParse(req.body);
    if (!parsed.success) throw problems.notFound(DEAD_TOKEN_DETAIL);
    const member = await findSignoffByTokenHash(deps.pool, hashToken(parsed.data.token));
    if (!member) throw problems.notFound(DEAD_TOKEN_DETAIL);
    const resolution = await findResolutionByValuation(deps.pool, member.valuation_id);
    if (!resolution) throw problems.notFound();
    return {
      member: { name: member.member_name, email: member.member_email, status: member.status },
      resolution: {
        body_html: resolution.body_html,
        status: resolution.status,
        valuation_date: resolution.valuation_date,
        fmv_conclusion: resolution.fmv_conclusion,
        currency: resolution.currency,
      },
    };
  });

  // Public: a board member records their decision via their token.
  app.post('/api/v1/board/sign', async (req) => {
    throttlePublic(req);
    const parsed = SignBody.safeParse(req.body);
    if (!parsed.success) throw invalidBody('Invalid sign-off', parsed.error);
    const member = await findSignoffByTokenHash(deps.pool, hashToken(parsed.data.token));
    if (!member) throw problems.notFound(DEAD_TOKEN_DETAIL);
    if (member.status !== 'pending') {
      throw problems.conflict('You have already recorded a decision on this resolution');
    }
    // Checked at redemption rather than by revoking tokens: the links are already
    // in directors' inboxes when `archived_at` is stamped, and the sweep that
    // stamps it has no idea they exist.
    refuseIfRetired(await loadValuation(deps.pool, member.valuation_id));
    const recorded = await recordSignoff(deps.pool, member, {
      status: parsed.data.decision,
      comment: parsed.data.comment ?? null,
    });
    // The check above is a read; the write is what actually claims the decision.
    // A concurrent request carrying the same token loses here, and gets the same
    // answer it would have got had it arrived a moment later.
    if (!recorded) {
      throw problems.conflict('You have already recorded a decision on this resolution');
    }
    const { signoff, resolution } = recorded;
    return {
      signoff: { status: signoff.status, signed_at: signoff.signed_at },
      resolution_status: resolution.status,
    };
  });
}
