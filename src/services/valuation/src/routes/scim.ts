import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { findUserByEmail, findUserById, createProvisionedUser, setUserActive } from '../repos/users.js';
import { getSamlConfig, verifyScimToken } from '../repos/ssoConfig.js';
import { FixedWindowRateLimiter } from '../plugins/rateLimit.js';
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

/**
 * Per-IP throttle for /scim/v2/*. These routes face the open internet with only
 * a bearer token in front of them, and every request costs a DB round trip to
 * verify that token — so an unlimited endpoint is both a token-guessing surface
 * and a cheap way to saturate the pool. Sized for a real IdP: a full resync of a
 * few hundred users fits comfortably inside one window.
 */
const SCIM_RATE_LIMIT = 600;
const SCIM_RATE_WINDOW_MS = 5 * 60 * 1000;

export function registerScimRoutes(
  app: FastifyInstance,
  deps: { pool: pg.Pool; limiter?: FixedWindowRateLimiter },
): void {
  const CT = 'application/scim+json';
  const limiter = deps.limiter ?? new FixedWindowRateLimiter(SCIM_RATE_LIMIT, SCIM_RATE_WINDOW_MS);

  /**
   * onRequest so the limit is charged before the token lookup — the whole point
   * is to keep a flood off the database. Replies in SCIM's own error shape so an
   * IdP surfaces something intelligible rather than a parse failure.
   */
  const rateLimit = async (req: FastifyRequest, reply: FastifyReply) => {
    const { allowed, limit, remaining, resetAt } = limiter.check(`scim:${req.ip}`);
    void reply.header('x-ratelimit-limit', limit);
    void reply.header('x-ratelimit-remaining', remaining);
    if (!allowed) {
      void reply.header('retry-after', Math.max(1, Math.ceil((resetAt - Date.now()) / 1000)));
      return reply
        .status(429)
        .header('content-type', CT)
        .send(scimError(429, 'Too many SCIM requests — slow down and retry'));
    }
  };
  /** Route options shared by every /scim/v2/* route. */
  const limited = { onRequest: rateLimit };

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

  app.get('/scim/v2/ServiceProviderConfig', limited, async (_req, reply) =>
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

  app.get('/scim/v2/Users', limited, async (req, reply) => {
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

  app.get('/scim/v2/Users/:id', limited, async (req, reply) => {
    if (!(await requireToken(req, reply))) return;
    const { id } = req.params as { id: string };
    const user = await findUserById(deps.pool, id);
    if (!user) return reply.status(404).header('content-type', CT).send(scimError(404, 'User not found'));
    return reply.header('content-type', CT).send(toScimUser(user as unknown as ScimUserRow));
  });

  app.post('/scim/v2/Users', limited, async (req, reply) => {
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
  app.patch('/scim/v2/Users/:id', limited, async (req, reply) => {
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
  app.delete('/scim/v2/Users/:id', limited, async (req, reply) => {
    if (!(await requireToken(req, reply))) return;
    const { id } = req.params as { id: string };
    const user = await findUserById(deps.pool, id);
    if (!user) return reply.status(404).header('content-type', CT).send(scimError(404, 'User not found'));
    await setUserActive(deps.pool, id, false);
    return reply.status(204).send();
  });
}
