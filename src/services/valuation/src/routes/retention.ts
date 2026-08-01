import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { problems } from '@n409/shared';
import { canManageUsers } from '../auth/rbac.js';
import { requirePrincipal } from '../plugins/auth.js';
import { RETENTION_DATA_TYPES } from '../domain/retention.js';
import {
  findArchivableValuations,
  listActions,
  listHolds,
  listPolicies,
  markValuationArchived,
  placeHold,
  recordAction,
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
  for (const c of candidates) {
    if (c.frozen) {
      await recordAction(pool, { dataType: 'valuation', action: 'skipped_hold', referenceId: c.id });
      result.skipped_hold++;
      continue;
    }
    await markValuationArchived(pool, c.id);
    await recordAction(pool, {
      dataType: 'valuation',
      action: 'archived',
      referenceId: c.id,
      detail: { archive_after_days: valPolicy.archive_after_days },
    });
    result.archived++;
  }
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
    return { holds: await listHolds(deps.pool) };
  });

  app.post('/api/v1/admin/retention/holds', { preHandler: app.authenticate }, async (req, reply) => {
    const principal = requireAdmin(req);
    const parsed = HoldBody.safeParse(req.body);
    if (!parsed.success) throw problems.unprocessable('Invalid hold', { errors: parsed.error.issues });
    if (parsed.data.scope !== 'global' && !parsed.data.reference_id) {
      throw problems.unprocessable('A valuation/user hold needs a reference_id');
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
