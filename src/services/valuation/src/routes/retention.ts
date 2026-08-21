import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { isUlid, problems } from '@n409/shared';
import { canManageUsers } from '../auth/rbac.js';
import { requirePrincipal } from '../plugins/auth.js';
import { findValuationById } from '../repos/valuations.js';
import { findUserById } from '../repos/users.js';
import { isDueForArchival, RETENTION_DATA_TYPES } from '../domain/retention.js';
import { restoreValuations, retireValuations } from '../repos/valuationPurge.js';
import { firePartnerWebhooksForRetirement } from '../hooks/partnerWebhooks.js';
import {
  findArchivableValuations,
  HOLD_PAGE_LIMIT,
  isValuationFrozen,
  listActions,
  listHolds,
  listPolicies,
  markValuationsArchived,
  placeHold,
  recordActions,
  releaseHold,
  upsertPolicy,
} from '../repos/retention.js';

/**
 * Data retention + legal hold administration (feature 10). Admin-only. The
 * automated archival sweep (runRetentionSweep) archives records past their
 * policy's age unless a legal hold freezes them, and records every action.
 */

const PolicyBody = z.object({
  archive_after_days: z.number().int().min(1).max(36500).nullable(),
  retention_days: z.number().int().min(1).max(36500).nullable(),
  enabled: z.boolean(),
});
const HoldBody = z.object({
  scope: z.enum(['global', 'valuation', 'user']),
  reference_id: z.string().nullable().optional(),
  reason: z.string().trim().min(1).max(1000),
});

/**
 * Resolve the aggregate a non-global hold names, refusing anything that does
 * not exist.
 *
 * A hold is the control that stops a sweep deleting evidence someone is under a
 * legal obligation to keep, and `legal_holds.reference_id` carries no foreign
 * key — it cannot, because the column is polymorphic over valuations and users.
 * So nothing downstream ever notices a bad reference: `findArchivableValuations`
 * compares it against `v.id`/`v.user_id`, no row matches, and the sweep archives
 * the very records the hold was placed to freeze. The admin saw a 201 and a hold
 * listed as active. A typo'd id has to fail here, where someone is looking, and
 * not months later in a sweep nobody is.
 *
 * The malformed case was louder and no better: `reference_id` is the `ulid`
 * domain, so a non-ULID string reached Postgres and came back a 500 — the
 * generic one, with nothing said about which field was wrong.
 */
async function assertHoldTarget(
  pool: pg.Pool,
  scope: 'valuation' | 'user',
  referenceId: string,
): Promise<void> {
  if (!isUlid(referenceId)) {
    throw problems.unprocessable(`reference_id is not a valid id for a ${scope} hold`);
  }
  const found =
    scope === 'valuation'
      ? await findValuationById(pool, referenceId)
      : await findUserById(pool, referenceId);
  if (!found) throw problems.unprocessable(`No ${scope} exists with that reference_id`);
}

export interface SweepResult {
  archived: number;
  skipped_hold: number;
}

/**
 * Run the archival sweep once: the 'valuation' policy archives valuations past
 * its archive_after_days, skipping any under legal hold. Every decision is
 * logged to retention_actions. Extend here for additional data types.
 */
