import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { ApiProblem, isUlid, problems } from '@n409/shared';
import { isOps, type Principal } from '../auth/rbac.js';
import { VALUATION_STATES, stateLabel, type ValuationState } from '../domain/valuation.js';
import {
  BULK_ACTIONS,
  canRestart,
  canTransition,
  nextState,
  RESTART_STATE,
  restartRefusal,
} from '../domain/workflow.js';
import {
  findValuationById,
  findValuationsByIds,
  patchValuation,
  type ValuationRow,
} from '../repos/valuations.js';
import { userExists } from '../repos/users.js';
import type { EmailTransport, TransitionRenderDeps } from '../hooks/stateChange.js';
import { applyValuationState } from '../domain/applyState.js';
import { requirePrincipal } from '../plugins/auth.js';
import type { EventActor } from '../events/record.js';
import { refuseIfRetired } from '../domain/retiredEngagement.js';
import { describeForUser, InternalServiceError } from '../clients/internal.js';
import { invalidBody } from '../domain/validationProblem.js';
import { ulidField } from '../domain/ulidField.js';

/**
 * Workflow engine routes (M4, P1 #22) + bulk actions (P1 #23). All mutations
 * go through patchValuation so the audit spine records them; the state-change
 * hook then fires the auto email workflows / notifications.
 */

const ReassignBody = z.object({ reviewer_id: ulidField().nullable() });

const BulkBody = z.object({
  ids: z.array(z.string()).min(1).max(200),
  action: z.enum(BULK_ACTIONS),
  state: z.enum(VALUATION_STATES).optional(),
  reviewer_id: ulidField().nullable().optional(),
});

/**
 * Canonical bulk contract (improvement 5):
 * POST /valuations/bulk-action { action, valuation_ids, params }.
 * Normalized into the same executor as the legacy /valuations/bulk shape.
 */
export const BulkActionBody = z.object({
  action: z.enum(BULK_ACTIONS),
  valuation_ids: z.array(z.string()).min(1).max(200),
  params: z
    .object({
      state: z.enum(VALUATION_STATES).optional(),
      reviewer_id: ulidField().nullable().optional(),
    })
    .optional(),
});

export interface BulkInput {
  ids: string[];
  action: (typeof BULK_ACTIONS)[number];
  state?: ValuationState;
  reviewer_id?: string | null;
}

/**
 * Ids to act on, each exactly once, in the order the caller sent them.
 *
 * A bulk action is not idempotent per id, and the executor loops over the list
 * verbatim — so a repeated id was applied twice. For `advance` that is the
 * sharpest form of the bug: the same valuation takes *two* steps through the
 * workflow from one click, `pending → started → review`, and both are recorded
 * as ordinary transitions with their own emails to the client. `set_state`
 * reported the second attempt as an illegal-transition failure, so an operator
 * saw "1 succeeded, 1 failed" on a selection of one and had no way to tell that
 * from a real conflict. `assign_reviewer` wrote the same value twice and left
 * two audit events for one decision.
 *
 * Duplicates arrive more easily than they look. The worklist's own selection is
 * a Set, but the export-and-re-import round trip an operator does with a
 * spreadsheet is not, the API is public to partners, and a retried request that
 * concatenates rather than replaces produces exactly this list.
 *
 * Case-folding is part of it: ULIDs are case-insensitive and `findValuationById`
 * accepts either, so `01ARZ…` and `01arz…` are one valuation to the database and
 * were two to this loop.
 */
export function dedupeIds(ids: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of ids) {
    const key = id.toUpperCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(id);
  }
  return out;
}

/** Maps the bulk-action contract onto the executor's input. Pure — unit tested. */
export function toBulkInput(body: z.infer<typeof BulkActionBody>): BulkInput {
  return {
    ids: dedupeIds(body.valuation_ids),
    action: body.action,
    state: body.params?.state,
    reviewer_id: body.params?.reviewer_id,
  };
}

export interface WorkflowDeps extends TransitionRenderDeps {
  pool: pg.Pool;
  transport?: EmailTransport;
}

