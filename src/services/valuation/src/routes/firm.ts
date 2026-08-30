import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { problems } from '@n409/shared';
import { isOps, valuationScope } from '../auth/rbac.js';
import { countByReason, DUE_SOON_DAYS, rankAttention } from '../domain/firmDashboard.js';
import { firmAttentionCandidates, firmClients, firmSummary, firmTeam } from '../repos/firmDashboard.js';
import { findBrandingByPartnerId } from '../repos/branding.js';
import { publicPartnerName } from '../domain/branding.js';
import { requirePrincipal } from '../plugins/auth.js';
import { pageParam } from '../domain/pagination.js';
import { invalidQuery } from '../domain/validationProblem.js';

/**
 * Firm-level administration — one console for a valuation firm's whole book,
 * rather than a page per engagement.
 *
 * The scope is always a single firm. A partner principal gets their own,
 * resolved from the session; ops name one explicitly. Nobody gets "all firms"
 * here — a cross-firm roll-up is a different product surface with different
 * confidentiality, and quietly returning one from this route would be the
 * easiest possible way to leak one firm's client list into another's console.
 */

/**
 * How many live engagements the attention queue considers. Far above any real
 * firm's active book, and bounded so a pathological tenant cannot turn one
 * dashboard load into an unbounded read.
 */
const ATTENTION_SCAN_LIMIT = 1000;

export function registerFirmRoutes(app: FastifyInstance, deps: { pool: pg.Pool }): void {
  /**
   * Resolves which firm this request is about, and refuses if the caller has no
   * business seeing it. Ops may pass ?partner_id; everyone else gets exactly
   * their own tenant, whatever they pass.
   */
  const resolveFirm = (req: Parameters<typeof requirePrincipal>[0], requested?: string): string => {
    const principal = requirePrincipal(req);
    if (isOps(principal)) {
      const partnerId = requested ?? principal.partnerId;
      if (!partnerId) throw problems.badRequest('partner_id is required');
      return partnerId;
    }
    const scope = valuationScope(principal);
    if (scope.kind !== 'partner') throw problems.forbidden('This console is for firm accounts');
    if (requested && requested !== scope.partnerId)
      throw problems.forbidden('You can only view your own firm');
    return scope.partnerId;
  };

  const QueryWithPartner = z.object({ partner_id: z.string().optional() });

  app.get('/api/v1/firm/dashboard', { preHandler: app.authenticate }, async (req) => {
    const parsed = QueryWithPartner.safeParse(req.query);
    if (!parsed.success) throw invalidQuery(parsed.error);
    const partnerId = resolveFirm(req, parsed.data.partner_id);

    // `now` is taken once and passed down, so every reason on the page is
    // measured against the same instant.
    const now = new Date();
    const [summary, team, candidates, branding] = await Promise.all([
      firmSummary(deps.pool, partnerId, DUE_SOON_DAYS),
      firmTeam(deps.pool, partnerId),
      firmAttentionCandidates(deps.pool, partnerId, ATTENTION_SCAN_LIMIT),
      findBrandingByPartnerId(deps.pool, partnerId),
    ]);

    const allAttention = rankAttention(candidates.candidates, now);
    return {
      // `publicPartnerName`, not a fourth spelling of it. Written out here as
      // `brand_name?.trim() || name`, this dropped the `white_label_enabled`
      // gate the rule is built around, so a firm that had staged a brand name
      // and not turned white label on was greeted by it on their own console
      // while every client-facing surface still said the ops channel label.
      firm: { id: partnerId, name: (branding && publicPartnerName(branding)) || 'Your firm' },
      summary,
      team,
      // Counts cover the whole queue; the list is the top of it.
      attention: allAttention.slice(0, 25),
      attention_total: allAttention.length,
      attention_counts: countByReason(allAttention),
      // ...unless the firm has more live engagements than one scan reads, in
      // which case they cover the first ATTENTION_SCAN_LIMIT of it and this
      // says so. Without the flag `attention_total` reported the cap as if it
      // were the queue, which is the one number on this page a firm plans
      // against.
      attention_truncated: candidates.truncated,
      attention_scan_limit: ATTENTION_SCAN_LIMIT,
      generated_at: now.toISOString(),
    };
  });

  /** The client roster — one row per company, with paging and search. */
  app.get('/api/v1/firm/clients', { preHandler: app.authenticate }, async (req) => {
    const parsed = QueryWithPartner.extend({
      search: z.string().max(200).optional(),
      page: pageParam(),
      per_page: z.coerce.number().int().min(1).max(100).default(25),
    }).safeParse(req.query);
    if (!parsed.success) throw invalidQuery(parsed.error);
    const partnerId = resolveFirm(req, parsed.data.partner_id);

    const { page, per_page: perPage, search } = parsed.data;
    const { clients, total } = await firmClients(deps.pool, partnerId, {
      search,
      limit: perPage,
      offset: (page - 1) * perPage,
    });
    return { clients, total, page, per_page: perPage };
  });

  /** The full attention queue, for when 25 is not all of it. */
  app.get('/api/v1/firm/attention', { preHandler: app.authenticate }, async (req) => {
    const parsed = QueryWithPartner.safeParse(req.query);
    if (!parsed.success) throw invalidQuery(parsed.error);
    const partnerId = resolveFirm(req, parsed.data.partner_id);

    const { candidates, truncated } = await firmAttentionCandidates(
      deps.pool,
      partnerId,
      ATTENTION_SCAN_LIMIT,
    );
    const attention = rankAttention(candidates, new Date());
    // `total` is the length of what was ranked, so it is the whole queue only
    // when the scan was not truncated. The flag and the limit travel with it
    // rather than being left for the caller to infer from `total === 1000`,
    // which is the same envelope every other capped list here serves.
    return {
      attention,
      total: attention.length,
      counts: countByReason(attention),
      truncated,
      scan_limit: ATTENTION_SCAN_LIMIT,
    };
  });
}
