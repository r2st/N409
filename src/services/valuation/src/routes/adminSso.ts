import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { httpsUrl } from '../domain/externalUrl.js';
import { problems } from '@n409/shared';
import { canManageUsers } from '../auth/rbac.js';
import { verifyReauthPassword } from '../auth/reauth.js';
import { findUserById } from '../repos/users.js';
import { requirePrincipal } from '../plugins/auth.js';
import { recordAdminEvent } from '../events/adminRecord.js';
import { ROLE_KEYS } from '../domain/roles.js';
import {
  createScimToken,
  getSamlConfig,
  listScimTokens,
  revokeScimToken,
  SCIM_TOKEN_PAGE_LIMIT,
  upsertSamlConfig,
} from '../repos/ssoConfig.js';
import { invalidBody, invalidQuery } from '../domain/validationProblem.js';

/**
 * Admin SSO configuration (feature 9): SAML IdP settings + SCIM token
 * management. Admin-only (canManageUsers). SAML/SCIM secrets are write-only
 * from the client's perspective — the IdP cert is returned so an admin can
 * confirm it, but SCIM token values are shown only once at creation.
 *
 * Every write here is audited (R159), and none was. These are the highest-
 * leverage writes in the schema: `saml_config` decides which identity provider
 * every future sign-in is delegated to, so repointing it at another IdP hands
 * that IdP the ability to assert any employee's address and be believed — and
 * the JIT provisioning on the other side will mint the account. A SCIM token
 * is a standing bearer grant to create and deactivate users. Both were
 * changeable by an administrator with the trail recording nothing, while the
 * same administrator editing a *report template* left a `template_updated`
 * row. The event carries which fields moved, never their values: `idp_cert` is
 * a certificate and `allowed_domain` is configuration, but a payload of
 * before/after config is not what the trail is for.
 */

/**
 * The label an administrator files a SCIM token under.
 *
 * This route was the one mutation in the service that read `req.body` by cast
 * instead of through a schema, and it did the two things a schema exists to
 * stop. It accepted whatever else was in the object — every other body here is
 * `.strict()`, so a misspelt field is a 422 rather than a silently ignored
 * one — and it *truncated* an over-long label with `.slice(0, 200)` where the
 * rest of the estate refuses it, which turns a caller's mistake into a row
 * they did not ask for and cannot tell apart from the one they wanted.
 *
 * `.slice` was also the wrong cut. Two hundred UTF-16 units can land inside an
 * astral character, and the half that survives is a string UTF-8 cannot encode
 * — the `jsonb` payload of the `scim_token_created` event below would refuse
 * it and take the whole request to a 500 (domain/textSlice.ts). Refusing at
 * `max(200)` means the cut never happens.
 */
const ScimTokenBody = z
  .object({
    label: z.string().trim().min(1).max(200).nullish(),
    /** The re-authentication prompt — see the mint route for why it is here. */
    current_password: z.string().min(1).optional(),
  })
  .strict();