export async function runRetentionSweep(
  pool: pg.Pool,
  opts: { limit?: number; log?: FastifyBaseLogger } = {},
): Promise<SweepResult> {
  const result: SweepResult = { archived: 0, skipped_hold: 0 };
  const policies = await listPolicies(pool);
  const valPolicy = policies.find((p) => p.data_type === 'valuation');
  if (!valPolicy || !valPolicy.enabled || valPolicy.archive_after_days === null) return result;

  const candidates = await findArchivableValuations(pool, valPolicy.archive_after_days, opts.limit ?? 500);
  const frozen = candidates.filter((c) => c.frozen);

  // Two statements for the whole pass, not two per candidate. `findArchivable
  // Valuations` returns up to 500 rows with the hold flag already computed, and
  // the old loop spent an UPDATE and an INSERT on each of them in turn — a
  // sweep that archived a full batch cost around a thousand sequential round
  // trips, all of them to say the same two things.
  const archived = await markValuationsArchived(
    pool,
    candidates.filter((c) => !c.frozen).map((c) => c.id),
  );

  // Logged after the archival rather than beside it, so the log records what
  // the UPDATE actually did. A candidate a concurrent sweep archived first is
  // absent from `archived` and therefore neither counted nor logged here.
  await recordActions(pool, [
    ...frozen.map((c) => ({
      dataType: 'valuation',
      action: 'skipped_hold' as const,
      referenceId: c.id,
    })),
    ...archived.map((id) => ({
      dataType: 'valuation',
      action: 'archived' as const,
      referenceId: id,
      detail: { archive_after_days: valPolicy.archive_after_days },
    })),
  ]);

  // After the log, and never allowed to fail the sweep: `firePartnerWebhooks`
  // swallows and logs a dispatch failure per webhook, and the batch shape is
  // what keeps this to one query rather than one per archived row.
  await firePartnerWebhooksForRetirement({ pool, log: opts.log }, archived);

  result.archived = archived.length;
  result.skipped_hold = frozen.length;
  return result;
}

