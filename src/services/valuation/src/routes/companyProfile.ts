import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { isIsoCalendarDate, isUlid, problems } from '@n409/shared';
import { canReadValuation, isOps, type Principal } from '../auth/rbac.js';
import { findValuationById } from '../repos/valuations.js';
import { findCompanyProfile, upsertCompanyProfile } from '../repos/companyProfiles.js';
import { isNaicsCode, isSicCode } from '../domain/companyProfile.js';
import { requirePrincipal } from '../plugins/auth.js';
import type { EventActor } from '../events/record.js';

/**
 * Company profile editor (remaining-gaps §3 #6, 409.ai "modal_ui_data"):
 * structured company details per valuation. Readable by anyone who can read
 * the valuation; editable by ops and by the requesting client (it's their
 * company).
 */

const Str = (max: number) => z.string().max(max).nullable();
const DateStr = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD')
  .refine(isIsoCalendarDate, 'Not a real calendar date')
  .nullable();

export const REVENUE_RANGES = [
  'pre_revenue',
  'under_1m',
  '1m_10m',
  '10m_50m',
  '50m_100m',
  'over_100m',
] as const;

const PatchBody = z
  .object({
    legal_name: Str(300),
    website: Str(300),
    address_line1: Str(300),
    address_line2: Str(300),
    city: Str(120),
    region: Str(120),
    postal_code: Str(30),
    country: Str(120),
    industry: Str(200),
    // Migration 0151. The same validators the agent's apply path uses — a
    // malformed SIC ranks against no universe row in the comparable screen, so
    // it has to be refused wherever it can be typed.
    business_description: z.string().max(20_000).nullable(),
    sic_code: Str(12).refine((v) => v === null || isSicCode(v), 'A SIC code is 2-4 digits'),
    naics_code: Str(12).refine((v) => v === null || isNaicsCode(v), 'A NAICS code is 2-6 digits'),
    founded_on: DateStr,
    employee_count: z.number().int().min(0).max(10_000_000).nullable(),
    revenue_range: z.enum(REVENUE_RANGES).nullable(),
    cap_table_summary: z.string().max(20_000).nullable(),
  })
  .partial()
  .strict();

function actorFor(principal: Principal): EventActor {
  return { actorType: 'human', actorId: principal.id, source: 'api' };
}

export function registerCompanyProfileRoutes(app: FastifyInstance, deps: { pool: pg.Pool }): void {
  const loadValuation = async (principal: Principal, id: string) => {
    if (!isUlid(id)) throw problems.notFound();
    const valuation = await findValuationById(deps.pool, id);
    if (
      !valuation ||
      !canReadValuation(principal, { userId: valuation.user_id, partnerId: valuation.partner_id })
    ) {
      throw problems.notFound();
    }
    return valuation;
  };

  app.get('/api/v1/valuations/:id/company-profile', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    const { id } = req.params as { id: string };
    const valuation = await loadValuation(principal, id);
    const profile = await findCompanyProfile(deps.pool, id);
    // A never-saved profile reads as an empty one so the editor can render.
    return { profile, company_name: valuation.company_name };
  });

  app.patch('/api/v1/valuations/:id/company-profile', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    const { id } = req.params as { id: string };
    const valuation = await loadValuation(principal, id);
    if (!isOps(principal) && valuation.user_id !== principal.id) {
      throw problems.forbidden('Only operations or the requesting client can edit the company profile');
    }

    const parsed = PatchBody.safeParse(req.body);
    if (!parsed.success) throw problems.unprocessable('Invalid profile', { errors: parsed.error.issues });
    if (Object.keys(parsed.data).length === 0) {
      throw problems.unprocessable('Provide at least one field to update');
    }

    const profile = await upsertCompanyProfile(deps.pool, id, parsed.data, actorFor(principal));
    return { profile };
  });
}
