import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { findUserByEmail, findUserById, createProvisionedUser, setUserActive } from '../repos/users.js';
import { getSamlConfig, verifyScimToken } from '../repos/ssoConfig.js';
import type { RoleKey } from '../domain/roles.js';
import { ROLE_KEYS } from '../domain/roles.js';
import {
  activeFromPatch,
  parseScimUser,
  parseUserNameFilter,
  scimError,
  scimList,
  toScimUser,
  type ScimUserRow,
} from '../domain/scim.js';

/**
 * SCIM 2.0 user provisioning endpoint (feature 9). An IdP (Okta / Azure AD /
 * OneLogin) authenticates with a SCIM bearer token (scim_tokens) and manages
 * users under /scim/v2/Users. Deactivation is a soft delete; reactivation
 * clears it. Only the User resource is supported (no Groups).
 */
export function registerScimRoutes(app: FastifyInstance, deps: { pool: pg.Pool }): void {
  const CT = 'application/scim+json';

  const requireToken = async (req: FastifyRequest, reply: FastifyReply): Promise<boolean> => {
    const header = req.headers.authorization;
    const token = typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token || !(await verifyScimToken(deps.pool, token))) {
      void reply.status(401).header('content-type', CT).send(scimError(401, 'Invalid SCIM token'));
      return false;
    }
    return true;
  };

  const defaultRole = async (): Promise<RoleKey> => {
    const config = await getSamlConfig(deps.pool);
    const role = config?.default_role ?? 'valuation_user';
    return (ROLE_KEYS as readonly string[]).includes(role) ? (role as RoleKey) : 'valuation_user';
  };

  app.get('/scim/v2/ServiceProviderConfig', async (_req, reply) =>
    reply.header('content-type', CT).send({
      schemas: ['urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig'],
      patch: { supported: true },
      filter: { supported: true, maxResults: 200 },
      bulk: { supported: false },
      changePassword: { supported: false },
      sort: { supported: false },
      authenticationSchemes: [{ name: 'OAuth Bearer Token', type: 'oauthbearertoken' }],
    }),
  );

  app.get('/scim/v2/Users', async (req, reply) => {
    if (!(await requireToken(req, reply))) return;
    const filter = parseUserNameFilter((req.query as { filter?: string }).filter);
    if (filter) {
      const user = await findUserByEmail(deps.pool, filter);
      return reply
        .header('content-type', CT)
        .send(scimList(user ? [toScimUser(user as unknown as ScimUserRow)] : []));
    }
    const { rows } = await deps.pool.query<ScimUserRow>(
      `SELECT id, email, first_name, last_name, scim_external_id, deleted_at, created_at
         FROM users WHERE provisioned_by = 'scim' ORDER BY created_at DESC LIMIT 200`,
    );
    return reply.header('content-type', CT).send(scimList(rows.map(toScimUser)));
  });

  app.get('/scim/v2/Users/:id', async (req, reply) => {
    if (!(await requireToken(req, reply))) return;
    const { id } = req.params as { id: string };
    const user = await findUserById(deps.pool, id);
    if (!user) return reply.status(404).header('content-type', CT).send(scimError(404, 'User not found'));
    return reply.header('content-type', CT).send(toScimUser(user as unknown as ScimUserRow));
  });

  app.post('/scim/v2/Users', async (req, reply) => {
    if (!(await requireToken(req, reply))) return;
    const parsed = parseScimUser(req.body);
    if (!parsed) return reply.status(400).header('content-type', CT).send(scimError(400, 'A userName / email is required'));

    const existing = await findUserByEmail(deps.pool, parsed.email);
    if (existing) {
      return reply.status(409).header('content-type', CT).send(scimError(409, 'User already exists'));
    }
    const user = await createProvisionedUser(deps.pool, {
      email: parsed.email,
      firstName: parsed.firstName,
      lastName: parsed.lastName,
      provisionedBy: 'scim',
      externalId: parsed.externalId,
      roles: [await defaultRole()],
    });
    if (!parsed.active) await setUserActive(deps.pool, user.id, false);
    return reply
      .status(201)
      .header('content-type', CT)
      .send(toScimUser({ ...(user as unknown as ScimUserRow), deleted_at: parsed.active ? null : new Date() }));
  });

  // PATCH — the common path is toggling `active` (deprovision / reactivate).
  app.patch('/scim/v2/Users/:id', async (req, reply) => {
    if (!(await requireToken(req, reply))) return;
    const { id } = req.params as { id: string };
    const user = await findUserById(deps.pool, id);
    if (!user) return reply.status(404).header('content-type', CT).send(scimError(404, 'User not found'));
    const active = activeFromPatch(req.body);
    if (active !== undefined) await setUserActive(deps.pool, id, active);
    const refreshed = await findUserById(deps.pool, id);
    return reply.header('content-type', CT).send(toScimUser(refreshed as unknown as ScimUserRow));
  });

  // DELETE — SCIM deprovision. Soft delete so history + audit trail survive.
  app.delete('/scim/v2/Users/:id', async (req, reply) => {
    if (!(await requireToken(req, reply))) return;
    const { id } = req.params as { id: string };
    const user = await findUserById(deps.pool, id);
    if (!user) return reply.status(404).header('content-type', CT).send(scimError(404, 'User not found'));
    await setUserActive(deps.pool, id, false);
    return reply.status(204).send();
  });
}
