import type { FastifyInstance, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { isIsoCalendarDate, isUlid, problems } from '@n409/shared';
import { FixedWindowRateLimiter } from '../plugins/rateLimit.js';
import { isOps, type Principal } from '../auth/rbac.js';
import { findValuationById, type ValuationRow } from '../repos/valuations.js';
import { latestSucceededCalculation } from '../repos/calculations.js';
import { requirePrincipal } from '../plugins/auth.js';
import { sendTransactionalEmail } from '../email/transactional.js';
import type { EmailTransport } from '../hooks/stateChange.js';
import { DEFAULT_APPRAISER_QUALIFICATIONS, renderBoardResolution } from '../domain/boardResolution.js';
import {
  addBoardMember,
  deleteBoardMember,
  findResolutionByValuation,
  findSignoffById,
  findSignoffByTokenHash,
  hashToken,
  listBoardMembers,
  markMemberSent,
  mintSignoffToken,
  recordSignoff,
  upsertResolution,
  type BoardResolutionRow,
  type BoardSignoffRow,
} from '../repos/boardApprovals.js';

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
  fmv_conclusion: z.number().positive().optional(),
  methodology_summary: z.string().min(1).max(4000).optional(),
  appraiser_qualifications: z.string().min(1).max(4000).optional(),
});

const MemberBody = z.object({
  name: z.string().min(2).max(200),
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

function requireOps(principal: Principal): void {
  if (!isOps(principal)) throw problems.forbidden('Board approval is operations-only');
}

async function loadValuation(pool: pg.Pool, id: string): Promise<ValuationRow> {
  if (!isUlid(id)) throw problems.notFound();
  const valuation = await findValuationById(pool, id);
  if (!valuation) throw problems.notFound();
  return valuation;
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
    created_at: row.created_at,
  };
}

async function resolutionResponse(pool: pg.Pool, resolution: BoardResolutionRow) {
  const members = await listBoardMembers(pool, resolution.id);
  return { resolution, members: members.map(memberDto) };
}

export function registerBoardApprovalRoutes(
  app: FastifyInstance,
  deps: {
    pool: pg.Pool;
    transport?: EmailTransport;
    publicBaseUrl?: string;
    limiter?: FixedWindowRateLimiter;
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
        'Too many requests — please try again later',
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

    const parsed = GenerateBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      throw problems.unprocessable('Invalid resolution', { errors: parsed.error.issues });
    }

    const calc = await latestSucceededCalculation(deps.pool, id);
    const fmv = parsed.data.fmv_conclusion ?? (calc?.fmv_per_share ? Number(calc.fmv_per_share) : null);
    if (fmv === null || !Number.isFinite(fmv) || fmv <= 0) {
      throw problems.unprocessable(
        'No concluded fair market value yet — run a calculation or pass fmv_conclusion',
      );
    }

    const valuationDate = parsed.data.valuation_date ?? new Date().toISOString().slice(0, 10);
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
    await loadValuation(deps.pool, id);
    const resolution = await findResolutionByValuation(deps.pool, id);
    if (!resolution) throw problems.conflict('Generate the resolution before adding board members');
    if (resolution.status === 'approved') {
      throw problems.conflict('The resolution is already approved');
    }

    const parsed = MemberBody.safeParse(req.body);
    if (!parsed.success) throw problems.unprocessable('Invalid member', { errors: parsed.error.issues });

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
      const member = await findSignoffById(deps.pool, memberId);
      if (!member || member.valuation_id !== id) throw problems.notFound();

      // Re-mint the token so the emailed link is always fresh (previous links die).
      const { token, hash } = mintSignoffToken();
      await deps.pool.query('UPDATE board_signoffs SET token_sha256 = $2 WHERE id = $1', [member.id, hash]);
      const link = `${baseUrl}/board-sign#token=${token}`;

      await sendTransactionalEmail(
        { pool: deps.pool, transport: deps.transport, log: app.log },
        {
          toEmail: member.member_email,
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
      await markMemberSent(deps.pool, member.id);
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
    if (!parsed.success) throw problems.notFound();
    const member = await findSignoffByTokenHash(deps.pool, hashToken(parsed.data.token));
    if (!member) throw problems.notFound();
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
    if (!parsed.success) throw problems.unprocessable('Invalid sign-off', { errors: parsed.error.issues });
    const member = await findSignoffByTokenHash(deps.pool, hashToken(parsed.data.token));
    if (!member) throw problems.notFound();
    if (member.status !== 'pending') {
      throw problems.conflict('You have already recorded a decision on this resolution');
    }
    const { signoff, resolution } = await recordSignoff(deps.pool, member, {
      status: parsed.data.decision,
      comment: parsed.data.comment ?? null,
    });
    return {
      signoff: { status: signoff.status, signed_at: signoff.signed_at },
      resolution_status: resolution.status,
    };
  });
}
