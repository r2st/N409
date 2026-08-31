import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { isIsoCalendarDate, isUlid, problems } from '@n409/shared';
import { isOps, type Principal } from '../auth/rbac.js';
import { postJson, toProblem, InternalServiceError } from '../clients/internal.js';
import { requirePrincipal } from '../plugins/auth.js';
import { kindLabel } from '../domain/valuationSelector.js';
import { todayLocal } from '../domain/calendarDate.js';
import { CurrencyCode } from '../domain/currency.js';
import { FUND_MARK_FAIR_VALUE, requireStorableFigure } from '../domain/numericColumn.js';
import {
  createFund,
  createMark,
  createPosition,
  deleteFund,
  deletePosition,
  findFund,
  findLpTerms,
  findPosition,
  countMarks,
  latestMarks,
  linkFundToValuation,
  FUND_PAGE_LIMIT,
  listFunds,
  listMarks,
  listPositions,
  updateFund,
  updatePosition,
  upsertLpTerms,
  type MarkMethod,
} from '../repos/funds.js';
import { MeasurementLinkConflict } from '../domain/measurementLink.js';
import { findValuationById } from '../repos/valuations.js';
import { invalidBody, invalidQuery } from '../domain/validationProblem.js';
import { refuseIfMeasurementRetired, refuseIfRetired } from '../domain/retiredEngagement.js';
import { recordEvent } from '../events/record.js';
import { withTransaction } from '../db/pool.js';
import type { ValuationEventType } from '../domain/auditTrail.js';

/**
 * ASC 820 fund-holdings valuation (feature: ASC 820 Fund Holdings).
 *
 * A fund (VC / PE / credit) marks a portfolio of equity positions to fair
 * value, classifies each in the ASC 820 hierarchy, rolls them up into NAV, and
 * distributes proceeds through an LP waterfall. The valuation service owns the
 * CRUD + mark history; the Python engine (fund_valuation.py) does the maths.
 * Ops-only, like the rest of the measurement surface.
 */

const DateStr = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD')
  .refine(isIsoCalendarDate, 'Not a real calendar date');

const FundBody = z.object({
  name: z.string().trim().min(1).max(200),
  fund_type: z.enum(['vc', 'pe', 'credit', 'growth', 'other']).default('vc'),
  currency: CurrencyCode.default('USD'),
  vintage_year: z.number().int().min(1970).max(2100).nullish(),
});

const PositionBody = z.object({
  company_name: z.string().trim().min(1).max(200),
  security_type: z.enum(['common', 'preferred', 'safe', 'note', 'warrant', 'other']).default('preferred'),
  quantity: z.number().min(0).max(1e15).default(0),
  cost_basis: z.number().min(0).max(1e15).default(0),
  mark_method: z.enum(['market', 'last_round', 'calibrated_opm', 'cost']).default('cost'),
});

/**
 * Every field optional, and `.strict()` so a typo'd key is a 422 rather than a
 * silent no-op: a PATCH that quietly changes nothing looks exactly like one
 * that worked. `.strict()` also rejects `valuation_id` here, which is the
 * engagement link's own route and not a property of the fund's identity.
 */
const FundPatchBody = z
  .object({
    name: z.string().trim().min(1).max(200),
    fund_type: z.enum(['vc', 'pe', 'credit', 'growth', 'other']),
    currency: CurrencyCode,
    vintage_year: z.number().int().min(1970).max(2100).nullable(),
  })
  .partial()
  .strict();

/** Same rule as {@link FundPatchBody}, over the holding's own fields. */
const PositionPatchBody = z
  .object({
    company_name: z.string().trim().min(1).max(200),
    security_type: z.enum(['common', 'preferred', 'safe', 'note', 'warrant', 'other']),
    quantity: z.number().min(0).max(1e15),
    cost_basis: z.number().min(0).max(1e15),
    mark_method: z.enum(['market', 'last_round', 'calibrated_opm', 'cost']),
  })
  .partial()
  .strict();