export function registerRetentionRoutes(app: FastifyInstance, deps: { pool: pg.Pool }): void {
  const requireAdmin = (req: Parameters<typeof requirePrincipal>[0]) => {
    const principal = requirePrincipal(req);
    if (!canManageUsers(principal)) throw problems.forbidden('Retention settings are admin-only');
    return principal;
  };

  app.get('/api/v1/admin/retention/policies', { preHandler: app.authenticate }, async (req) => {
    requireAdmin(req);
    return { policies: await listPolicies(deps.pool) };
  });

  app.put('/api/v1/admin/retention/policies/:dataType', { preHandler: app.authenticate }, async (req) => {
    const principal = requireAdmin(req);
    const { dataType } = req.params as { dataType: string };
    if (!(RETENTION_DATA_TYPES as readonly string[]).includes(dataType)) throw problems.notFound();
    const parsed = PolicyBody.safeParse(req.body);
    if (!parsed.success) throw problems.unprocessable('Invalid policy', { errors: parsed.error.issues });
    const policy = await upsertPolicy(deps.pool, {
      dataType,
      archiveAfterDays: parsed.data.archive_after_days,
      retentionDays: parsed.data.retention_days,
      enabled: parsed.data.enabled,
      updatedBy: principal.id,
    });
    return { policy };
  });

  app.get('/api/v1/admin/retention/holds', { preHandler: app.authenticate }, async (req) => {
    requireAdmin(req);
    const parsedQuery = z
      .object({
        limit: z.coerce.number().int().min(1).max(HOLD_PAGE_LIMIT).default(HOLD_PAGE_LIMIT),
      })
      .safeParse(req.query ?? {});
    if (!parsedQuery.success) {
      throw problems.badRequest('Invalid query', { errors: parsedQuery.error.issues });
    }
    const { holds, truncated } = await listHolds(deps.pool, { limit: parsedQuery.data.limit });
    return { holds, truncated, page_limit: HOLD_PAGE_LIMIT };
  });

  app.post('/api/v1/admin/retention/holds', { preHandler: app.authenticate }, async (req, reply) => {
    const principal = requireAdmin(req);
    const parsed = HoldBody.safeParse(req.body);
    if (!parsed.success) throw problems.unprocessable('Invalid hold', { errors: parsed.error.issues });
    if (parsed.data.scope !== 'global' && !parsed.data.reference_id) {
      throw problems.unprocessable('A valuation/user hold needs a reference_id');
    }
    if (parsed.data.scope !== 'global') {
      await assertHoldTarget(deps.pool, parsed.data.scope, parsed.data.reference_id!);
    }
    const hold = await placeHold(deps.pool, {
      scope: parsed.data.scope,
      referenceId: parsed.data.scope === 'global' ? null : (parsed.data.reference_id ?? null),
      reason: parsed.data.reason,
      placedBy: principal.id,
    });
    return reply.status(201).send({ hold });
  });

  app.post('/api/v1/admin/retention/holds/:id/release', { preHandler: app.authenticate }, async (req) => {
    const principal = requireAdmin(req);
    const { id } = req.params as { id: string };
    if (!(await releaseHold(deps.pool, id, principal.id))) throw problems.notFound();
    return { released: true };
  });

  app.get('/api/v1/admin/retention/actions', { preHandler: app.authenticate }, async (req) => {
    requireAdmin(req);
    return { actions: await listActions(deps.pool) };
  });

  /**
   * Withdraw an engagement from the product.
   *
   * THE GAP THIS CLOSES IS AN ODD ONE: the whole retirement guard family was
   * built for an action that did not exist. Four rounds of comments say
   * `archived_at` is stamped "by the retention sweep when a policy period runs
   * out, and by `retireValuations` when a firm withdraws a piece of work" —
   * and `retireValuations` had exactly one caller, the sample seeder. So the
   * 86 guarded writes, the partner API's three, the auditor portal's refusal to
   * re-share and the board flow's refusal to re-mint were all reachable only by
   * waiting out a retention policy. An admin who needed to withdraw a live
   * engagement today had no way to do it at all.
   *
   * IT RECORDS `archived`, not a new action name. That is the same thing the
   * sweep does to the same column, and keeping one name means the restore
   * control offers itself against a manual retirement without knowing there is
   * such a thing. `manual: true` in the detail is what separates them for
   * anyone reading the log, and `reason` is what the sweep can never supply.
   *
   * THE RENAME COMES WITH IT. `retireValuations` appends ` [retired]` so the
   * company name is free for a re-run, and this route shares that path rather
   * than forking it: the suffix reads as what the row is, `restoreValuations`
   * takes it off again, and a second retirement cannot double it. Named in the
   * response because an admin who did not expect the company name to change
   * should find out from the answer and not from a support ticket.
   */
  const RetireBody = z.object({ reason: z.string().trim().min(1).max(1000).optional() });

  app.post('/api/v1/admin/retention/valuations/:id/retire', { preHandler: app.authenticate }, async (req) => {
    const principal = requireAdmin(req);
    const { id } = req.params as { id: string };
    if (!isUlid(id)) throw problems.notFound();
    const parsed = RetireBody.safeParse(req.body ?? {});
    if (!parsed.success) throw problems.unprocessable('Invalid body', { errors: parsed.error.issues });

    const valuation = await findValuationById(deps.pool, id);
    if (!valuation) throw problems.notFound();
    if (valuation.archived_at !== null) {
      throw problems.conflict('This engagement is already retired.');
    }

    const result = await retireValuations(deps.pool, [id]);
    // Empty means a concurrent retire won the UPDATE. The engagement is
    // withdrawn either way, which is what the caller asked for, so this
    // reports rather than raises — and does not log an archival it did not do.
    const retired = result.retired.includes(id);
    if (retired) {
      await recordActions(deps.pool, [
        {
          dataType: 'valuation',
          action: 'archived',
          referenceId: id,
          detail: { manual: true, retired_by: principal.id, reason: parsed.data.reason ?? null },
        },
      ]);
      // A partner integration otherwise finds out by a 409 on its next write,
      // or never. `valuation.retired` is the only terminal event on that API
      // and this is one of the two things that produces it.
      await firePartnerWebhooksForRetirement({ pool: deps.pool, log: app.log }, [id]);
    }
    return { retired, valuation: await findValuationById(deps.pool, id) };
  });

  /**
   * Put an archived valuation back in the product.
   *
   * THE GAP THIS CLOSES. `archived_at` is the platform's soft delete and
   * nothing ever cleared it. Two things set it — this sweep, and
   * `retireValuations` when a firm withdraws work — and R89 then made every
   * one of the 86 writes under a valuation id refuse a stamped row. That was
   * the right call and it turned a tidiness problem into a real one: an
   * engagement archived by a mistyped id, or by a policy an admin set to 90
   * days meaning 900, was permanently frozen with no way back through the
   * product. Users have `restoreUser`; partners have their own unarchive; the
   * aggregate holding a client's actual work had neither.
   *
   * WHY IT LIVES ON THE RETENTION SURFACE. This is where valuations get
   * archived in-product and where the action log that records it is read, so
   * the undo belongs next to the log entry it undoes rather than on the
   * engagement page — which is also the honest place for it, because it is an
   * admin action and not something the firm doing the work can do to itself.
   *
   * WHY IT CAN REFUSE. A restore whose only effect is to be undone by tonight's
   * sweep is worse than no restore: the admin sees a 200, the engagement comes
   * back, and it is gone again by morning with nothing to say why. So the same
   * two questions the sweep asks are asked here first — is it past the policy's
   * cutoff, and is a legal hold freezing it — and if the sweep would take it
   * straight back, this refuses and names the two things that would actually
   * hold it: widen the policy, or place a hold. `acknowledge_rearchival` is
   * there because "restore it anyway, I know" is a legitimate thing to want —
   * exporting a file before it goes again — and choosing that for the operator
   * is not this route's job. What is its job is that they cannot choose it by
   * accident.
   */
  const RestoreBody = z.object({ acknowledge_rearchival: z.boolean().optional() });

  app.post(
    '/api/v1/admin/retention/valuations/:id/restore',
    { preHandler: app.authenticate },
    async (req) => {
      const principal = requireAdmin(req);
      const { id } = req.params as { id: string };
      if (!isUlid(id)) throw problems.notFound();
      const parsed = RestoreBody.safeParse(req.body ?? {});
      if (!parsed.success) throw problems.unprocessable('Invalid body', { errors: parsed.error.issues });

      const valuation = await findValuationById(deps.pool, id);
      if (!valuation) throw problems.notFound();
      // Deliberately not a 404: the caller is looking at a real engagement and
      // the reason there is nothing to do is its state. Same reasoning as
      // `refuseIfRetired`, pointed the other way.
      if (valuation.archived_at === null) {
        throw problems.conflict('This engagement is not archived — there is nothing to restore.');
      }

      if (parsed.data.acknowledge_rearchival !== true) {
        const policy = (await listPolicies(deps.pool)).find((p) => p.data_type === 'valuation');
        const due = policy ? isDueForArchival(policy, valuation.created_at, new Date()) : false;
        // The hold check is second because it is the one that costs a query,
        // and it only matters when the policy would otherwise take the row.
        if (due && !(await isValuationFrozen(deps.pool, { valuationId: id, userId: valuation.user_id }))) {
          throw problems.conflict(
            `The retention policy archives valuations after ${policy!.archive_after_days} days and this ` +
              'one is older than that, so the next sweep would archive it again. Widen the policy or ' +
              'place a legal hold on it first, or resend with acknowledge_rearchival to restore it ' +
              'anyway.',
          );
        }
      }

      const result = await restoreValuations(deps.pool, [id]);
      // `restored` empty means a concurrent restore won the UPDATE. Nothing was
      // wrong with the request and the engagement is live, which is what the
      // caller wanted — so this reports the outcome rather than raising.
      const restored = result.restored.includes(id);
      if (restored) {
        await recordActions(deps.pool, [
          {
            dataType: 'valuation',
            action: 'restored',
            referenceId: id,
            detail: {
              restored_by: principal.id,
              archived_at: valuation.archived_at.toISOString(),
              acknowledged_rearchival: parsed.data.acknowledge_rearchival === true,
            },
          },
        ]);
      }
      return { restored, valuation: await findValuationById(deps.pool, id) };
    },
  );

  // Manual sweep trigger (admins), in addition to the scheduled run.
  app.post('/api/v1/admin/retention/run', { preHandler: app.authenticate }, async (req) => {
    requireAdmin(req);
    return { result: await runRetentionSweep(deps.pool, { log: app.log }) };
  });
}
