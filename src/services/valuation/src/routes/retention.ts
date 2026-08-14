import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { isUlid, problems } from '@n409/shared';
import { canManageUsers } from '../auth/rbac.js';
import { requirePrincipal } from '../plugins/auth.js';
import { findValuationById } from '../repos/valuations.js';
import { findUserById } from '../repos/users.js';
import { RETENTION_DATA_TYPES } from '../domain/retention.js';
import {
  findArchivableValuations,
  HOLD_PAGE_LIMIT,
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
export async function runRetentionSweep(pool: pg.Pool, opts: { limit?: number } = {}): Promise<SweepResult> {
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
      throw problems.unprocessable('Invalid query', { errors: parsedQuery.error.issues });
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

  // Manual sweep trigger (admins), in addition to the scheduled run.
  app.post('/api/v1/admin/retention/run', { preHandler: app.authenticate }, async (req) => {
    requireAdmin(req);
    return { result: await runRetentionSweep(deps.pool) };
  });
}
