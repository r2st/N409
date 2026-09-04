import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import type { AdminEventType } from '../domain/auditTrail.js';
import { isIsoCalendarDate, isUlid, problems } from '@n409/shared';
import { canReadValuation, isOps, type Principal } from '../auth/rbac.js';
import { InternalServiceError, postJson, toProblem } from '../clients/internal.js';
import { requireStorableFigure, ROLLFORWARD_EQUITY_VALUE } from '../domain/numericColumn.js';
import { requirePrincipal } from '../plugins/auth.js';
import { calendarDate } from '../domain/calendarDate.js';
import { findValuationById, type ValuationRow } from '../repos/valuations.js';
import { latestSucceededCalculation, type CalculationRow } from '../repos/calculations.js';
import {
  applyEngineInputsWithin,
  findParams,
  patchParamsWithin,
  type ValuationParamsRow,
} from '../repos/params.js';
import { withTransaction } from '../db/pool.js';
import { recordAdminEvent } from '../events/adminRecord.js';
import { finite, finitePositive } from '../domain/finite.js';
import {
  priorRequiredReturn,
  rollforwardableKind,
  RollforwardInputError,
  shapeRollforward,
  type RollforwardEngineResponse,
} from '../domain/rollforward.js';
import { kindLabel } from '../domain/valuationSelector.js';
import {
  findRollforwardRun,
  insertRollforwardRun,
  listRollforwardRuns,
  ROLLFORWARD_RUN_PAGE_LIMIT,
  markRollforwardRunApplied,
  type RollforwardRunRow,
} from '../repos/rollforwardRuns.js';
import { refuseIfRetired, refuseIfRetiredNow } from '../domain/retiredEngagement.js';
import { invalidBody } from '../domain/validationProblem.js';
import { unstorableEngineInputs } from './engineInputs.js';
import { ulidField } from '../domain/ulidField.js';

/**
 * Roll-forward — the bridge from the prior 409A to this one.
 *
 * `engine/v1/rollforward` has carried a prior calibrated equity value to a new
 * date since it was written, and had no caller; `valuation_params.rolling_forward`
 * has been a checkbox on the params panel since migration 0001, and nothing
 * read it. Between them that is a whole feature of the platform that existed
 * only as a flag an analyst could tick. This is the endpoint that makes the
 * flag mean something.
 *
 * The shape follows routes/volatility.ts, for the same reasons and with two
 * additions the second engagement forces:
 *
 *   * The prior valuation is authorised on its own, to the same standard as
 *     reading it directly. A caller who cannot see last year's 409A cannot
 *     learn its concluded equity value by rolling this year's forward from it.
 *   * Running and adopting are separate calls. A roll-forward that silently
 *     rewrote the engagement's backsolve anchor would move the concluded value
 *     of a valuation somebody may already be reviewing, on a button labelled
 *     "roll forward". Adoption is its own POST, and it is the only thing that
 *     lets Exhibit B-2 claim the bridge belongs to the calculation.
 *
 * Reading is open to anyone who can read the engagement — "why is this year's
 * number what it is, given last year's" is the question the client asks first.
 * Running and adopting are operations-only.
 */

/** Wall clock for the roll-forward itself. In-process arithmetic; generous. */
const ROLLFORWARD_TIMEOUT_MS = 15_000;

const Adjustment = z
  .object({
    label: z.string().trim().min(1).max(120),
    /** Multiplicative, as a fraction: -0.15 marks the anchor down 15%. */
    pct: finite().min(-0.99).max(10).nullish(),
    /** Additive, in the engagement's currency. */
    amount: finite().min(-1e15).max(1e15).nullish(),
  })
  .strict()
  .refine(
    (a) => (a.pct !== null && a.pct !== undefined ? true : a.amount !== null && a.amount !== undefined),
    {
      message: 'An adjustment needs a pct or an amount',
    },
  );

