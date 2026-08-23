import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { httpsUrl } from '../domain/externalUrl.js';
import { problems } from '@n409/shared';
import { canManageUsers } from '../auth/rbac.js';
import { requirePrincipal } from '../plugins/auth.js';
import { ROLE_KEYS } from '../domain/roles.js';
import {
  createScimToken,
  getSamlConfig,
  listScimTokens,
  revokeScimToken,
  SCIM_TOKEN_PAGE_LIMIT,
  upsertSamlConfig,
} from '../repos/ssoConfig.js';

/**
 * Admin SSO configuration (feature 9): SAML IdP settings + SCIM token
 * management. Admin-only (canManageUsers). SAML/SCIM secrets are write-only
 * from the client's perspective — the IdP cert is returned so an admin can
 * confirm it, but SCIM token values are shown only once at creation.
 */

const SamlBody = z.object({
  enabled: z.boolean(),
  idp_entity_id: z.string().trim().max(500).nullable().optional(),
  idp_sso_url: httpsUrl(1000).nullable().optional(),
  idp_cert: z.string().trim().max(20000).nullable().optional(),
  sp_entity_id: z.string().trim().max(500).nullable().optional(),
  allowed_domain: z.string().trim().max(255).nullable().optional(),
  default_role: z.enum(ROLE_KEYS).optional(),
});

export function registerAdminSsoRoutes(app: FastifyInstance, deps: { pool: pg.Pool }): void {
  const requireAdmin = (req: Parameters<typeof requirePrincipal>[0]) => {
    const principal = requirePrincipal(req);
    if (!canManageUsers(principal)) throw problems.forbidden('SSO configuration is admin-only');
    return principal;
  };

  app.get('/api/v1/admin/sso/saml', { preHandler: app.authenticate }, async (req) => {
    requireAdmin(req);
    return { config: await getSamlConfig(deps.pool) };
  });

  app.put('/api/v1/admin/sso/saml', { preHandler: app.authenticate }, async (req) => {
    const principal = requireAdmin(req);
    const parsed = SamlBody.safeParse(req.body);
    if (!parsed.success) throw problems.unprocessable('Invalid SAML config', { errors: parsed.error.issues });
    if (parsed.data.enabled && (!parsed.data.idp_sso_url || !parsed.data.idp_cert)) {
      throw problems.unprocessable('An IdP SSO URL and signing certificate are required to enable SAML');
    }
    const config = await upsertSamlConfig(deps.pool, {
      enabled: parsed.data.enabled,
      idpEntityId: parsed.data.idp_entity_id,
      idpSsoUrl: parsed.data.idp_sso_url,
      idpCert: parsed.data.idp_cert,
      spEntityId: parsed.data.sp_entity_id,
      allowedDomain: parsed.data.allowed_domain,
      defaultRole: parsed.data.default_role,
      updatedBy: principal.id,
    });
    return { config };
  });

  app.get('/api/v1/admin/sso/scim-tokens', { preHandler: app.authenticate }, async (req) => {
    requireAdmin(req);
    const parsedQuery = z
      .object({
        limit: z.coerce.number().int().min(1).max(SCIM_TOKEN_PAGE_LIMIT).default(SCIM_TOKEN_PAGE_LIMIT),
      })
      .safeParse(req.query ?? {});
    if (!parsedQuery.success) {
      throw problems.badRequest('Invalid query', { errors: parsedQuery.error.issues });
    }
    const { tokens, truncated } = await listScimTokens(deps.pool, { limit: parsedQuery.data.limit });
    return { tokens, truncated, page_limit: SCIM_TOKEN_PAGE_LIMIT };
  });

  app.post('/api/v1/admin/sso/scim-tokens', { preHandler: app.authenticate }, async (req, reply) => {
    const principal = requireAdmin(req);
    const label = (req.body as { label?: string } | undefined)?.label;
    const { row, token } = await createScimToken(deps.pool, {
      label: typeof label === 'string' ? label.slice(0, 200) : null,
      createdBy: principal.id,
    });
    const { token_hash: _t, ...safe } = row;
    // The raw token is returned once and never again.
    return reply.status(201).send({ token: safe, secret: token });
  });

  app.delete('/api/v1/admin/sso/scim-tokens/:id', { preHandler: app.authenticate }, async (req, reply) => {
    requireAdmin(req);
    const { id } = req.params as { id: string };
    if (!(await revokeScimToken(deps.pool, id))) throw problems.notFound();
    return reply.status(204).send();
  });
}
