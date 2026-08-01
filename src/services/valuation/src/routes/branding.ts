import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { problems } from '@n409/shared';
import { canManageBranding, canManageUsers } from '../auth/rbac.js';
import {
  BRANDING_PATCH_SCHEMA,
  brandingCssVariables,
  PLATFORM_BRANDING,
  resolveBranding,
  type Branding,
} from '../domain/branding.js';
import { findBrandingByKey, findBrandingByPartnerId, updateBranding } from '../repos/branding.js';
import { recordAdminEvent } from '../events/adminRecord.js';
import { requirePrincipal } from '../plugins/auth.js';

/**
 * White-label branding (migration 0091).
 *
 * Three surfaces, one resolver:
 *  - `/public/branding/:key` — the signed-out login page, before any session.
 *  - `/branding` — the signed-in SPA, resolved from the caller's own tenant.
 *  - `PATCH /branding` — the firm administering its own identity.
 *
 * Every response is a fully-resolved `Branding`, never the raw row: clients
 * must not be reimplementing the fallback chain, because three clients
 * reimplementing it is three subtly different brands.
 */
export function registerBrandingRoutes(app: FastifyInstance, deps: { pool: pg.Pool }): void {
  /**
   * The resolved brand plus the CSS ramp for both theme modes. The client
   * applies `css` verbatim — no colour maths in the browser, so a tenant's
   * accent cannot come out one shade in the app and another in the report.
   */
  const respond = (branding: Branding) => ({
    branding,
    css: {
      light: brandingCssVariables(branding, 'light'),
      dark: brandingCssVariables(branding, 'dark'),
    },
  });

  /**
   * Public by necessity — a firm's login page is branded before anyone has
   * signed in. Exposes only what that page renders, and nothing about who or
   * how many people are inside the tenant.
   */
  app.get('/api/v1/public/branding/:key', async (req) => {
    const { key } = req.params as { key: string };
    if (!/^[a-z0-9-]{1,100}$/.test(key)) throw problems.notFound();
    const source = await findBrandingByKey(deps.pool, key);
    if (!source) throw problems.notFound();
    return respond(resolveBranding(source));
  });

  /**
   * The signed-in tenant's brand. A principal with no partner — direct clients
   * and platform staff — gets platform branding rather than a 404, so the SPA
   * can call this unconditionally on every load.
   */
  app.get('/api/v1/branding', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    if (!principal.partnerId) return respond(PLATFORM_BRANDING);
    return respond(resolveBranding(await findBrandingByPartnerId(deps.pool, principal.partnerId)));
  });

  /**
   * The editing view: the stored fields rather than the resolved ones, because
   * a form has to show which values are actually set versus inherited.
   */
  app.get('/api/v1/branding/settings', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    const parsed = z.object({ partner_id: z.string().optional() }).safeParse(req.query);
    if (!parsed.success) throw problems.badRequest('Invalid query');

    const partnerId = parsed.data.partner_id ?? principal.partnerId;
    if (!partnerId) throw problems.notFound('No tenant to brand');
    if (!canManageBranding(principal, partnerId))
      throw problems.forbidden('You cannot manage this tenant’s branding');

    const source = await findBrandingByPartnerId(deps.pool, partnerId);
    if (!source) throw problems.notFound();
    return {
      settings: source,
      preview: resolveBranding({ ...source, white_label_enabled: true }),
      defaults: PLATFORM_BRANDING,
    };
  });

  app.patch('/api/v1/branding', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    const query = z.object({ partner_id: z.string().optional() }).safeParse(req.query);
    if (!query.success) throw problems.badRequest('Invalid query');

    // Ops act on a named tenant; a firm administrator acts on their own and may
    // not name one at all — passing someone else's id is a 403, not a silent
    // rewrite to their own.
    const partnerId = query.data.partner_id ?? principal.partnerId;
    if (!partnerId) throw problems.notFound('No tenant to brand');
    if (!canManageBranding(principal, partnerId))
      throw problems.forbidden('You cannot manage this tenant’s branding');

    const parsed = BRANDING_PATCH_SCHEMA.safeParse(req.body);
    if (!parsed.success) throw problems.unprocessable('Invalid branding', { errors: parsed.error.issues });
    if (Object.keys(parsed.data).length === 0) throw problems.unprocessable('No branding to update');

    const source = await updateBranding(deps.pool, partnerId, parsed.data);
    if (!source) throw problems.notFound();

    await recordAdminEvent(deps.pool, {
      type: 'branding_updated',
      actor: { actorType: 'human', actorId: principal.id },
      subjectType: 'partner',
      subjectId: partnerId,
      subjectLabel: source.brand_name ?? source.name,
      payload: {
        fields: Object.keys(parsed.data),
        white_label_enabled: source.white_label_enabled,
        // Branding changes what every client of this firm sees, so the audit
        // trail carries the values, not just the field names.
        applied: parsed.data,
      },
    });

    return { settings: source, branding: resolveBranding(source) };
  });

  /** Ops-only: which tenants have taken their brand live. */
  app.get('/api/v1/branding/tenants', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    if (!canManageUsers(principal)) throw problems.forbidden();
    const { rows } = await deps.pool.query<{ id: string; name: string; key: string; enabled: boolean }>(
      `SELECT id, coalesce(brand_name, name) AS name, key, white_label_enabled AS enabled
         FROM partners WHERE archived_at IS NULL ORDER BY white_label_enabled DESC, name ASC`,
    );
    return { tenants: rows };
  });
}
