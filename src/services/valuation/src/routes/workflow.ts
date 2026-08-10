import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { isUlid, problems } from '@n409/shared';
import { isOps, type Principal } from '../auth/rbac.js';
import { VALUATION_STATES, type ValuationState } from '../domain/valuation.js';
import { BULK_ACTIONS, canRestart, canTransition, nextState, RESTART_STATE } from '../domain/workflow.js';
import { findValuationById, patchValuation, type ValuationRow } from '../repos/valuations.js';
import { findUserById } from '../repos/users.js';
import { onStateChanged, type EmailTransport } from '../hooks/stateChange.js';
import { assertPublishGate } from '../domain/publishGate.js';
import { requirePrincipal } from '../plugins/auth.js';
import type { EventActor } from '../events/record.js';

/**
 * Workflow engine routes (M4, P1 #22) + bulk actions (P1 #23). All mutations
 * go through patchValuation so the audit spine records them; the state-change
 * hook then fires the auto email workflows / notifications.
 */

const ReassignBody = z.object({ reviewer_id: z.string().nullable() });

const BulkBody = z.object({
  ids: z.array(z.string()).min(1).max(200),
  action: z.enum(BULK_ACTIONS),
  state: z.enum(VALUATION_STATES).optional(),
  reviewer_id: z.string().nullable().optional(),
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
      reviewer_id: z.string().nullable().optional(),
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

export interface WorkflowDeps {
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

export function registerWorkflowRoutes(app: FastifyInstance, deps: WorkflowDeps): void {
  const applyState = async (
    valuation: ValuationRow,
    to: ValuationState,
    principal: Principal,
    source: string,
  ): Promise<ValuationRow> => {
    await assertPublishGate(deps.pool, valuation.id, to);
    const updated = await patchValuation(deps.pool, valuation, { state: to }, actorFor(principal, source));
    await onStateChanged({ pool: deps.pool, transport: deps.transport, log: app.log }, updated, to);
    return updated;
  };

  app.post('/api/v1/valuations/:id/workflow/advance', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    requireOps(principal);
    const { id } = req.params as { id: string };
    const valuation = await loadValuation(deps.pool, id);

    const next = nextState(valuation.state, { paidStatus: valuation.paid_status });
    if (!next) {
      throw problems.conflict(`Cannot auto-advance from '${valuation.state}'`);
    }
    return { valuation: await applyState(valuation, next, principal, 'workflow') };
  });

  app.post('/api/v1/valuations/:id/workflow/restart', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    requireOps(principal);
    const { id } = req.params as { id: string };
    const valuation = await loadValuation(deps.pool, id);

    if (!canRestart(valuation.state)) {
      throw problems.conflict(`Cannot restart from '${valuation.state}'`);
    }
    return { valuation: await applyState(valuation, RESTART_STATE, principal, 'workflow') };
  });

  app.post('/api/v1/valuations/:id/workflow/reassign', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    requireOps(principal);
    const { id } = req.params as { id: string };
    const valuation = await loadValuation(deps.pool, id);

    const parsed = ReassignBody.safeParse(req.body);
    if (!parsed.success) throw problems.unprocessable('Invalid reassign', { errors: parsed.error.issues });
    const reviewerId = parsed.data.reviewer_id;
    if (reviewerId !== null && (!isUlid(reviewerId) || !(await findUserById(deps.pool, reviewerId)))) {
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
      if (reviewer_id !== null && (!isUlid(reviewer_id) || !(await findUserById(deps.pool, reviewer_id)))) {
        throw problems.unprocessable('Unknown reviewer', { errors: [{ path: ['reviewer_id'] }] });
      }
    }

    const results: Array<{ id: string; ok: boolean; error?: string; state?: ValuationState }> = [];
    for (const id of ids) {
      try {
        const valuation = await loadValuation(deps.pool, id);
        switch (action) {
          case 'set_state': {
            if (!canTransition(valuation.state, state!)) {
              throw problems.conflict(`Illegal transition ${valuation.state} → ${state}`);
            }
            const updated = await applyState(valuation, state!, principal, 'bulk');
            results.push({ id, ok: true, state: updated.state });
            break;
          }
          case 'advance': {
            const next = nextState(valuation.state, { paidStatus: valuation.paid_status });
            if (!next) throw problems.conflict(`Cannot auto-advance from '${valuation.state}'`);
            const updated = await applyState(valuation, next, principal, 'bulk');
            results.push({ id, ok: true, state: updated.state });
            break;
          }
          case 'restart': {
            if (!canRestart(valuation.state))
              throw problems.conflict(`Cannot restart from '${valuation.state}'`);
            const updated = await applyState(valuation, RESTART_STATE, principal, 'bulk');
            results.push({ id, ok: true, state: updated.state });
            break;
          }
          case 'assign_reviewer': {
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
        results.push({
          id,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
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
    if (!parsed.success) throw problems.unprocessable('Invalid bulk action', { errors: parsed.error.issues });
    return executeBulk(principal, { ...parsed.data, ids: dedupeIds(parsed.data.ids) });
  });

  app.post('/api/v1/valuations/bulk-action', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    requireOps(principal);
    const parsed = BulkActionBody.safeParse(req.body);
    if (!parsed.success) throw problems.unprocessable('Invalid bulk action', { errors: parsed.error.issues });
    return executeBulk(principal, toBulkInput(parsed.data));
  });
}