const RunBody = z
  .object({
    prior_valuation_id: ulidField(),
    /**
     * Appreciation applied over the gap. Omitted is the ordinary case: the
     * prior engagement's own concluded cost of capital is used where it has
     * one, and the engine's resolution stands where it does not.
     */
    annual_accretion: finite().gt(-1).max(10).nullish(),
    /**
     * A new priced round, which supersedes the time-decay anchor entirely —
     * there is nothing to calibrate forward when the market has just priced
     * the company again.
     */
    new_round_post_money: finitePositive().max(1e15).nullish(),
    value_adjustments: z.array(Adjustment).max(10).optional(),
  })
  .strict();

function present(row: RollforwardRunRow) {
  return {
    id: row.id,
    prior_valuation_id: row.prior_valuation_id,
    prior_calculation_id: row.prior_calculation_id,
    prior_valuation_number: row.prior_valuation_number,
    // Both are `date` columns; see domain/calendarDate.ts.
    prior_valuation_date: calendarDate(row.prior_valuation_date),
    new_valuation_date: calendarDate(row.new_valuation_date),
    years_elapsed: row.years_elapsed,
    prior_equity_value: row.prior_equity_value,
    rolled_equity_value: row.rolled_equity_value,
    annual_accretion: row.annual_accretion,
    new_round_post_money: row.new_round_post_money,
    calibration_steps: row.calibration_steps,
    material_changes: row.material_changes,
    requires_full_revaluation: row.requires_full_revaluation,
    // Derived here rather than stored, so the count and the rows behind it can
    // never disagree.
    material_change_count: row.material_changes.filter((c) => c.material).length,
    applied_at: row.applied_at,
    created_at: row.created_at,
  };
}

/** The engine `inputs` document as `valuation_params` stores it. */
function engineInputs(params: ValuationParamsRow | null): Record<string, unknown> {
  const raw = params?.engine_inputs;
  return raw !== null && typeof raw === 'object' && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {};
}

/**
 * The valuation date an engine `inputs` document states, at day resolution.
 *
 * Checked against the calendar rather than the shape, for the same reason as
 * `domain/rollforward.ts`'s `isoDate`: a stored document is not a validated
 * one, and `2026-02-31` has the shape of a day without being one.
 */
function valuationDateOf(inputs: Record<string, unknown>): string | null {
  const raw = inputs.valuation_date;
  if (typeof raw !== 'string') return null;
  const day = raw.slice(0, 10);
  return isIsoCalendarDate(day) ? day : null;
}

/** The backsolve anchor the calculation would read today. */
function appliedAnchor(inputs: Record<string, unknown>): number | null {
  const n = Number(inputs.last_round_post_money);
  return inputs.last_round_post_money !== null &&
    inputs.last_round_post_money !== undefined &&
    Number.isFinite(n)
    ? n
    : null;
}

/** The `{ params, inputs }` document a calculation was run with. */
function calculationInputs(calculation: CalculationRow): Record<string, unknown> {
  const payload = calculation.inputs as { inputs?: unknown } | null | undefined;
  const inner = payload?.inputs;
  return inner !== null && typeof inner === 'object' && !Array.isArray(inner)
    ? (inner as Record<string, unknown>)
    : {};
}

