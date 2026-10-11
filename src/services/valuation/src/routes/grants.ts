import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { isIsoCalendarDate, isUlid, problems } from '@n409/shared';
import { canReadValuation, isOps, type Principal } from '../auth/rbac.js';
import { findValuationById, type ValuationRow } from '../repos/valuations.js';
import { findResolutionByValuation } from '../repos/boardApprovals.js';
import { latestSucceededCalculation } from '../repos/calculations.js';
import { concludes409AFmvPerShare, specialtyRunKind } from '../domain/specialty.js';
import { requirePrincipal } from '../plugins/auth.js';
import {
  cancelGrant,
  createGrant,
  findGrantById,
  GRANT_CANCELLED_DETAIL,
  GRANTS_NEED_APPROVAL,
  GRANT_PAGE_LIMIT,
  listGrants,
  updateGrant,
  type GrantRow,
} from '../repos/grants.js';
import {
  CLIFF_MONTHS_MAX,
  defaultScenarioFmvs,
  exerciseScenarios,
  FREQUENCY_MONTHS_MAX,
  isIssuableTemplate,
  ISSUABLE_TEMPLATE_KEYS,
  MAX_GRANTEE_NAME,
  MAX_SCENARIO_FMVS,
  templateByKey,
  toIsoDate,
  vestingStatus,
  vestingTimeline,
  VESTING_MONTHS_MAX,
  VESTING_TEMPLATES,
  type VestingSchedule,
} from '../domain/vesting.js';
import { int4Positive } from '../domain/int4.js';
import { nonBlankText } from '../domain/nonBlankText.js';
import { refuseIfRetired } from '../domain/retiredEngagement.js';
import { invalidBody, invalidQuery } from '../domain/validationProblem.js';

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

const CreateBody = z
  .object({
    grantee_name: nonBlankText(1, MAX_GRANTEE_NAME),
    grantee_email: z.string().email().max(320).nullable().optional(),
    grant_date: GrantDate,
    options_count: int4Positive(),
    exercise_price: z.number().nonnegative().max(1e9).optional(),
    vesting_template: TemplateKey.default('standard_4yr_1yr_cliff'),
    vesting_start_date: GrantDate.optional(),
    vesting_months: z.number().int().min(0).max(VESTING_MONTHS_MAX).optional(),
    cliff_months: z.number().int().min(0).max(CLIFF_MONTHS_MAX).optional(),
    frequency_months: z.number().int().min(1).max(FREQUENCY_MONTHS_MAX).optional(),
    notes: z.string().max(2000).nullable().optional(),
  })
  .strict();

