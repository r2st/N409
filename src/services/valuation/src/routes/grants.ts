import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { isIsoCalendarDate, isUlid, problems } from '@n409/shared';
import { canReadValuation, isOps, type Principal } from '../auth/rbac.js';
import { findValuationById, type ValuationRow } from '../repos/valuations.js';
import { findResolutionByValuation } from '../repos/boardApprovals.js';
import { latestSucceededCalculation } from '../repos/calculations.js';
import { requirePrincipal } from '../plugins/auth.js';
import {
  cancelGrant,
  createGrant,
  findGrantById,
  listGrants,
  updateGrant,
  type GrantRow,
} from '../repos/grants.js';
import {
  defaultScenarioFmvs,
  exerciseScenarios,
  isIssuableTemplate,
  ISSUABLE_TEMPLATE_KEYS,
  templateByKey,
  toIsoDate,
  vestingStatus,
  vestingTimeline,
  VESTING_TEMPLATES,
  type VestingSchedule,
} from '../domain/vesting.js';

/**
 * Grant management (feature 6). Grants can only be issued once the board has
 * adopted the 409A FMV; the exercise price is snapshotted from that adopted
 * value. Each grant carries a vesting schedule so vested/unvested tracking and
 * the exercise-scenario calculator are computed from structured data.
 */

/**
 * A vesting template this service knows how to turn into a schedule.
 *
 * `z.string().max(60)` accepted anything, and the route then resolved it with
 * `templateByKey(...) ?? 48/12/1`. A typo — `three_year_quarterl` — was
 * therefore issued as a standard 4-year monthly grant with a 1-year cliff and
 * stored under the misspelled key, so the grant's own label and the schedule it
 * actually vests on disagreed for the life of the option. Silence is the wrong
 * answer for a write that mints a contract.
 */
const TemplateKey = z
  .string()
  .max(60)
  .refine(isIssuableTemplate, {
    message: `Unknown vesting template — expected one of ${ISSUABLE_TEMPLATE_KEYS.join(', ')}`,
  });

/**
 * A grant date is a contract date. `new Date('2026-02-31')` rolls silently
 * forward to 2026-03-03, which on a vesting start moves every tranche.
 */
const GrantDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD')
  .refine(isIsoCalendarDate, 'Not a real calendar date');

const CreateBody = z.object({
  grantee_name: z.string().min(1).max(200),
  grantee_email: z.string().email().max(320).nullable().optional(),
  grant_date: GrantDate,
  options_count: z.number().int().positive(),
  exercise_price: z.number().nonnegative().optional(),
  vesting_template: TemplateKey.default('standard_4yr_1yr_cliff'),
  vesting_start_date: GrantDate.optional(),
  vesting_months: z.number().int().min(0).max(240).optional(),
  cliff_months: z.number().int().min(0).max(120).optional(),
  frequency_months: z.number().int().min(1).max(12).optional(),
  notes: z.string().max(2000).nullable().optional(),
});

const PatchBody = z.object({
  grantee_name: z.string().min(1).max(200).optional(),
  grantee_email: z.string().email().max(320).nullable().optional(),
  grant_date: GrantDate.optional(),
  options_count: z.number().int().positive().optional(),
  vesting_template: TemplateKey.optional(),
  vesting_start_date: GrantDate.optional(),
  vesting_months: z.number().int().min(0).max(240).optional(),
  cliff_months: z.number().int().min(0).max(120).optional(),
  frequency_months: z.number().int().min(1).max(12).optional(),
  notes: z.string().max(2000).nullable().optional(),
});

function requireOps(principal: Principal): void {
  if (!isOps(principal)) throw problems.forbidden('Grant management is operations-only');
}

async function loadReadable(pool: pg.Pool, id: string, principal: Principal): Promise<ValuationRow> {
  if (!isUlid(id)) throw problems.notFound();
  const valuation = await findValuationById(pool, id);
  if (!valuation) throw problems.notFound();
  if (!canReadValuation(principal, { userId: valuation.user_id, partnerId: valuation.partner_id })) {
    throw problems.notFound();
  }
  return valuation;
}

function scheduleOf(grant: GrantRow): VestingSchedule {
  return {
    totalShares: grant.options_count,
    vestingStartDate: grant.vesting_start_date,
    vestingMonths: grant.vesting_months,
    cliffMonths: grant.cliff_months,
    frequencyMonths: grant.frequency_months,
  };
}

/** Grant + computed vesting status as of `asOf`, with date-only date fields. */
function grantView(grant: GrantRow, asOf: Date) {
  return {
    ...grant,
    grant_date: toIsoDate(grant.grant_date),
    vesting_start_date: toIsoDate(grant.vesting_start_date),
    vesting: vestingStatus(scheduleOf(grant), asOf),
  };
}