const SamlBody = z.object({
  enabled: z.boolean(),
  /** The re-authentication prompt — see the PUT route for why it is here. */
  current_password: z.string().min(1).optional(),
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

  /**
   * Point the platform's sign-in at an identity provider.
   *
   * Behind the same two guards as the SCIM mint below, and for the reason
   * already written at the top of this file: this row "decides which identity
   * provider every future sign-in is delegated to, so repointing it at another
   * IdP hands that IdP the ability to assert any employee's address and be
   * believed — and the JIT provisioning on the other side will mint the
   * account." That is not a configuration change with a security consequence;
   * it is the issuing of a credential, one PUT wide, over every account in the
   * tenant at once. It is only spelled differently from a mint.
   *
   * So: not from an API token — a leaked key must not be able to arrange its
   * own way back in after being revoked — and not without the caller's own
   * password, because a borrowed administrator session is exactly the case
   * `auth/reauth.ts` exists for. Skipped when the account has no digest, as
   * every other prompt on this platform skips it.
   */
  app.put('/api/v1/admin/sso/saml', { preHandler: app.authenticate }, async (req) => {
    const principal = requireAdmin(req);
    if (req.apiToken)
      throw problems.forbidden(
        'An API token cannot change the identity provider — do it from the SSO settings page while signed in',
      );
    const parsed = SamlBody.safeParse(req.body);
    if (!parsed.success) throw invalidBody('Invalid SAML config', parsed.error);
    if (parsed.data.enabled && (!parsed.data.idp_sso_url || !parsed.data.idp_cert)) {
      throw problems.unprocessable('An IdP SSO URL and signing certificate are required to enable SAML');
    }

    const self = await findUserById(deps.pool, principal.id);
    if (!self) throw problems.unauthorized();
    if (self.password_digest) {
      if (!parsed.data.current_password)
        throw problems.unprocessable('Your current password is required to change the identity provider', {
          errors: [{ path: ['current_password'] }],
        });
      if (!(await verifyReauthPassword(self.id, parsed.data.current_password, self.password_digest)))
        throw problems.badRequest('Current password is incorrect');
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
    await recordAdminEvent(deps.pool, {
      type: 'sso_config_updated',
      actor: { actorType: 'human', actorId: principal.id },
      subjectType: 'sso_config',
      subjectId: null,
      subjectLabel: 'saml',
      payload: {
        enabled: config.enabled,
        fields: Object.keys(parsed.data),
        allowed_domain: config.allowed_domain,
        default_role: config.default_role,
      },
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
      throw invalidQuery(parsedQuery.error);
    }
    const { tokens, truncated } = await listScimTokens(deps.pool, { limit: parsedQuery.data.limit });
    return { tokens, truncated, page_limit: SCIM_TOKEN_PAGE_LIMIT };
  });

  /**
   * Mint a SCIM bearer token.
   *
   * Behind the same two guards every other credential mint on this platform
   * carries, and it had neither — while `POST /me/tokens`, which issues a
   * credential that can do strictly less than this one, has carried both since
   * R262. The docstring at the top of this file already said why they belong
   * here: a SCIM token "is a standing bearer grant to create and deactivate
   * users", and it has no session and no principal, so none of the route
   * sweeps that scope this estate apply to what it does with that grant.
   *
   * *No key mints its successor.* An API token acting as an administrator could
   * issue a SCIM bearer, and revoking the leaked key would then end nothing:
   * SCIM tokens have their own revocation and are unaffected by anything that
   * ends a session or withdraws an API key.
   *
   * *Re-authenticated*, for the reason `auth/reauth.ts` states — the session
   * may not be the owner's, and a borrowed administrator cookie should not be
   * able to leave behind a credential that outlives the password change made
   * on noticing. Skipped when the account has no digest, exactly as the other
   * mints skip it; for those the `req.apiToken` refusal above is the guard.
   */
  app.post('/api/v1/admin/sso/scim-tokens', { preHandler: app.authenticate }, async (req, reply) => {
    const principal = requireAdmin(req);
    if (req.apiToken)
      throw problems.forbidden(
        'An API token cannot mint a SCIM token — create it from the SSO settings page while signed in',
      );
    const parsed = ScimTokenBody.safeParse(req.body ?? {});
    if (!parsed.success) throw invalidBody('Invalid SCIM token', parsed.error);

    const self = await findUserById(deps.pool, principal.id);
    if (!self) throw problems.unauthorized();
    if (self.password_digest) {
      if (!parsed.data.current_password)
        throw problems.unprocessable('Your current password is required to create a SCIM token', {
          errors: [{ path: ['current_password'] }],
        });
      if (!(await verifyReauthPassword(self.id, parsed.data.current_password, self.password_digest)))
        throw problems.badRequest('Current password is incorrect');
    }

    const { row, token } = await createScimToken(deps.pool, {
      label: parsed.data.label ?? null,
      createdBy: principal.id,
    });
    const { token_hash: _t, ...safe } = row;
    await recordAdminEvent(deps.pool, {
      type: 'scim_token_created',
      actor: { actorType: 'human', actorId: principal.id },
      subjectType: 'scim_token',
      subjectId: row.id,
      subjectLabel: row.label,
    });
    // The raw token is returned once and never again.
    return reply.status(201).send({ token: safe, secret: token });
  });

  app.delete('/api/v1/admin/sso/scim-tokens/:id', { preHandler: app.authenticate }, async (req, reply) => {
    const principal = requireAdmin(req);
    const { id } = req.params as { id: string };
    if (!(await revokeScimToken(deps.pool, id))) throw problems.notFound();
    await recordAdminEvent(deps.pool, {
      type: 'scim_token_revoked',
      actor: { actorType: 'human', actorId: principal.id },
      subjectType: 'scim_token',
      subjectId: id,
    });
    return reply.status(204).send();
  });
}