const PatchBody = z
  .object({
    grantee_name: nonBlankText(1, MAX_GRANTEE_NAME).optional(),
    grantee_email: z.string().email().max(320).nullable().optional(),
    grant_date: GrantDate.optional(),
    options_count: int4Positive().optional(),
    vesting_template: TemplateKey.optional(),
    vesting_start_date: GrantDate.optional(),
    vesting_months: z.number().int().min(0).max(VESTING_MONTHS_MAX).optional(),
    cliff_months: z.number().int().min(0).max(CLIFF_MONTHS_MAX).optional(),
    frequency_months: z.number().int().min(1).max(FREQUENCY_MONTHS_MAX).optional(),
    notes: z.string().max(2000).nullable().optional(),
  })
  .strict();

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
    const parsedQuery = z
      .object({ limit: z.coerce.number().int().min(1).max(GRANT_PAGE_LIMIT).default(GRANT_PAGE_LIMIT) })
      .safeParse(req.query ?? {});
    if (!parsedQuery.success) {
      throw invalidQuery(parsedQuery.error);
    }
    const asOf = new Date();
    const { grants, truncated } = await listGrants(deps.pool, id, { limit: parsedQuery.data.limit });
    return { grants: grants.map((g) => grantView(g, asOf)), truncated, page_limit: GRANT_PAGE_LIMIT };
  });

  // Issue a grant (ops). Requires an approved board resolution; the exercise
  // price defaults to the adopted 409A FMV.
  app.post('/api/v1/valuations/:id/grants', { preHandler: app.authenticate }, async (req, reply) => {
    const principal = requirePrincipal(req);
    requireOps(principal);
    const { id } = req.params as { id: string };
    const valuation = await loadReadable(deps.pool, id, principal);
    refuseIfRetired(valuation, 'accepting changes');

    const parsed = CreateBody.safeParse(req.body);
    if (!parsed.success) throw invalidBody('Invalid grant', parsed.error);

    const resolution = await findResolutionByValuation(deps.pool, id);
    if (!resolution || resolution.status !== 'approved') {
      throw problems.conflict(GRANTS_NEED_APPROVAL);
    }

    // Exercise price from the adopted FMV unless explicitly overridden.
    const raw = Number(resolution.fmv_conclusion);
    if (!Number.isFinite(raw)) {
      throw problems.unprocessable('Adopted FMV is not a finite number — cannot price grants');
    }
    const adoptedFmv = raw;
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
        // Re-asked under the resolution's row lock: the check above and the
        // price below are a read the three reopening doors can overtake.
        requireApproval: { approvedAt: resolution.approved_at },
      },
      { actorType: 'human', actorId: principal.id },
    );
    return reply.status(201).send({ grant: grantView(grant, new Date()) });
  });

  /**
   * The what-if ladder, read through a schema rather than a cast.
   *
   * This was `(req.query as { fmvs?: string }).fmvs`, and a cast is a
   * compile-time assertion with no runtime force behind it. A query string is not
   * a `Record<string, string>`: Fastify's parser collects a repeated key into an
   * array, so `?fmvs=1&fmvs=2` — which any client can send, and which a proxy or
   * a link builder can produce by accident — arrives as `['1', '2']`. The very
   * next line called `q.split(',')`, and an array has no `split`, so the caller
   * got a 500 saying the server broke rather than a 400 saying the query did.
   *
   * The bound is on the raw string as well as on the term count below, because a
   * megabyte of commas is under the term limit and still a megabyte to split. 400
   * characters is twenty prices of nineteen digits each, which is more than the
   * twenty terms `MAX_SCENARIO_FMVS` allows.
   */
  const ScenarioQuery = z.object({ fmvs: z.string().max(400).optional() });

  // Grant detail: vesting status + timeline + exercise scenarios.
  app.get('/api/v1/valuations/:id/grants/:grantId', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    const { id, grantId } = req.params as { id: string; grantId: string };
    await loadReadable(deps.pool, id, principal);
    const [grant, latest] = await Promise.all([
      findGrantById(deps.pool, grantId),
      latestSucceededCalculation(deps.pool, id),
    ]);
    if (!grant || grant.valuation_id !== id) throw problems.notFound();

    // Custom what-if FMVs via ?fmvs=1,2,5 else default ladder from current FMV.
    const currentFmv = Number(grant.exercise_price);
    /*
     * The ladder and the "×current" column are both struck off *the current
     * 409A FMV* — `defaultScenarioFmvs` says so in its own doc comment, and
     * `multipleOfCurrent` divides by it.
     *
     * `calculations.fmv_per_share` is a 409A column by name that every
     * specialty engine writes into (domain/specialty.ts). On an EMI or CSOP run
     * what lands there is the AMV — the *restricted* value, below the
     * unrestricted market value by the whole restriction discount — and on an
     * ESOP run it is ERISA adequate consideration over shares outstanding, off
     * a supplied equity value. Dividing by a figure that is below fair market
     * value overstates every multiple on the panel, and anchoring the default
     * 1×/2×/5×/10× ladder on it scales the whole table off the restricted
     * number. R142 stopped a board adopting this same column as a §409A price;
     * this is the same column being read as one, one screen over.
     *
     * The fallback is the grant's own exercise price — already what this line
     * did when no calculation existed, and on a specialty engagement it is a
     * figure a human named explicitly, since `POST /valuations/:id/board`
     * refuses to derive one there.
     */
    const runKind = specialtyRunKind(latest?.results ?? null);
    const adoptable = runKind === null || concludes409AFmvPerShare(runKind);
    const baseFmv = adoptable && latest?.fmv_per_share ? Number(latest.fmv_per_share) : currentFmv;
    const query = ScenarioQuery.safeParse(req.query);
    if (!query.success) throw invalidQuery(query.error);
    const q = query.data.fmvs;
    // Bounded like `sort` is (MAX_SORT_TERMS, repos/valuations): the ladder is a
    // handful of what-if prices for one panel — the default is four — and every
    // term costs a scenario object in the response. Rejected rather than
    // truncated, so a client asking for more never quietly gets fewer.
    if (q !== undefined && q.split(',').length > MAX_SCENARIO_FMVS) {
      throw problems.badRequest(`At most ${MAX_SCENARIO_FMVS} what-if FMVs may be requested`);
    }
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
    refuseIfRetired(await loadReadable(deps.pool, id, principal), 'accepting changes');
    const grant = await findGrantById(deps.pool, grantId);
    if (!grant || grant.valuation_id !== id) throw problems.notFound();
    /*
     * A cancelled grant is finished (round 296, methodology M3).
     *
     * `cancelGrant` is a once-only move onto a terminal status, and it is
     * written that way because a grant is a security: the row is the record of
     * what was issued and then withdrawn. This door asked nothing about the
     * status, so every mutable column — the grantee, the count, the grant date,
     * the whole vesting schedule — was still editable afterwards, and the edit
     * landed on the audit spine as an ordinary `grant_updated` against a
     * security that no longer exists. The auditor workbook prints cancelled
     * rows, so the change is visible there too.
     *
     * A refusal rather than a silent no-op: the caller asked for a state change
     * it did not get, and the answer names the reason so re-issuing (a new
     * grant) reads as the way forward rather than a workaround.
     */
    // R312 re-asks this inside `updateGrant`'s WHERE, with the same sentence:
    // this read is on the pool and the cancel button is on the same screen.
    if (grant.status === 'cancelled') {
      throw problems.conflict(GRANT_CANCELLED_DETAIL);
    }

    const parsed = PatchBody.safeParse(req.body);
    if (!parsed.success) throw invalidBody('Invalid patch', parsed.error);
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
    refuseIfRetired(await loadReadable(deps.pool, id, principal), 'accepting changes');
    const grant = await findGrantById(deps.pool, grantId);
    if (!grant || grant.valuation_id !== id) throw problems.notFound();
    const cancelled = await cancelGrant(deps.pool, grant, { actorType: 'human', actorId: principal.id });
    return { grant: grantView(cancelled, new Date()) };
  });
}