export function registerGrantRoutes(app: FastifyInstance, deps: { pool: pg.Pool }): void {
  // Vesting template catalogue for the create form.
  app.get('/api/v1/grant-templates', { preHandler: app.authenticate }, async () => ({
    templates: VESTING_TEMPLATES,
  }));

  // List grants (readable by anyone who can read the valuation).
  app.get('/api/v1/valuations/:id/grants', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    const { id } = req.params as { id: string };
    await loadReadable(deps.pool, id, principal);
    const asOf = new Date();
    const grants = await listGrants(deps.pool, id);
    return { grants: grants.map((g) => grantView(g, asOf)) };
  });

  // Issue a grant (ops). Requires an approved board resolution; the exercise
  // price defaults to the adopted 409A FMV.
  app.post('/api/v1/valuations/:id/grants', { preHandler: app.authenticate }, async (req, reply) => {
    const principal = requirePrincipal(req);
    requireOps(principal);
    const { id } = req.params as { id: string };
    const valuation = await loadReadable(deps.pool, id, principal);

    const parsed = CreateBody.safeParse(req.body);
    if (!parsed.success) throw problems.unprocessable('Invalid grant', { errors: parsed.error.issues });

    const resolution = await findResolutionByValuation(deps.pool, id);
    if (!resolution || resolution.status !== 'approved') {
      throw problems.conflict('Grants can only be issued after the board has approved the 409A valuation');
    }

    // Exercise price from the adopted FMV unless explicitly overridden.
    const adoptedFmv = Number(resolution.fmv_conclusion);
    const exercisePrice = parsed.data.exercise_price ?? adoptedFmv;

    const template = templateByKey(parsed.data.vesting_template);
    const vestingMonths = parsed.data.vesting_months ?? template?.vestingMonths ?? 48;
    const cliffMonths = parsed.data.cliff_months ?? template?.cliffMonths ?? 12;
    const frequencyMonths = parsed.data.frequency_months ?? template?.frequencyMonths ?? 1;
    if (cliffMonths > vestingMonths) {
      throw problems.unprocessable('Cliff cannot be longer than the vesting term');
    }
    const vestingStartDate = parsed.data.vesting_start_date ?? parsed.data.grant_date;

    const grant = await createGrant(
      deps.pool,
      {
        valuationId: id,
        granteeName: parsed.data.grantee_name,
        granteeEmail: parsed.data.grantee_email ?? null,
        grantDate: parsed.data.grant_date,
        optionsCount: parsed.data.options_count,
        exercisePrice,
        currency: valuation.currency,
        vestingTemplate: parsed.data.vesting_template,
        vestingStartDate,
        vestingMonths,
        cliffMonths,
        frequencyMonths,
        notes: parsed.data.notes ?? null,
        createdBy: principal.id,
      },
      { actorType: 'human', actorId: principal.id },
    );
    return reply.status(201).send({ grant: grantView(grant, new Date()) });
  });

  // Grant detail: vesting status + timeline + exercise scenarios.
  app.get('/api/v1/valuations/:id/grants/:grantId', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    const { id, grantId } = req.params as { id: string; grantId: string };
    await loadReadable(deps.pool, id, principal);
    const grant = await findGrantById(deps.pool, grantId);
    if (!grant || grant.valuation_id !== id) throw problems.notFound();

    // Custom what-if FMVs via ?fmvs=1,2,5 else default ladder from current FMV.
    const currentFmv = Number(grant.exercise_price);
    const latest = await latestSucceededCalculation(deps.pool, id);
    const baseFmv = latest?.fmv_per_share ? Number(latest.fmv_per_share) : currentFmv;
    const q = (req.query as { fmvs?: string }).fmvs;
    const fmvs = q
      ? q
          .split(',')
          .map((s) => Number(s.trim()))
          .filter((n) => Number.isFinite(n) && n >= 0)
      : defaultScenarioFmvs(baseFmv || currentFmv || 1);

    return {
      grant: grantView(grant, new Date()),
      timeline: vestingTimeline(scheduleOf(grant)),
      scenarios: exerciseScenarios(
        { totalShares: grant.options_count, exercisePrice: currentFmv, currentFmv: baseFmv || currentFmv },
        fmvs,
      ),
    };
  });

  // Edit a grant (ops).
  app.patch('/api/v1/valuations/:id/grants/:grantId', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    requireOps(principal);
    const { id, grantId } = req.params as { id: string; grantId: string };
    await loadReadable(deps.pool, id, principal);
    const grant = await findGrantById(deps.pool, grantId);
    if (!grant || grant.valuation_id !== id) throw problems.notFound();

    const parsed = PatchBody.safeParse(req.body);
    if (!parsed.success) throw problems.unprocessable('Invalid patch', { errors: parsed.error.issues });
    const patch = parsed.data as Record<string, unknown>;

    // Switching the template has to move the schedule with it. `updateGrant`
    // writes whichever mutable columns the patch names, so a patch of
    // `{vesting_template: 'three_year_quarterly'}` alone relabelled the grant
    // and left it vesting over 48 months, monthly — the same label/schedule
    // disagreement the create path had, arrived at from the other direction.
    // Explicit months still win, so an edit that names both is not overridden.
    const template = templateByKey(String(patch.vesting_template ?? ''));
    if (template) {
      if (patch.vesting_months === undefined) patch.vesting_months = template.vestingMonths;
      if (patch.cliff_months === undefined) patch.cliff_months = template.cliffMonths;
      if (patch.frequency_months === undefined) patch.frequency_months = template.frequencyMonths;
    }

    const vm = (patch.vesting_months as number | undefined) ?? grant.vesting_months;
    const cm = (patch.cliff_months as number | undefined) ?? grant.cliff_months;
    if (cm > vm) throw problems.unprocessable('Cliff cannot be longer than the vesting term');

    const updated = await updateGrant(deps.pool, grant, patch, {
      actorType: 'human',
      actorId: principal.id,
    });
    return { grant: grantView(updated, new Date()) };
  });

  // Cancel a grant (ops).
  app.delete('/api/v1/valuations/:id/grants/:grantId', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    requireOps(principal);
    const { id, grantId } = req.params as { id: string; grantId: string };
    await loadReadable(deps.pool, id, principal);
    const grant = await findGrantById(deps.pool, grantId);
    if (!grant || grant.valuation_id !== id) throw problems.notFound();
    const cancelled = await cancelGrant(deps.pool, grant, { actorType: 'human', actorId: principal.id });
    return { grant: grantView(cancelled, new Date()) };
  });
}