const MarkBody = z.object({
  measurement_date: DateStr,
  method: z.enum(['market', 'last_round', 'calibrated_opm', 'cost']),
  quantity: z.number().min(0).max(1e15).optional(),
  quoted_price: z.number().min(0).max(1e12).optional(),
  round_price_per_share: z.number().min(0).max(1e12).optional(),
  model_value: z.number().min(0).max(1e15).optional(),
});

const LpTermsBody = z.object({
  committed_capital: z.number().min(0).max(1e15).default(0),
  contributed_capital: z.number().min(0).max(1e15).default(0),
  preferred_return_rate: z.number().min(0).max(1).default(0.08),
  carry_pct: z.number().min(0).max(0.99).default(0.2),
  gp_catch_up: z.boolean().default(true),
  management_fee_pct: z.number().min(0).max(1).default(0.02),
  management_fees_paid: z.number().min(0).max(1e15).default(0),
  gp_distributions_to_date: z.number().min(0).max(1e15).default(0),
});

/** `null` detaches — the measurement tools are usable without an engagement. */
const LinkBody = z.object({ valuation_id: z.string().trim().min(1).max(26).nullable() });

const WaterfallBody = z.object({
  distributable: z.number().min(0).max(1e15),
  years: z.number().min(0).max(50).default(1),
});

const CalibrateBody = z.object({
  round_price_per_share: z.number().positive().max(1e12),
  total_equity_value: z.number().positive().max(1e15),
  strike: z.number().min(0).max(1e15),
  time_to_exit_years: z.number().positive().max(30),
  risk_free_rate: z.number().min(0).max(0.25),
  preferred_shares: z.number().positive().max(1e15),
  fully_diluted_shares: z.number().positive().max(1e15),
});

const RollForwardBody = z.object({
  method: z.enum(['index', 'accretion', 'calibration']).default('index'),
  index_return: z.number().min(-1).max(50).optional(),
  accretion_rate: z.number().min(-1).max(50).optional(),
  periods: z.number().min(0).max(100).default(1),
  new_calibrated_value: z.number().min(0).max(1e15).optional(),
  measurement_date: DateStr.optional(),
  record: z.boolean().default(false),
});

interface EngineMarkedPosition {
  name: string;
  method: string;
  level: number;
  quantity: number;
  cost_basis: number;
  fair_value: number;
  unrealized_gain: number;
}
interface EngineNav {
  positions: EngineMarkedPosition[];
  gross_asset_value: number;
  total_cost_basis: number;
  total_unrealized_gain: number;
  liabilities: number;
  net_asset_value: number;
  level_breakdown: { level_1: number; level_2: number; level_3: number };
}

function requireOps(principal: Principal): void {
  if (!isOps(principal)) throw problems.forbidden('Fund valuation is operations-only');
}

const n = (v: string | number): number => Number(v);

/** Build an engine position payload from a stored position + its inputs. */
function enginePosition(
  companyName: string,
  costBasis: number,
  method: MarkMethod,
  inputs: Record<string, unknown>,
): Record<string, unknown> {
  return { name: companyName, method, cost_basis: costBasis, ...inputs };
}

