import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { isUlid, problems } from '@n409/shared';
import { isOps, type Principal } from '../auth/rbac.js';
import { postJson, toProblem, InternalServiceError } from '../clients/internal.js';
import { requirePrincipal } from '../plugins/auth.js';
import { CurrencyCode } from '../domain/currency.js';
import {
  createFund,
  createMark,
  createPosition,
  findFund,
  findLpTerms,
  findPosition,
  latestMarks,
  listFunds,
  listMarks,
  listPositions,
  upsertLpTerms,
  type MarkMethod,
} from '../repos/funds.js';

/**
 * ASC 820 fund-holdings valuation (feature: ASC 820 Fund Holdings).
 *
 * A fund (VC / PE / credit) marks a portfolio of equity positions to fair
 * value, classifies each in the ASC 820 hierarchy, rolls them up into NAV, and
 * distributes proceeds through an LP waterfall. The valuation service owns the
 * CRUD + mark history; the Python engine (fund_valuation.py) does the maths.
 * Ops-only, like the rest of the measurement surface.
 */

const DateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD');

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

  // ── Funds ────────────────────────────────────────────────────────────────
  app.post('/api/v1/funds', { preHandler: app.authenticate }, async (req, reply) => {
    const principal = requirePrincipal(req);
    requireOps(principal);
    const parsed = FundBody.safeParse(req.body);
    if (!parsed.success) throw problems.unprocessable('Invalid fund', { errors: parsed.error.issues });
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
    return { funds: await listFunds(deps.pool) };
  });

  app.get('/api/v1/funds/:id', { preHandler: app.authenticate }, async (req) => {
    requireOps(requirePrincipal(req));
    const { id } = req.params as { id: string };
    const fund = await loadFund(id);
    const positions = await listPositions(deps.pool, id);
    const marks = await latestMarks(deps.pool, id);
    const lpTerms = await findLpTerms(deps.pool, id);
    return {
      fund,
      lp_terms: lpTerms,
      positions: positions.map((p) => ({ ...p, latest_mark: marks.get(p.id) ?? null })),
    };
  });

  // ── Positions ────────────────────────────────────────────────────────────
  app.post('/api/v1/funds/:id/positions', { preHandler: app.authenticate }, async (req, reply) => {
    requireOps(requirePrincipal(req));
    const { id } = req.params as { id: string };
    await loadFund(id);
    const parsed = PositionBody.safeParse(req.body);
    if (!parsed.success) throw problems.unprocessable('Invalid position', { errors: parsed.error.issues });
    const b = parsed.data;
    const position = await createPosition(deps.pool, {
      fundId: id,
      companyName: b.company_name,
      securityType: b.security_type,
      quantity: b.quantity,
      costBasis: b.cost_basis,
      markMethod: b.mark_method,
    });
    return reply.status(201).send({ position });
  });

  // ── Marks ────────────────────────────────────────────────────────────────
  app.get('/api/v1/funds/:id/positions/:pid/marks', { preHandler: app.authenticate }, async (req) => {
    requireOps(requirePrincipal(req));
    const { id, pid } = req.params as { id: string; pid: string };
    await loadFund(id);
    const position = await findPosition(deps.pool, id, pid);
    if (!position) throw problems.notFound();
    return { marks: await listMarks(deps.pool, pid) };
  });

  app.post('/api/v1/funds/:id/positions/:pid/marks', { preHandler: app.authenticate }, async (req, reply) => {
    const principal = requirePrincipal(req);
    requireOps(principal);
    const { id, pid } = req.params as { id: string; pid: string };
    await loadFund(id);
    const position = await findPosition(deps.pool, id, pid);
    if (!position) throw problems.notFound();
    const parsed = MarkBody.safeParse(req.body);
    if (!parsed.success) throw problems.unprocessable('Invalid mark', { errors: parsed.error.issues });
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
    const mark = await createMark(deps.pool, {
      positionId: pid,
      measurementDate: b.measurement_date,
      method: b.method,
      fairValue: marked.fair_value,
      level: marked.level,
      inputs,
      createdBy: principal.id,
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
      await loadFund(id);
      const position = await findPosition(deps.pool, id, pid);
      if (!position) throw problems.notFound();
      const parsed = RollForwardBody.safeParse(req.body);
      if (!parsed.success)
        throw problems.unprocessable('Invalid roll-forward', { errors: parsed.error.issues });
      const b = parsed.data;
      const marks = await listMarks(deps.pool, pid);
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
        const mark = await createMark(deps.pool, {
          positionId: pid,
          measurementDate: b.measurement_date ?? new Date().toISOString().slice(0, 10),
          // A rolled mark is a model estimate → Level 3 (unless a fresh calibration).
          method: 'calibrated_opm',
          fairValue: rolled.new_fair_value,
          level: 3,
          inputs: { model_value: rolled.new_fair_value, rolled_from: prior.id, roll_method: b.method },
          createdBy: principal.id,
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
    const positions = await listPositions(deps.pool, id);
    if (positions.length === 0) throw problems.unprocessable('The fund has no positions to value');
    const marks = await latestMarks(deps.pool, id);
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
    return { fund_id: fund.id, currency: fund.currency, nav };
  });

  // ── LP terms ──────────────────────────────────────────────────────────────
  app.get('/api/v1/funds/:id/lp-terms', { preHandler: app.authenticate }, async (req) => {
    requireOps(requirePrincipal(req));
    const { id } = req.params as { id: string };
    await loadFund(id);
    return { lp_terms: await findLpTerms(deps.pool, id) };
  });

  app.put('/api/v1/funds/:id/lp-terms', { preHandler: app.authenticate }, async (req) => {
    requireOps(requirePrincipal(req));
    const { id } = req.params as { id: string };
    await loadFund(id);
    const parsed = LpTermsBody.safeParse(req.body);
    if (!parsed.success) throw problems.unprocessable('Invalid LP terms', { errors: parsed.error.issues });
    const b = parsed.data;
    const lpTerms = await upsertLpTerms(deps.pool, id, {
      committedCapital: b.committed_capital,
      contributedCapital: b.contributed_capital,
      preferredReturnRate: b.preferred_return_rate,
      carryPct: b.carry_pct,
      gpCatchUp: b.gp_catch_up,
      managementFeePct: b.management_fee_pct,
      managementFeesPaid: b.management_fees_paid,
      gpDistributionsToDate: b.gp_distributions_to_date,
    });
    return { lp_terms: lpTerms };
  });

  // ── Waterfall ─────────────────────────────────────────────────────────────
  app.post('/api/v1/funds/:id/waterfall', { preHandler: app.authenticate }, async (req) => {
    requireOps(requirePrincipal(req));
    const { id } = req.params as { id: string };
    await loadFund(id);
    const parsed = WaterfallBody.safeParse(req.body);
    if (!parsed.success)
      throw problems.unprocessable('Invalid waterfall request', { errors: parsed.error.issues });
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
    if (!parsed.success)
      throw problems.unprocessable('Invalid calibration request', { errors: parsed.error.issues });
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