function actorFor(principal: Principal, source: string): EventActor {
  return { actorType: 'human', actorId: principal.id, source };
}

function requireOps(principal: Principal): void {
  if (!isOps(principal)) throw problems.forbidden('Workflow actions are operations-only');
}

async function loadValuation(pool: pg.Pool, id: string): Promise<ValuationRow> {
  if (!isUlid(id)) throw problems.notFound();
  const valuation = await findValuationById(pool, id);
  if (!valuation) throw problems.notFound();
  return valuation;
}

/**
 * `loadValuation` against a map the caller has already filled, so a bulk action
 * raises the same 404 for a malformed or unknown id as the single-id routes do
 * — the per-row `error` string in the bulk response is that message, and it
 * must not change shape just because the read moved out of the loop.
 */
function fromPrefetch(rows: ReadonlyMap<string, ValuationRow>, id: string): ValuationRow {
  if (!isUlid(id)) throw problems.notFound();
  const valuation = rows.get(id);
  if (!valuation) throw problems.notFound();
  return valuation;
}

export function registerWorkflowRoutes(app: FastifyInstance, deps: WorkflowDeps): void {
  /**
   * Every transition here is conditional on the row still being at the version
   * it was read at — see `applyValuationState`, which now guards for all of its
   * callers rather than for the one that asked.
   *
   * The bulk executor is the caller that asked, and the reason is written up
   * under {@link executeBulk}: its reads are batched at the top of the request
   * and its writes run the length of it. The single-id routes below read and
   * write one statement apart, which narrows that window without closing it —
   * two holders of one read is what a double-clicked button produces, and it
   * used to buy a duplicate transition with its own client email.
   */
  const applyState = async (
    valuation: ValuationRow,
    to: ValuationState,
    principal: Principal,
    source: string,
  ): Promise<ValuationRow> =>
    applyValuationState(
      { pool: deps.pool, transport: deps.transport, log: app.log },
      valuation,
      to,
      actorFor(principal, source),
    );

  app.post('/api/v1/valuations/:id/workflow/advance', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    requireOps(principal);
    const { id } = req.params as { id: string };
    const valuation = await loadValuation(deps.pool, id);
    refuseIfRetired(valuation, 'accepting workflow changes');

    const next = nextState(valuation.state, { paidStatus: valuation.paid_status });
    if (!next) {
      throw problems.conflict(
        `There is no next step to advance to from “${stateLabel(valuation.state)}”. ` +
          'Move it with a state change instead, or restart it.',
      );
    }
    return { valuation: await applyState(valuation, next, principal, 'workflow') };
  });

  app.post('/api/v1/valuations/:id/workflow/restart', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    requireOps(principal);
    const { id } = req.params as { id: string };
    const valuation = await loadValuation(deps.pool, id);
    refuseIfRetired(valuation, 'accepting workflow changes');

    if (!canRestart(valuation.state)) throw problems.conflict(restartRefusal(valuation.state));
    return { valuation: await applyState(valuation, RESTART_STATE, principal, 'workflow') };
  });

  app.post('/api/v1/valuations/:id/workflow/reassign', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    requireOps(principal);
    const { id } = req.params as { id: string };
    const valuation = await loadValuation(deps.pool, id);
    refuseIfRetired(valuation, 'accepting workflow changes');

    const parsed = ReassignBody.safeParse(req.body);
    if (!parsed.success) throw invalidBody('Invalid reassign', parsed.error);
    const reviewerId = parsed.data.reviewer_id;
    if (reviewerId !== null && (!isUlid(reviewerId) || !(await userExists(deps.pool, reviewerId)))) {
      throw problems.unprocessable('Unknown reviewer', { errors: [{ path: ['reviewer_id'] }] });
    }

    const updated = await patchValuation(
      deps.pool,
      valuation,
      { assigned_reviewer_id: reviewerId },
      actorFor(principal, 'workflow'),
    );
    return { valuation: updated };
  });

  const executeBulk = async (principal: Principal, input: BulkInput) => {
    // Both entry points normalize, but the guarantee belongs to the executor:
    // it is the loop whose body is not idempotent. See `dedupeIds`.
    const ids = dedupeIds(input.ids);
    const { action, state, reviewer_id } = input;

    if (action === 'set_state' && !state) {
      throw problems.unprocessable('state is required for set_state');
    }
    if (action === 'assign_reviewer') {
      if (reviewer_id === undefined)
        throw problems.unprocessable('reviewer_id is required for assign_reviewer');
      if (reviewer_id !== null && (!isUlid(reviewer_id) || !(await userExists(deps.pool, reviewer_id)))) {
        throw problems.unprocessable('Unknown reviewer', { errors: [{ path: ['reviewer_id'] }] });
      }
    }

    /*
     * One read for the whole selection, not one per id.
     *
     * The loop below is unavoidably sequential — each body writes, and the
     * transitions are recorded in the order the operator sent them — but the
     * *reads* are not. A 200-id bulk action (the schema's cap) opened 200
     * round trips before the first write, all of them the same single-row
     * `SELECT * FROM valuations WHERE id = $1`, and the whole batch is
     * latency-bound on that: at a 1ms round trip the reads alone cost more
     * than the engine work behind most of the actions.
     *
     * `dedupeIds` above is what makes this exactly equivalent: every id is
     * loaded once either way, so prefetching cannot serve a row that the
     * per-id read would have re-read after a write to it. Batched reads also
     * bypass the five-second `findValuationById` row cache, so what the loop
     * sees is fresher at the moment it is read.
     *
     * It is not fresher at the moment it is *written*, and that is the cost the
     * batching carries. Every row is now read at the top of the batch while the
     * writes run the length of it, and an iteration is not cheap: a publish-gate
     * query, a transaction of three statements, a partner webhook dispatched
     * over the network, template lookups and outbox writes. Two hundred of those
     * is seconds at best, so the last id in a batch is judged against a state
     * read a long time before it is acted on — a window the per-id read this
     * replaced did not have.
     *
     * What goes wrong in that window is not a lost edit but a wrong transition.
     * `canTransition`, `nextState` and `canRestart` are all evaluated against the
     * prefetched row, so an engagement someone moved in the meantime gets a
     * transition that is legal from where it *was* and may be illegal from where
     * it is — recorded as an ordinary transition, with its own client emails, and
     * overwriting the concurrent move without a trace. `expectedVersion` refuses
     * that write instead: `patchValuation` bumps `version` on every state write
     * and nothing else writes `state`, so a row that moved fails this one id with
     * the conflict the single-id routes now raise too. A per-id failure is what
     * the results array below exists to carry.
     */
    const prefetched = await findValuationsByIds(deps.pool, ids.filter(isUlid));

    const results: Array<{ id: string; ok: boolean; error?: string; state?: ValuationState }> = [];
    for (const id of ids) {
      try {
        const valuation = fromPrefetch(prefetched, id);
        /*
         * The same refusal the three single-id routes above make, and it was
         * missing here alone.
         *
         * `retiredEngagementWrites.test.ts` drives every mutating route *under
         * a valuation id* against a live engagement and an archived twin, which
         * is why R89 caught `/workflow/advance` and `/engagement/advance` and
         * could not see this: the bulk door names its engagements in the body,
         * so it is not a valuation-scoped route and the census never reached
         * it. Everything R89 refused at the single-id door was reachable
         * through it — `set_state` writes any legal transition onto a withdrawn
         * file, `advance` and `restart` move it through the pipeline, and each
         * of those fires `onStateChanged`: the client's email about work the
         * firm has withdrawn, and the partner's webhook announcing it.
         *
         * Per row rather than for the batch, because that is what the results
         * array is for: an operator sweeping two hundred ids does not want the
         * one retired file in the selection to refuse the other hundred and
         * ninety-nine, and `ok: false` with the helper's own message is how
         * every other per-row refusal here is reported.
         *
         * `assign_reviewer` is refused too. It queues no mail, but the review
         * queue is a worklist of things somebody is being told to do, and a
         * withdrawn engagement assigned to a reviewer is work the firm is no
         * longer doing landing on somebody's list.
         */
        refuseIfRetired(valuation, 'accepting workflow changes');
        switch (action) {
          case 'set_state': {
            if (!canTransition(valuation.state, state!)) {
              throw problems.conflict(
                `This valuation cannot move from “${stateLabel(valuation.state)}” to ` +
                  `“${stateLabel(state!)}”.`,
              );
            }
            const updated = await applyState(valuation, state!, principal, 'bulk');
            results.push({ id, ok: true, state: updated.state });
            break;
          }
          case 'advance': {
            const next = nextState(valuation.state, { paidStatus: valuation.paid_status });
            if (!next)
              throw problems.conflict(
                `There is no next step to advance to from “${stateLabel(valuation.state)}”. ` +
                  'Move it with a state change instead, or restart it.',
              );
            const updated = await applyState(valuation, next, principal, 'bulk');
            results.push({ id, ok: true, state: updated.state });
            break;
          }
          case 'restart': {
            if (!canRestart(valuation.state)) throw problems.conflict(restartRefusal(valuation.state));
            const updated = await applyState(valuation, RESTART_STATE, principal, 'bulk');
            results.push({ id, ok: true, state: updated.state });
            break;
          }
          case 'assign_reviewer': {
            // Unguarded on purpose, unlike the three transitions above. This
            // sets a column to a value the operator named rather than deriving
            // one from the row's current state, so a stale read cannot make it
            // wrong — and overwriting a concurrent assignment is what "assign
            // these two hundred to Alice" asks for. The UPDATE touches only
            // `assigned_reviewer_id`, so a concurrent state change survives it.
            await patchValuation(
              deps.pool,
              valuation,
              { assigned_reviewer_id: reviewer_id },
              actorFor(principal, 'bulk'),
            );
            results.push({ id, ok: true });
            break;
          }
        }
      } catch (err) {
        /**
         * A 200 body is still a body a client reads.
         *
         * Bulk answers per row, so one row's failure is reported inside a
         * successful response rather than thrown — and that put `err.message`
         * in the client's hands with none of the care the problem bodies get.
         * Every transition here writes to Postgres, so what a refused row
         * actually produced was the driver's wording, its constraint name and
         * (in `err.detail`) the values it rejected. `errorBodyDisclosure.test`
         * scans `problems.*` calls and cannot see this at all: the leak is not
         * in a problem document, it is in the ordinary shape of the answer.
         *
         * Narrowed to the two types whose messages are written to be read, the
         * same way `routes/research.ts` reports its per-topic failures. The
         * constant is not a loss: a bulk row that fails is retried as a single
         * request, which answers with the real problem document.
         */
        app.log.warn({ err, valuationId: id }, 'bulk transition failed for one row');
        results.push({
          id,
          ok: false,
          error:
            err instanceof ApiProblem
              ? err.message
              : err instanceof InternalServiceError
                ? // R277: the narrowing above was right about `ApiProblem`, whose
                  // message *is* its authored `detail`, and half right about this
                  // one. An `InternalServiceError`'s message is the upstream's
                  // raw body whenever `opaque` is set — which is the case that
                  // flag was added for — so it gets the same composition
                  // `toProblem` would have given it.
                  describeForUser(err)
                : 'This engagement could not be updated.',
        });
      }
    }
    return {
      results,
      succeeded: results.filter((r) => r.ok).length,
      failed: results.filter((r) => !r.ok).length,
    };
  };

  app.post('/api/v1/valuations/bulk', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    requireOps(principal);
    const parsed = BulkBody.safeParse(req.body);
    if (!parsed.success) throw invalidBody('Invalid bulk action', parsed.error);
    return executeBulk(principal, { ...parsed.data, ids: dedupeIds(parsed.data.ids) });
  });

  app.post('/api/v1/valuations/bulk-action', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    requireOps(principal);
    const parsed = BulkActionBody.safeParse(req.body);
    if (!parsed.success) throw invalidBody('Invalid bulk action', parsed.error);
    return executeBulk(principal, toBulkInput(parsed.data));
  });
}