export function registerFundRoutes(app: FastifyInstance, deps: { pool: pg.Pool; engineUrl: string }): void {
  const engine = async <T>(path: string, body: unknown): Promise<T> => {
    try {
      return await postJson<T>('engine', `${deps.engineUrl}${path}`, body, { timeoutMs: 30_000 });
    } catch (err) {
      if (err instanceof InternalServiceError) throw toProblem(err);
      throw err;
    }
  };

  const loadFund = async (id: string) => {
    if (!isUlid(id)) throw problems.notFound();
    const fund = await findFund(deps.pool, id);
    if (!fund) throw problems.notFound();
    return fund;
  };

  /**
   * Put a measurement change on the engagement's audit spine.
   *
   * Only when the portfolio is linked: an unlinked one is an ops sketch with no
   * engagement to write to, and `valuation_events.valuation_id` is NOT NULL.
   * Every one of these moves the NAV `domain/navExhibits.ts` prints — it sums
   * the *stored* marks at render time — so the deliverable's figure could
   * change with nothing on the trail saying who changed it. The route surface
   * is keyed by fund id, which is why the spine never saw any of it.
   *
   * IN THE TRANSACTION THAT WRITES, which is the spine's one standing rule —
   * `events/record.ts`: "Events are written in the SAME transaction as the
   * change they describe, so a change without its event (or vice versa) is
   * impossible." R279 wrote these from the route rather than from a repo, and
   * took its own transaction *after* the mutation had already committed in
   * another one. That is the invariant read backwards: a statement timeout on
   * the INSERT (the pool sets one) left the holding added, the mark recorded or
   * the terms rewritten with nothing on the trail, and answered the caller 500
   * for work that had landed — so a retry adds it twice. Every other one of the
   * thirty-odd `recordEvent` callers in this service is inside the repo
   * transaction that does the write; these two files were the exception.
   */
  const recordFundEvent = (
    client: pg.PoolClient,
    fund: { valuation_id: string | null },
    type: ValuationEventType,
    principal: Principal,
    payload: Record<string, unknown>,
  ): Promise<unknown> => {
    if (fund.valuation_id === null) return Promise.resolve();
    return recordEvent(client, {
      valuationId: fund.valuation_id,
      type,
      actor: { actorType: 'human', actorId: principal.id, source: 'api' },
      payload,
    });
  };

  /**
   * `loadFund` for the routes that then write something.
   *
   * The portfolio is addressed by its own id, so nothing about the request
   * mentions the engagement it is measured for — which is why the retirement
   * sweep, which drives every mutating route under a valuation id, has never
   * been able to see this file. See `refuseIfMeasurementRetired`.
   */
  const loadFundForWrite = async (id: string, doing: string) => {
    const fund = await loadFund(id);
    await refuseIfMeasurementRetired(deps.pool, fund, doing);
    return fund;
  };

  // ── Funds ────────────────────────────────────────────────────────────────
  app.post('/api/v1/funds', { preHandler: app.authenticate }, async (req, reply) => {
    const principal = requirePrincipal(req);
    requireOps(principal);
    const parsed = FundBody.safeParse(req.body);
    if (!parsed.success) throw invalidBody('Invalid fund', parsed.error);
    const b = parsed.data;
    const fund = await createFund(deps.pool, {
      name: b.name,
      fundType: b.fund_type,
      currency: b.currency.toUpperCase(),
      vintageYear: b.vintage_year ?? null,
      createdBy: principal.id,
    });
    return reply.status(201).send({ fund });
  });

  app.get('/api/v1/funds', { preHandler: app.authenticate }, async (req) => {
    requireOps(requirePrincipal(req));
    const parsed = z
      .object({ limit: z.coerce.number().int().min(1).max(FUND_PAGE_LIMIT).default(FUND_PAGE_LIMIT) })
      .safeParse(req.query ?? {});
    if (!parsed.success) throw invalidQuery(parsed.error);
    return listFunds(deps.pool, { limit: parsed.data.limit });
  });

  app.get('/api/v1/funds/:id', { preHandler: app.authenticate }, async (req) => {
    requireOps(requirePrincipal(req));
    const { id } = req.params as { id: string };
    const fund = await loadFund(id);
    const { positions, truncated } = await listPositions(deps.pool, id);
    const marks = await latestMarks(
      deps.pool,
      positions.map((p) => p.id),
    );
    const lpTerms = await findLpTerms(deps.pool, id);
    return {
      fund,
      lp_terms: lpTerms,
      positions: positions.map((p) => ({ ...p, latest_mark: marks.get(p.id) ?? null })),
      truncated,
    };
  });

  app.patch('/api/v1/funds/:id', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    requireOps(principal);
    const { id } = req.params as { id: string };
    const existing = await loadFundForWrite(id, 'accepting changes');
    const parsed = FundPatchBody.safeParse(req.body);
    if (!parsed.success) throw invalidBody('Invalid fund', parsed.error);
    const b = parsed.data;
    const fund = await withTransaction(deps.pool, async (client) => {
      const updated = await updateFund(client, id, {
        name: b.name,
        fundType: b.fund_type,
        currency: b.currency?.toUpperCase(),
        vintageYear: b.vintage_year,
      });
      if (!updated) throw problems.notFound();
      // The one write on this surface R279 guarded and did not record. Its
      // twin on the debt side (`PUT /debt/instruments/:id`) writes
      // `debt_instrument_updated`, so the asymmetry was the tell: a fund
      // engagement's activity feed showed every holding and every mark and
      // stayed silent about the portfolio being renamed, reclassified, or
      // redenominated — the last of which changes what every figure under it
      // means, and what the NAV exhibit prints beside them.
      await recordFundEvent(client, existing, 'fund_updated', principal, {
        fund_id: id,
        changes: b,
      });
      return updated;
    });
    return { fund };
  });

  /**
   * Delete a portfolio, its holdings and their whole mark trail.
   *
   * Refused while the portfolio is linked to an engagement. The marks under a
   * linked fund are the NAV a report we have issued speaks for, and 0110 chose
   * `ON DELETE SET NULL` on that link in the other direction for the same
   * reason — retiring the engagement must not take the measurements with it.
   * Unlink first if the intent really is to discard the work; that is a
   * deliberate second act rather than a cascade nobody asked for.
   */
  app.delete('/api/v1/funds/:id', { preHandler: app.authenticate }, async (req, reply) => {
    requireOps(requirePrincipal(req));
    const { id } = req.params as { id: string };
    const fund = await loadFund(id);
    if (fund.valuation_id !== null) {
      throw problems.conflict(
        'This portfolio is linked to an engagement — detach it from the engagement before deleting',
      );
    }
    if (!(await deleteFund(deps.pool, id))) throw problems.notFound();
    return reply.status(204).send();
  });

  // ── Positions ────────────────────────────────────────────────────────────
  app.post('/api/v1/funds/:id/positions', { preHandler: app.authenticate }, async (req, reply) => {
    const principal = requirePrincipal(req);
    requireOps(principal);
    const { id } = req.params as { id: string };
    const fund = await loadFundForWrite(id, 'accepting new holdings');
    const parsed = PositionBody.safeParse(req.body);
    if (!parsed.success) throw invalidBody('Invalid position', parsed.error);
    const b = parsed.data;
    const position = await withTransaction(deps.pool, async (client) => {
      const created = await createPosition(client, {
        fundId: id,
        companyName: b.company_name,
        securityType: b.security_type,
        quantity: b.quantity,
        costBasis: b.cost_basis,
        markMethod: b.mark_method,
      });
      await recordFundEvent(client, fund, 'fund_position_added', principal, {
        fund_id: id,
        position_id: created.id,
        company_name: created.company_name,
        quantity: created.quantity,
        cost_basis: created.cost_basis,
      });
      return created;
    });
    return reply.status(201).send({ position });
  });

  app.patch('/api/v1/funds/:id/positions/:pid', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    requireOps(principal);
    const { id, pid } = req.params as { id: string; pid: string };
    const fund = await loadFundForWrite(id, 'accepting changes to its holdings');
    if (!isUlid(pid) || !(await findPosition(deps.pool, id, pid))) throw problems.notFound();
    const parsed = PositionPatchBody.safeParse(req.body);
    if (!parsed.success) throw invalidBody('Invalid position', parsed.error);
    const b = parsed.data;
    const position = await withTransaction(deps.pool, async (client) => {
      const updated = await updatePosition(client, id, pid, {
        companyName: b.company_name,
        securityType: b.security_type,
        quantity: b.quantity,
        costBasis: b.cost_basis,
        markMethod: b.mark_method,
      });
      if (!updated) throw problems.notFound();
      await recordFundEvent(client, fund, 'fund_position_updated', principal, {
        fund_id: id,
        position_id: pid,
        changes: b,
      });
      return updated;
    });
    return { position };
  });

  /**
   * Remove a holding and its marks.
   *
   * Not refused for a linked fund, unlike deleting the portfolio itself: a
   * position entered against the wrong fund is the ordinary correction this
   * exists for, and refusing it would leave the NAV of a linked engagement
   * permanently wrong with no way to fix it. The engagement link is the fund's,
   * and the fund survives.
   */
  app.delete('/api/v1/funds/:id/positions/:pid', { preHandler: app.authenticate }, async (req, reply) => {
    const principal = requirePrincipal(req);
    requireOps(principal);
    const { id, pid } = req.params as { id: string; pid: string };
    const fund = await loadFund(id);
    if (!isUlid(pid)) throw problems.notFound();
    await withTransaction(deps.pool, async (client) => {
      // Read before the delete, and inside the transaction that does it: the
      // row is what the event has to name, and after the cascade there is
      // nothing left to name it with.
      const position = await findPosition(client, id, pid);
      if (!position) throw problems.notFound();
      // The mark trail goes too — `fund_marks` cascades from the position
      // (0086) — and the mark is the figure that actually leaves the NAV:
      // `domain/navExhibits.ts` sums the *stored* marks, not the cost bases.
      // An event naming only the cost basis of a holding whose latest mark was
      // a different number leaves an auditor asking why the schedule moved by
      // an amount nothing on the trail mentions, with the row it would have
      // read gone.
      const latest = (await latestMarks(client, [pid])).get(pid) ?? null;
      const marksRemoved = await countMarks(client, pid);
      if (!(await deletePosition(client, id, pid))) throw problems.notFound();
      await recordFundEvent(client, fund, 'fund_position_removed', principal, {
        fund_id: id,
        position_id: pid,
        company_name: position.company_name,
        cost_basis: position.cost_basis,
        latest_fair_value: latest?.fair_value ?? null,
        latest_measurement_date: latest?.measurement_date ?? null,
        marks_removed: marksRemoved,
      });
    });
    return reply.status(204).send();
  });

  // ── Marks ────────────────────────────────────────────────────────────────
  app.get('/api/v1/funds/:id/positions/:pid/marks', { preHandler: app.authenticate }, async (req) => {
    requireOps(requirePrincipal(req));
    const { id, pid } = req.params as { id: string; pid: string };
    await loadFund(id);
    const position = await findPosition(deps.pool, id, pid);
    if (!position) throw problems.notFound();
    return listMarks(deps.pool, pid);
  });

  app.post('/api/v1/funds/:id/positions/:pid/marks', { preHandler: app.authenticate }, async (req, reply) => {
    const principal = requirePrincipal(req);
    requireOps(principal);
    const { id, pid } = req.params as { id: string; pid: string };
    const fund = await loadFundForWrite(id, 'accepting new marks');
    const position = await findPosition(deps.pool, id, pid);
    if (!position) throw problems.notFound();
    const parsed = MarkBody.safeParse(req.body);
    if (!parsed.success) throw invalidBody('Invalid mark', parsed.error);
    const b = parsed.data;

    // Assemble the method-specific engine inputs; default to the position's
    // stored quantity/cost when the mark omits them.
    const inputs: Record<string, unknown> = {};
    if (b.method === 'market') {
      inputs.quantity = b.quantity ?? n(position.quantity);
      inputs.quoted_price = b.quoted_price ?? 0;
    } else if (b.method === 'last_round') {
      inputs.quantity = b.quantity ?? n(position.quantity);
      inputs.round_price_per_share = b.round_price_per_share ?? 0;
    } else if (b.method === 'calibrated_opm') {
      inputs.model_value = b.model_value ?? 0;
    }

    // Fair-value the single position through the engine so the level + value
    // are computed by the same code path NAV uses.
    const nav = await engine<EngineNav>('/engine/v1/fund-valuation', {
      positions: [enginePosition(position.company_name, n(position.cost_basis), b.method, inputs)],
      liabilities: 0,
    });
    const marked = nav.positions[0]!;
    const mark = await withTransaction(deps.pool, async (client) => {
      const recorded = await createMark(client, {
        positionId: pid,
        measurementDate: b.measurement_date,
        method: b.method,
        fairValue: requireStorableFigure(marked.fair_value, 'Fair value', FUND_MARK_FAIR_VALUE)!,
        level: marked.level,
        inputs,
        createdBy: principal.id,
      });
      await recordFundEvent(client, fund, 'fund_mark_recorded', principal, {
        fund_id: id,
        position_id: pid,
        // The row the event is about. Every other writer on the spine names
        // the row it wrote — `grant_id`, `report_id` — and a mark is the one
        // whose figure the NAV schedule is a sum of, so an auditor asking
        // which mark moved the exhibit has to be able to reach it from here.
        mark_id: recorded.id,
        company_name: position.company_name,
        measurement_date: recorded.measurement_date,
        method: recorded.method,
        level: recorded.level,
        fair_value: recorded.fair_value,
      });
      return recorded;
    });
    return reply.status(201).send({ mark });
  });

  app.post(
    '/api/v1/funds/:id/positions/:pid/rollforward',
    { preHandler: app.authenticate },
    async (req, reply) => {
      const principal = requirePrincipal(req);
      requireOps(principal);
      const { id, pid } = req.params as { id: string; pid: string };
      const fund = await loadFund(id);
      const position = await findPosition(deps.pool, id, pid);
      if (!position) throw problems.notFound();
      const parsed = RollForwardBody.safeParse(req.body);
      if (!parsed.success) throw invalidBody('Invalid roll-forward', parsed.error);
      const b = parsed.data;
      const { marks } = await listMarks(deps.pool, pid);
      const prior = marks[0];
      if (!prior) throw problems.unprocessable('No prior mark to roll forward — record a mark first');

      const rolled = await engine<{ new_fair_value: number; change: number; method: string }>(
        '/engine/v1/fund-rollforward',
        {
          prior_fair_value: n(prior.fair_value),
          method: b.method,
          index_return: b.index_return,
          accretion_rate: b.accretion_rate,
          periods: b.periods,
          new_calibrated_value: b.new_calibrated_value,
        },
      );

      if (b.record) {
        // Only the recording half. `record` defaults false and the preview is
        // a calculator that persists nothing, so a withdrawn engagement can
        // still be looked at — the rule everywhere else. Asked here rather
        // than at the top so the read stays open, and asked again rather than
        // trusting the copy above: the engine call sits in between.
        await refuseIfMeasurementRetired(deps.pool, fund, 'accepting new marks');
        const mark = await withTransaction(deps.pool, async (client) => {
          const recorded = await createMark(client, {
            positionId: pid,
            measurementDate: b.measurement_date ?? todayLocal(),
            // A rolled mark is a model estimate → Level 3 (unless a fresh calibration).
            method: 'calibrated_opm',
            fairValue: requireStorableFigure(
              rolled.new_fair_value,
              'Rolled-forward fair value',
              FUND_MARK_FAIR_VALUE,
            )!,
            level: 3,
            inputs: { model_value: rolled.new_fair_value, rolled_from: prior.id, roll_method: b.method },
            createdBy: principal.id,
          });
          await recordFundEvent(client, fund, 'fund_mark_recorded', principal, {
            fund_id: id,
            position_id: pid,
            mark_id: recorded.id,
            company_name: position.company_name,
            measurement_date: recorded.measurement_date,
            method: recorded.method,
            level: recorded.level,
            fair_value: recorded.fair_value,
            rolled_from: prior.id,
            roll_method: b.method,
          });
          return recorded;
        });
        return reply.status(201).send({ rollforward: rolled, mark });
      }
      return { rollforward: rolled };
    },
  );

  // ── NAV ──────────────────────────────────────────────────────────────────
  app.get('/api/v1/funds/:id/nav', { preHandler: app.authenticate }, async (req) => {
    requireOps(requirePrincipal(req));
    const { id } = req.params as { id: string };
    const fund = await loadFund(id);
    const { positions, truncated } = await listPositions(deps.pool, id);
    if (positions.length === 0) throw problems.unprocessable('The fund has no positions to value');
    const marks = await latestMarks(
      deps.pool,
      positions.map((p) => p.id),
    );
    const enginePositions = positions.map((p) => {
      const mark = marks.get(p.id);
      if (mark && mark.inputs)
        return enginePosition(p.company_name, n(p.cost_basis), mark.method, mark.inputs);
      // No mark yet → carry at cost.
      return enginePosition(p.company_name, n(p.cost_basis), 'cost', {});
    });
    const nav = await engine<EngineNav>('/engine/v1/fund-valuation', {
      positions: enginePositions,
      liabilities: 0,
    });
    // NAV is a sum over the page, so a capped page is a NAV that is missing
    // holdings. Reported rather than silently under-stated; see
    // FUND_POSITION_PAGE_LIMIT.
    return { fund_id: fund.id, currency: fund.currency, nav, truncated };
  });

  // ── Engagement link ───────────────────────────────────────────────────────
  /**
   * Attach the portfolio to the `fund` engagement it is measured for, so the
   * report renderer can find it (0109). Detach with `valuation_id: null`.
   */
  app.put('/api/v1/funds/:id/valuation', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    requireOps(principal);
    const { id } = req.params as { id: string };
    const existing = await loadFund(id);
    const parsed = LinkBody.safeParse(req.body);
    if (!parsed.success) throw invalidBody('Invalid link', parsed.error);

    const valuationId = parsed.data.valuation_id;
    if (valuationId !== null) {
      const valuation = isUlid(valuationId) ? await findValuationById(deps.pool, valuationId) : null;
      // 404 rather than 422 for an id the caller cannot see, matching the
      // scope rule everywhere else: an out-of-scope id does not exist.
      if (!valuation) throw problems.notFound();
      // The kind is the check that matters. Linking a portfolio to a 409A
      // engagement would put a NAV schedule into a common-stock opinion.
      if (valuation.kind !== 'fund')
        throw problems.unprocessable(
          `A fund portfolio can only be linked to a “${kindLabel('fund')}”; ${valuationId} is a ` +
            `“${kindLabel(valuation.kind)}”. Link the portfolio to a fund engagement, or create one.`,
        );
      // Attaching a measurement subject to withdrawn work gives a retired
      // engagement a NAV schedule it did not have. Detaching (`null`) stays
      // open: it is the step `DELETE /funds/:id` tells the caller to take, and
      // cleanup on a withdrawn file is the standing exemption.
      refuseIfRetired(valuation, 'accepting a measurement subject');
    }

    try {
      const fund = await withTransaction(deps.pool, async (client) => {
        const linked = await linkFundToValuation(client, id, valuationId);
        // Both ends of the move, and each on its own engagement's trail. A
        // detach is the sharper of the two: it takes away the whole data
        // source the report renders its NAV schedule from, and it is the step
        // `DELETE /funds/:id` tells a caller to take before discarding the
        // marks.
        if (existing.valuation_id !== null && existing.valuation_id !== valuationId) {
          await recordFundEvent(client, existing, 'measurement_subject_unlinked', principal, {
            subject: 'fund',
            fund_id: id,
            fund_name: existing.name,
          });
        }
        if (linked && linked.valuation_id !== null && linked.valuation_id !== existing.valuation_id) {
          await recordFundEvent(client, linked, 'measurement_subject_linked', principal, {
            subject: 'fund',
            fund_id: id,
            fund_name: linked.name,
          });
        }
        return linked;
      });
      return { fund };
    } catch (err) {
      if (err instanceof MeasurementLinkConflict) throw problems.conflict(err.message);
      throw err;
    }
  });

  // ── LP terms ──────────────────────────────────────────────────────────────
  app.get('/api/v1/funds/:id/lp-terms', { preHandler: app.authenticate }, async (req) => {
    requireOps(requirePrincipal(req));
    const { id } = req.params as { id: string };
    await loadFund(id);
    return { lp_terms: await findLpTerms(deps.pool, id) };
  });

  app.put('/api/v1/funds/:id/lp-terms', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    requireOps(principal);
    const { id } = req.params as { id: string };
    const fund = await loadFundForWrite(id, 'accepting changes to its LP terms');
    const parsed = LpTermsBody.safeParse(req.body);
    if (!parsed.success) throw invalidBody('Invalid LP terms', parsed.error);
    const b = parsed.data;
    const lpTerms = await withTransaction(deps.pool, async (client) => {
      const saved = await upsertLpTerms(client, id, {
        committedCapital: b.committed_capital,
        contributedCapital: b.contributed_capital,
        preferredReturnRate: b.preferred_return_rate,
        carryPct: b.carry_pct,
        gpCatchUp: b.gp_catch_up,
        managementFeePct: b.management_fee_pct,
        managementFeesPaid: b.management_fees_paid,
        gpDistributionsToDate: b.gp_distributions_to_date,
      });
      await recordFundEvent(client, fund, 'fund_lp_terms_updated', principal, {
        fund_id: id,
        changes: b,
      });
      return saved;
    });
    return { lp_terms: lpTerms };
  });

  // ── Waterfall ─────────────────────────────────────────────────────────────
  app.post('/api/v1/funds/:id/waterfall', { preHandler: app.authenticate }, async (req) => {
    requireOps(requirePrincipal(req));
    const { id } = req.params as { id: string };
    await loadFund(id);
    const parsed = WaterfallBody.safeParse(req.body);
    if (!parsed.success) throw invalidBody('Invalid waterfall request', parsed.error);
    const terms = await findLpTerms(deps.pool, id);
    if (!terms) throw problems.unprocessable('Set the fund LP terms before running the waterfall');
    const waterfall = await engine('/engine/v1/fund-waterfall', {
      committed_capital: n(terms.committed_capital),
      contributed_capital: n(terms.contributed_capital),
      distributable: parsed.data.distributable,
      preferred_return_rate: n(terms.preferred_return_rate),
      years: parsed.data.years,
      carry_pct: n(terms.carry_pct),
      gp_catch_up: terms.gp_catch_up,
      management_fees_paid: n(terms.management_fees_paid),
      gp_distributions_to_date: n(terms.gp_distributions_to_date),
    });
    return { waterfall };
  });

  // ── Calibration ────────────────────────────────────────────────────────────
  app.post('/api/v1/funds/:id/calibrate', { preHandler: app.authenticate }, async (req) => {
    requireOps(requirePrincipal(req));
    const { id } = req.params as { id: string };
    await loadFund(id);
    const parsed = CalibrateBody.safeParse(req.body);
    if (!parsed.success) throw invalidBody('Invalid calibration request', parsed.error);
    const b = parsed.data;
    const calibration = await engine('/engine/v1/fund-calibrate', {
      round_price_per_share: b.round_price_per_share,
      total_equity_value: b.total_equity_value,
      strike: b.strike,
      time_to_exit_years: b.time_to_exit_years,
      risk_free_rate: b.risk_free_rate,
      preferred_shares: b.preferred_shares,
      fully_diluted_shares: b.fully_diluted_shares,
    });
    return { calibration };
  });
}