export function registerRollforwardRoutes(
  app: FastifyInstance,
  deps: { pool: pg.Pool; engineUrl: string },
): void {
  const loadReadable = async (id: string, principal: Principal): Promise<ValuationRow> => {
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

  const loadOps = async (id: string, principal: Principal): Promise<ValuationRow> => {
    if (!isOps(principal)) throw problems.forbidden('Rolling a valuation forward is operations-only');
    return loadReadable(id, principal);
  };

  const audit = async (
    valuation: ValuationRow,
    principal: Principal,
    type: AdminEventType,
    payload: Record<string, unknown>,
  ) =>
    recordAdminEvent(deps.pool, {
      type,
      actor: { actorType: 'human', actorId: principal.id },
      subjectType: 'valuation',
      subjectId: valuation.id,
      subjectLabel: valuation.company_name,
      payload,
    });

  /**
   * Every roll-forward run for this engagement, newest first, and the anchor
   * the calculation would read today.
   *
   * The applied anchor is served beside the runs rather than left for the
   * caller to fetch from the engine-inputs tab, because the only question the
   * panel exists to answer is whether the two agree.
   */
  app.get('/api/v1/valuations/:id/rollforward', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    const { id } = req.params as { id: string };
    const valuation = await loadReadable(id, principal);

    const [runPage, paramsRow] = await Promise.all([
      listRollforwardRuns(deps.pool, valuation.id),
      findParams(deps.pool, valuation.id),
    ]);
    const inputs = engineInputs(paramsRow);

    return {
      runs: runPage.runs.map(present),
      // The bridge history is a page, and the applied run can be anywhere in
      // it — adopting is a POST on any run by id — so a capped list is one that
      // can be missing the row `applied_anchor` came from.
      runs_truncated: runPage.truncated,
      runs_page_limit: ROLLFORWARD_RUN_PAGE_LIMIT,
      applied_anchor: appliedAnchor(inputs),
      // What a run would be struck *to* if one were started now. An engagement
      // with no valuation date is the reason the button cannot work, and saying
      // so here is cheaper than a 422 after the press.
      new_valuation_date: valuationDateOf(inputs),
      rolling_forward: paramsRow?.rolling_forward ?? false,
      can_edit: isOps(principal),
    };
  });

  /**
   * Roll a prior valuation forward to this engagement's date.
   *
   * Does not touch the engagement's engine inputs — see the module note.
   */
  app.post('/api/v1/valuations/:id/rollforward', { preHandler: app.authenticate }, async (req, reply) => {
    const principal = requirePrincipal(req);
    const { id } = req.params as { id: string };
    const valuation = await loadOps(id, principal);
    refuseIfRetired(valuation, 'accepting roll-forward runs');

    const parsed = RunBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      throw invalidBody('Invalid roll-forward request', parsed.error);
    }
    const body = parsed.data;

    if (body.prior_valuation_id === valuation.id) {
      throw problems.unprocessable('A valuation cannot be rolled forward from itself');
    }
    // Authorised on its own: the prior engagement's concluded equity value is
    // the substance of this answer, and a caller who cannot read it must not
    // receive it by way of one they can.
    const prior = await loadReadable(body.prior_valuation_id, principal);
    /*
     * Refused rather than attempted, the way the bridge one route over refuses
     * a pair it cannot factorise.
     *
     * A roll-forward carries one *equity value* from one date to another, and
     * the engine reads that figure off the prior run's stored results. A
     * specialty engine writes `{ kind, specialty }` and states no equity value,
     * so this reached the engine and came back as
     * `prior_results.equity_value (positive) is required` — the only sentence
     * the analyst sees on a 422, in the vocabulary of a service they have never
     * heard of, about a request the product knew was unanswerable before it
     * left the process.
     *
     * Both sides, because the run also *writes* the rolled value onto this
     * engagement's backsolve anchor when it is adopted, and a specialty
     * engagement has no such anchor to move.
     */
    const unrollable = [valuation, prior].find((v) => !rollforwardableKind(v.kind));
    if (unrollable) {
      throw problems.unprocessable(
        `A “${kindLabel(unrollable.kind)}” is not measured in the figure a roll-forward carries — it ` +
          'compounds a prior appraisal’s concluded equity value forward to a new date, and a ' +
          `“${kindLabel(unrollable.kind)}” calculation concludes no equity value. Roll a 409A ` +
          `forward instead.`,
      );
    }
    if (prior.currency !== valuation.currency) {
      throw problems.unprocessable(
        `The prior valuation is denominated in ${prior.currency} and this one in ${valuation.currency}; ` +
          'a roll-forward carries one equity value forward and cannot cross currencies',
      );
    }

    const [priorCalculation, paramsRow] = await Promise.all([
      latestSucceededCalculation(deps.pool, prior.id),
      findParams(deps.pool, valuation.id),
    ]);
    if (!priorCalculation) {
      throw problems.unprocessable(
        'The prior valuation has no successful calculation to roll forward from — its concluded equity ' +
          'value is what this bridge starts at',
      );
    }

    const priorInputs = calculationInputs(priorCalculation);
    const priorDate = valuationDateOf(priorInputs);
    if (priorDate === null) {
      throw problems.unprocessable('The prior calculation states no valuation date to roll forward from');
    }

    const updatedInputs = engineInputs(paramsRow);
    const newDate = valuationDateOf(updatedInputs);
    if (newDate === null) {
      throw problems.unprocessable(
        'This engagement states no valuation date to roll forward to — set one on the engine inputs first',
      );
    }
    if (newDate < priorDate) {
      throw problems.unprocessable(
        `This engagement is dated ${newDate}, before the prior valuation's ${priorDate}; a roll-forward ` +
          'runs forward in time',
      );
    }

    /*
     * The accretion, in the order a reviewer would defend it: what the analyst
     * asked for, then the cost of capital the prior appraisal itself concluded,
     * then — by omission — the engine's own resolution. The middle one is the
     * reason this is resolved here rather than left entirely to the engine: the
     * engine sees `prior_results` and can read a rate off it, but a request
     * that states the rate records *which* rate was chosen in the run itself.
     */
    const accretion = body.annual_accretion ?? priorRequiredReturn(priorCalculation.results) ?? undefined;

    let response: RollforwardEngineResponse;
    try {
      response = await postJson<RollforwardEngineResponse>(
        'engine',
        `${deps.engineUrl}/engine/v1/rollforward`,
        {
          prior_results: priorCalculation.results ?? {},
          prior_valuation_date: priorDate,
          new_valuation_date: newDate,
          prior_inputs: priorInputs,
          updated_inputs: updatedInputs,
          ...(accretion === undefined ? {} : { annual_accretion: accretion }),
          ...(body.new_round_post_money === null || body.new_round_post_money === undefined
            ? {}
            : { new_round_post_money: body.new_round_post_money }),
          ...(body.value_adjustments && body.value_adjustments.length > 0
            ? { value_adjustments: body.value_adjustments }
            : {}),
        },
        {
          timeoutMs: ROLLFORWARD_TIMEOUT_MS,
          record: { valuationId: valuation.id, name: 'engine rollforward' },
        },
      );
    } catch (err) {
      if (err instanceof InternalServiceError) {
        req.log.warn({ err, valuationId: valuation.id }, 'roll-forward failed');
        throw toProblem(err);
      }
      throw err;
    }

    let shaped: ReturnType<typeof shapeRollforward>;
    try {
      shaped = shapeRollforward(response);
    } catch (err) {
      if (err instanceof RollforwardInputError) throw problems.unprocessable(err.message);
      throw err;
    }

    // The engagement as it stands now — see the guard on the compute in
    // `calculations.ts`. The stored run is what Exhibit B-2 is drawn from.
    await refuseIfRetiredNow(deps.pool, valuation.id, 'accepting roll-forward runs');
    const row = await insertRollforwardRun(deps.pool, {
      valuationId: valuation.id,
      priorValuationId: prior.id,
      priorCalculationId: priorCalculation.id,
      // Denormalised so Exhibit B-2 can cite the prior engagement even after
      // the row it points at is gone (migration 0150).
      priorValuationNumber: prior.number,
      priorValuationDate: shaped.priorValuationDate,
      newValuationDate: shaped.newValuationDate,
      yearsElapsed: shaped.yearsElapsed,
      /*
       * Checked against the column, the way `funds.ts` and `debt.ts` already
       * check the figures they store — see domain/numericColumn.ts. Both the
       * engine and `shapeRollforward` ask whether these are finite and
       * positive, and neither asks whether they fit: `(1 + rate) ** years` at
       * the rate cap `RunBody` allows takes an ordinary anchor past what
       * `numeric(20, 2)` holds in about eleven years, and the driver's 22003
       * reached the analyst as a 500 with nothing in it about the rate.
       */
      priorEquityValue: requireStorableFigure(
        shaped.priorEquityValue,
        'Prior equity value',
        ROLLFORWARD_EQUITY_VALUE,
      )!,
      rolledEquityValue: requireStorableFigure(
        shaped.rolledEquityValue,
        'Rolled-forward equity value',
        ROLLFORWARD_EQUITY_VALUE,
      )!,
      annualAccretion: shaped.annualAccretion,
      newRoundPostMoney: body.new_round_post_money ?? null,
      calibrationSteps: shaped.calibrationSteps,
      materialChanges: shaped.materialChanges,
      requiresFullRevaluation: shaped.requiresFullRevaluation,
      prePopulatedInputs: shaped.prePopulatedInputs,
      createdBy: principal.id,
    });

    await audit(valuation, principal, 'rollforward_run', {
      run_id: row.id,
      prior_valuation_id: prior.id,
      prior_valuation_number: prior.number,
      prior_equity_value: row.prior_equity_value,
      rolled_equity_value: row.rolled_equity_value,
      annual_accretion: row.annual_accretion,
      years_elapsed: row.years_elapsed,
      requires_full_revaluation: row.requires_full_revaluation,
      material_changes: row.material_changes.filter((c) => c.material).map((c) => c.field),
    });

    return reply.status(201).send({
      run: present(row),
      applied_anchor: appliedAnchor(updatedInputs),
    });
  });

  /**
   * Adopt a run's rolled value as the engagement's backsolve anchor.
   *
   * Writes through `applyEngineInputs` rather than straight into the column, so
   * the change lands in the engagement's event trail as a params update exactly
   * as a hand-entered one would.
   *
   * Two fields go with it, and the second is the reason this is not a one-line
   * write. `compute` only treats `last_round_post_money` as the anchor when
   * there is no round price to calibrate against: given a
   * `last_round_price_per_share` it root-finds the equity value that reprices
   * that class and uses the post-money as a starting guess. So adopting a
   * rolled value while a *stale* price sat beside it would throw the whole
   * roll-forward away and re-derive a value off last year's round price. The
   * engine already decided that question when it built `pre_populated_inputs`
   * — it drops the price unless the new date supplies one — and this follows
   * its answer rather than forming a second one.
   */
  app.post(
    '/api/v1/valuations/:id/rollforward/:runId/apply',
    { preHandler: app.authenticate },
    async (req) => {
      const principal = requirePrincipal(req);
      const { id, runId } = req.params as { id: string; runId: string };
      const valuation = await loadOps(id, principal);
      refuseIfRetired(valuation, 'applying results');
      if (!isUlid(runId)) throw problems.notFound();

      const run = await findRollforwardRun(deps.pool, valuation.id, runId);
      if (!run) throw problems.notFound();

      const paramsRow = await findParams(deps.pool, valuation.id);
      const before = appliedAnchor(engineInputs(paramsRow));

      const supersededPrice = run.pre_populated_inputs.last_round_price_per_share === undefined;
      // The benchmark adjustment goes the same way, and for a sharper reason
      // than the price: it does not compete with the anchor, it multiplies it.
      // `market_movement` moves a round indication forward over the interval
      // between the round and the prior valuation date, and the rolled value
      // has already been carried across that interval — so leaving it beside
      // the new anchor applies the same market move twice and cites a period
      // ending before the date the conclusion is stated as of.
      const supersededMovement = run.pre_populated_inputs.market_movement === undefined;
      const actor = { actorType: 'human' as const, actorId: principal.id };

      /*
       * The anchor, against the schema that owns the document it is written
       * into — see `unstorableEngineInputs`.
       *
       * This adoption goes through `applyEngineInputsWithin`, the repo call, so
       * `EngineInputsBody` never saw it, and the two bounds on this one figure
       * are set by different considerations. `rolled_equity_value` is held to
       * `numeric(20, 2)` by `requireStorableFigure` — below 1e18.
       * `last_round_post_money` is `boundedNonNegative()` — below `MAX_QUANTITY`,
       * 9.007e15, past which a double stops adding exactly. A roll-forward is
       * `prior x (1 + rate) ** years` with the rate capped at 10, so a mistyped
       * 1000% over a nine-year gap takes a $10M anchor to 2.3e16: storable in
       * the run, refused by the form.
       *
       * Adopting it anyway is the shape `routes/projections.ts` names — "a value
       * into `engine_inputs` by the one path that did not check it" — and the
       * form is where it lands: `FinancialModelPanel` posts the whole model
       * back, so every later save answers 422 on an anchor the analyst never
       * typed. Refused here instead, before the anchor moves and before the
       * price and the market movement beside it are cleared.
       */
      const unstorable = unstorableEngineInputs({
        last_round_post_money: run.rolled_equity_value,
      });
      if (unstorable) {
        throw problems.unprocessable(
          `This run cannot be adopted: ${unstorable}. The engagement's anchor is unchanged.`,
        );
      }

      /*
       * THREE WRITES, ONE DECISION (R404, methodology M5).
       *
       * These were three statements on the pool, each committing on its own,
       * and the third is the only writer of `applied_at` — the column
       * `findAppliedRollforwardRun` reads to answer "which run is the
       * calculation carrying", which Exhibit B-2 states the bridge from. Its
       * own note says what a disagreement here costs: "adopt A, adopt B, go
       * back to A, and the calculation carries A while the lookup still named
       * B. That is the superseded row R304 stopped the exhibits from
       * describing." A failure part-way is that state arrived at without anyone
       * clicking twice.
       *
       * The first write is the irreversible half and the loudest: it moves the
       * engagement's backsolve anchor and *deletes* the round price, the share
       * class and the market-movement adjustment that the adoption supersedes.
       * A 500 after it says the adoption did not happen, on an engagement whose
       * anchor has moved and two of whose inputs are gone — and `rolling_forward`
       * unset beside it leaves the params claiming the opposite of what the
       * engine inputs now say.
       *
       * A retry is not the recovery it looks like either: `before` is re-read
       * from the params the failed attempt already moved, so
       * `recalculation_required` below comes back false for an engagement whose
       * stored results were struck on the old anchor.
       *
       * One transaction, so the 500 means what it says. The
       * `rollforward_applied` admin event stays outside with the estate's other
       * `recordAdminEvent` call sites; see `routes/volatility.ts`.
       */
      const applied = await withTransaction(deps.pool, async (client) => {
        await applyEngineInputsWithin(
          client,
          valuation.id,
          {
            last_round_post_money: run.rolled_equity_value,
            // Explicit nulls: the engine-inputs convention for clearing a field,
            // and a jsonb merge has no other way to remove one.
            ...(supersededPrice ? { last_round_price_per_share: null, last_round_class: null } : {}),
            ...(supersededMovement ? { market_movement: null } : {}),
          },
          actor,
        );
        // The checkbox that has existed since migration 0001 and meant nothing.
        // Adopting the bridge is the declaration it was always asking for, so it
        // is recorded rather than left for somebody to tick separately.
        if (paramsRow && !paramsRow.rolling_forward) {
          await patchParamsWithin(client, paramsRow, { rolling_forward: true }, actor);
        }

        return markRollforwardRunApplied(client, valuation.id, runId, principal.id);
      });
      await audit(valuation, principal, 'rollforward_applied', {
        run_id: runId,
        from: before,
        to: run.rolled_equity_value,
        cleared_round_price: supersededPrice,
        cleared_market_movement: supersededMovement,
      });

      return {
        run: applied ? present(applied) : present(run),
        applied_anchor: run.rolled_equity_value,
        // The engagement's figures are now stale against its inputs. Saying so
        // is the route's job; recalculating on its own would be a second,
        // unasked-for change to a valuation somebody may be mid-review on.
        recalculation_required: before === null || Math.abs(before - run.rolled_equity_value) > 1e-9,
        /*
         * The two inputs this adoption deleted (round 360, methodology M5).
         *
         * Both clears are right — a superseded round price is not the anchor
         * any more, and leaving `market_movement` beside the rolled value
         * applies the same market move twice — and both were recorded in the
         * `rollforward_applied` event and nowhere a person would look. The
         * response carried `recalculation_required` alone, so the whole of
         * what the panel could say was "Adopted", and the first sight of a
         * price-per-share and a share class having been removed from the
         * engagement was a blank pair of fields on the Params tab, later,
         * with nothing tying them to this action.
         *
         * Named after what they cleared, so a client reading them does not
         * have to tell "nothing was superseded" from "this deployment does
         * not report it": both are always present.
         */
        cleared_round_price: supersededPrice,
        cleared_market_movement: supersededMovement,
      };
    },
  );
}
