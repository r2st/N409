import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { problems } from '@n409/shared';
import { FixedWindowRateLimiter } from '../plugins/rateLimit.js';
import { isOps, valuationScope, type Principal } from '../auth/rbac.js';
import { computeCompletion, INTAKE_SECTIONS } from '../domain/intake.js';
import {
  filterIntakeAnswers,
  intakeLinkStatus,
  isIntakeLinkOpen,
  summarizeIntakeLink,
} from '../domain/clientIntake.js';
import { resolveBranding } from '../domain/branding.js';
import { findBrandingByPartnerId } from '../repos/branding.js';
import {
  createIntakeLink,
  findIntakeLink,
  listIntakeLinks,
  redeemIntakeToken,
  revokeIntakeLink,
  saveIntakeAnswers,
  submitIntakeLink,
  toPublicLink,
} from '../repos/clientIntake.js';
import { requirePrincipal } from '../plugins/auth.js';

/**
 * Firm-branded client intake.
 *
 * The questionnaire in routes/intake.ts belongs to a valuation and needs an
 * account. A firm taking on a new client has neither: intake is what the
 * engagement gets built from. So this is the same questionnaire, reached by a
 * shareable expiring link, scoped to a firm rather than a valuation, and
 * wearing that firm's brand.
 *
 * Two audiences, two access models. The firm side is session-authenticated and
 * scoped exactly as the firm console is. The client side authenticates with
 * nothing but the link's token — so it is rate-limited, write-narrow (it can
 * only ever touch its own row), and takes the token in the body rather than the
 * URL so it stays out of logs and referrers.
 */

const MAX_EXPIRY_DAYS = 90;

const CreateBody = z.object({
  client_name: z.string().trim().max(200).optional(),
  client_email: z.string().trim().email().max(320).optional(),
  label: z.string().trim().max(200).optional(),
  expires_in_days: z.number().int().min(1).max(MAX_EXPIRY_DAYS).default(30),
});

const TokenBody = z.object({ token: z.string().min(1) });
const SaveBody = TokenBody.extend({ answers: z.record(z.string(), z.unknown()) });

/**
 * The portal routes authenticate on the token alone, so an unlimited endpoint
 * is an oracle for guessing one. Higher than the auditor portal's 30 because a
 * client working through a four-section form saves far more often than an
 * auditor reloads a report — but still nowhere near an enumeration run.
 */
const PORTAL_RATE_LIMIT = 120;
const PORTAL_RATE_WINDOW_MS = 10 * 60 * 1000;

