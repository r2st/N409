import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { problems } from '@n409/shared';
import { canManageUsers, isOps } from '../auth/rbac.js';
import { publicSubset, SYSTEM_SETTINGS_DEFAULTS, SYSTEM_SETTINGS_SCHEMA } from '../domain/systemSettings.js';
import { readSettingRows, type SystemSettingsStore } from '../repos/systemSettings.js';
import { recordAdminEvent } from '../events/adminRecord.js';
import { requirePrincipal } from '../plugins/auth.js';

/** A PUT may carry any subset of the known keys; unknown keys are rejected. */
const PatchBody = SYSTEM_SETTINGS_SCHEMA.partial().strict();

/**
 * Runtime system configuration. Reading is ops-wide (a reviewer benefits from
 * knowing maintenance mode is on); writing is restricted to user-admins, the
 * same bar as the user and partner consoles, and every write is audited.
 */
export function registerSystemSettingsRoutes(
  app: FastifyInstance,
  deps: { pool: pg.Pool; settings: SystemSettingsStore },
): void {
  /**
   * Public: the SPA needs `registration_enabled` to decide whether to offer a
   * Register link before anyone has signed in. Deliberately a strict subset.
   */
  app.get('/api/v1/public/settings', async () => ({
    settings: publicSubset(await deps.settings.read()),
  }));

  app.get('/api/v1/admin/settings', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    if (!isOps(principal)) throw problems.forbidden('System settings are operations-only');
    const [settings, rows] = await Promise.all([deps.settings.read(), readSettingRows(deps.pool)]);
    // `updated` only carries keys an admin has actually written; the rest are
    // still on their code-side default and have no provenance to show.
    const updated = Object.fromEntries(
      rows.map((r) => [r.key, { updated_at: r.updated_at, updated_by: r.updated_by }]),
    );
    return {
      settings,
      defaults: SYSTEM_SETTINGS_DEFAULTS,
      updated,
      editable: canManageUsers(principal),
    };
  });

  app.put('/api/v1/admin/settings', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    if (!canManageUsers(principal))
      throw problems.forbidden('Only administrators can change system settings');

    const parsed = PatchBody.safeParse(req.body);
    if (!parsed.success) throw problems.unprocessable('Invalid settings', { errors: parsed.error.issues });
    if (Object.keys(parsed.data).length === 0) throw problems.unprocessable('No settings to update');

    const settings = await deps.settings.write(parsed.data, principal.id);
    await recordAdminEvent(deps.pool, {
      type: 'system_settings_updated',
      actor: { actorType: 'human', actorId: principal.id },
      subjectType: 'system',
      subjectId: null,
      subjectLabel: 'System settings',
      payload: { changed: parsed.data },
    });
    return { settings };
  });
}