export function registerClientIntakeRoutes(
  app: FastifyInstance,
  deps: { pool: pg.Pool; publicBaseUrl: string; limiter?: FixedWindowRateLimiter },
): void {
  const limiter = deps.limiter ?? new FixedWindowRateLimiter(PORTAL_RATE_LIMIT, PORTAL_RATE_WINDOW_MS);

  /**
   * Which firm this request is about. Identical rule to the firm console: ops
   * name a firm, everyone else gets their own whatever they pass. Nobody gets
   * "all firms" — a cross-firm list of prospects is one firm's pipeline visible
   * to another.
   */
  const resolveFirm = (principal: Principal, requested?: string): string => {
    if (isOps(principal)) {
      const partnerId = requested ?? principal.partnerId;
      if (!partnerId) throw problems.badRequest('partner_id is required');
      return partnerId;
    }
    const scope = valuationScope(principal);
    if (scope.kind !== 'partner') throw problems.forbidden('Client intake is for firm accounts');
    if (requested && requested !== scope.partnerId)
      throw problems.forbidden('You can only manage your own firm');
    return scope.partnerId;
  };

  const linkUrl = (token: string) => `${deps.publicBaseUrl.replace(/\/$/, '')}/intake#token=${token}`;

  const PartnerQuery = z.object({ partner_id: z.string().optional() });

  // ── Firm side ────────────────────────────────────────────────────────────

  app.post('/api/v1/firm/intake-links', { preHandler: app.authenticate }, async (req, reply) => {
    const principal = requirePrincipal(req);
    const query = PartnerQuery.safeParse(req.query);
    if (!query.success) throw problems.badRequest('Invalid query');
    const partnerId = resolveFirm(principal, query.data.partner_id);

    const parsed = CreateBody.safeParse(req.body ?? {});
    if (!parsed.success) throw problems.unprocessable('Invalid request', { errors: parsed.error.issues });

    const expiresAt = new Date(Date.now() + parsed.data.expires_in_days * 24 * 60 * 60 * 1000);
    const { link, token } = await createIntakeLink(deps.pool, {
      partnerId,
      clientName: parsed.data.client_name,
      clientEmail: parsed.data.client_email,
      label: parsed.data.label,
      expiresAt,
      createdBy: principal.id,
    });

    // The raw token and its URL are returned once and never again.
    return reply.status(201).send({
      link: { ...toPublicLink(link), ...summarizeIntakeLink(link, new Date()) },
      token,
      url: linkUrl(token),
    });
  });

  app.get('/api/v1/firm/intake-links', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    const query = PartnerQuery.safeParse(req.query);
    if (!query.success) throw problems.badRequest('Invalid query');
    const partnerId = resolveFirm(principal, query.data.partner_id);

    const now = new Date();
    const rows = await listIntakeLinks(deps.pool, partnerId);
    return {
      links: rows.map((row) => ({ ...toPublicLink(row), ...summarizeIntakeLink(row, now) })),
    };
  });

  /** One link with the client's answers — the firm reading what came back. */
  app.get('/api/v1/firm/intake-links/:id', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    const { id } = req.params as { id: string };
    const query = PartnerQuery.safeParse(req.query);
    if (!query.success) throw problems.badRequest('Invalid query');
    const partnerId = resolveFirm(principal, query.data.partner_id);

    const row = await findIntakeLink(deps.pool, partnerId, id);
    if (!row) throw problems.notFound();

    const now = new Date();
    return {
      link: { ...toPublicLink(row), ...summarizeIntakeLink(row, now) },
      answers: row.answers ?? {},
      sections: INTAKE_SECTIONS,
    };
  });

  app.delete('/api/v1/firm/intake-links/:id', { preHandler: app.authenticate }, async (req, reply) => {
    const principal = requirePrincipal(req);
    const { id } = req.params as { id: string };
    const query = PartnerQuery.safeParse(req.query);
    if (!query.success) throw problems.badRequest('Invalid query');
    const partnerId = resolveFirm(principal, query.data.partner_id);

    if (!(await revokeIntakeLink(deps.pool, partnerId, id))) throw problems.notFound();
    return reply.status(204).send();
  });

  // ── Client side: public, token-authenticated ─────────────────────────────

  const rateLimit = (ip: string) => {
    const { allowed, resetAt } = limiter.check(ip);
    if (!allowed) {
      throw problems.tooManyRequests(
        'Too many requests — please try again later',
        Math.max(1, Math.ceil((resetAt - Date.now()) / 1000)),
      );
    }
  };

  /**
   * Open the form. Returns the firm's resolved brand, the questionnaire schema
   * and whatever the client has already answered.
   *
   * POST rather than GET so the token travels in the body — a token in a URL
   * ends up in access logs, browser history and any Referer the page emits.
   */
  app.post('/api/v1/intake/portal', async (req) => {
    rateLimit(req.ip);
    const parsed = TokenBody.safeParse(req.body);
    if (!parsed.success) throw problems.unprocessable('Invalid request', { errors: parsed.error.issues });

    const link = await redeemIntakeToken(deps.pool, parsed.data.token);
    if (!link) throw problems.unauthorized('This intake link is invalid, expired, or withdrawn');

    const now = new Date();
    const answers = link.answers ?? {};
    const branding = await findBrandingByPartnerId(deps.pool, link.partner_id);

    return {
      // The prospect sees the firm, never the firm's id or its other clients.
      firm: resolveBranding(branding),
      client_name: link.client_name,
      sections: INTAKE_SECTIONS,
      answers,
      completion: computeCompletion(answers),
      status: intakeLinkStatus(link, now),
      can_edit: isIntakeLinkOpen(link, now),
      submitted_at: link.submitted_at,
      expires_at: link.expires_at,
    };
  });

  /** Save progress. Merged server-side, so two open tabs cannot clobber. */
  app.post('/api/v1/intake/portal/answers', async (req) => {
    rateLimit(req.ip);
    const parsed = SaveBody.safeParse(req.body);
    if (!parsed.success) throw problems.unprocessable('Invalid request', { errors: parsed.error.issues });

    const answers = filterIntakeAnswers(parsed.data.answers);
    const link = await saveIntakeAnswers(deps.pool, parsed.data.token, answers);
    // One failure response for "dead link" and "already submitted" alike: this
    // is an unauthenticated endpoint, and distinguishing them tells a guesser
    // which of their guesses was a real token.
    if (!link) throw problems.unauthorized('This intake link can no longer be edited');

    return { answers: link.answers, completion: computeCompletion(link.answers ?? {}) };
  });

  /** Submit. Refused until every required field is answered. */
  app.post('/api/v1/intake/portal/submit', async (req) => {
    rateLimit(req.ip);
    const parsed = TokenBody.safeParse(req.body);
    if (!parsed.success) throw problems.unprocessable('Invalid request', { errors: parsed.error.issues });

    // Read first so an incomplete form gets a useful 422 rather than being
    // rejected as though its link were dead.
    const current = await redeemIntakeToken(deps.pool, parsed.data.token);
    if (!current) throw problems.unauthorized('This intake link is invalid, expired, or withdrawn');

    const completion = computeCompletion(current.answers ?? {});
    if (!completion.ready) {
      throw problems.unprocessable('Complete all required fields before submitting', { completion });
    }

    const link = await submitIntakeLink(deps.pool, parsed.data.token);
    if (!link) throw problems.unauthorized('This intake link can no longer be edited');

    return { submitted_at: link.submitted_at, completion };
  });
}
