import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { findUserByEmail, findUserById, createProvisionedUser, setUserActive } from '../repos/users.js';
import { getSamlConfig, verifyScimToken } from '../repos/ssoConfig.js';
import { FixedWindowRateLimiter } from '../plugins/rateLimit.js';
import type { RoleKey } from '../domain/roles.js';
import { ROLE_KEYS } from '../domain/roles.js';
import { recordAdminEvent } from '../events/adminRecord.js';
import {
  activeFromPatch,
  isScimRejection,
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
 *
 * ## The audit record
 *
 * These three writes create accounts and take them away, from the open
 * internet, on the strength of a bearer token — and none of them left a row.
 * The same three actions performed by an administrator in the console
 * (`adminUsers.ts`) each wrote one, so the trail covered the door a person
 * walks through and not the one a directory connector does, which is the door
 * most of the seats in a large firm come through.
 *
 * The actor is the *token*, not a user: there is no principal here. That is
 * why `verifyScimToken` returns its id rather than a boolean — a firm running
 * two directory integrations needs to know which one deprovisioned somebody,
 * and "system" cannot say.
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

  /** The id of the SCIM token that authenticated the request, or null (401 sent). */
  const requireToken = async (req: FastifyRequest, reply: FastifyReply): Promise<string | null> => {
    const header = req.headers.authorization;
    const token = typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7) : null;
    const tokenId = token ? await verifyScimToken(deps.pool, token) : null;
    if (!tokenId) {
      void reply.status(401).header('content-type', CT).send(scimError(401, 'Invalid SCIM token'));
      return null;
    }
    return tokenId;
  };

  /** The provisioning connector, as an event actor. */
  const scimActor = (tokenId: string) => ({ actorType: 'system' as const, actorId: tokenId, source: 'scim' });

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
      return reply.header('content-type', CT).send(scimList(user ? [toScimUser(user)] : []));
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
    return reply.header('content-type', CT).send(toScimUser(user));
  });

  app.post('/scim/v2/Users', limited, async (req, reply) => {
    const tokenId = await requireToken(req, reply);
    if (!tokenId) return;
    const parsed = parseScimUser(req.body);
    // The rejection carries which field is wrong and what the bound is. An IdP
    // connector surfaces `detail` verbatim to the directory admin, and "a
    // userName is required" for a 4 KB givenName sends them to the wrong field.
    if (isScimRejection(parsed))
      return reply.status(400).header('content-type', CT).send(scimError(400, parsed.rejected));

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
    await recordAdminEvent(deps.pool, {
      type: 'user_created',
      actor: scimActor(tokenId),
      subjectType: 'user',
      subjectId: user.id,
      subjectLabel: user.email,
      payload: { method: 'scim', active: parsed.active, roles: user.roles },
    });
    if (!parsed.active)
      await recordAdminEvent(deps.pool, {
        type: 'user_deactivated',
        actor: scimActor(tokenId),
        subjectType: 'user',
        subjectId: user.id,
        subjectLabel: user.email,
        payload: { method: 'scim', at_creation: true },
      });
    return reply
      .status(201)
      .header('content-type', CT)
      .send(toScimUser({ ...user, deleted_at: parsed.active ? null : new Date() }));
  });

  // PATCH — the common path is toggling `active` (deprovision / reactivate).
  app.patch('/scim/v2/Users/:id', limited, async (req, reply) => {
    const tokenId = await requireToken(req, reply);
    if (!tokenId) return;
    const { id } = req.params as { id: string };
    const user = await findUserById(deps.pool, id);
    if (!user) return reply.status(404).header('content-type', CT).send(scimError(404, 'User not found'));
    const active = activeFromPatch(req.body);
    if (active !== undefined) {
      await setUserActive(deps.pool, id, active);
      // Only when it moved. An IdP resyncs its whole directory on a schedule
      // and re-asserts `active: true` for everybody each pass; a row per
      // assertion would bury the one deactivation in a few hundred no-ops.
      if (active === Boolean(user.deleted_at))
        await recordAdminEvent(deps.pool, {
          type: active ? 'user_restored' : 'user_deactivated',
          actor: scimActor(tokenId),
          subjectType: 'user',
          subjectId: id,
          subjectLabel: user.email,
          payload: { method: 'scim' },
        });
    }
    // The re-read can come back empty — a hard delete between the two lookups,
    // or a `users` row removed by a retention purge mid-request. The cast this
    // line used to carry declared that away, and `toScimUser(null)` throws
    // inside the handler, which an IdP sees as a 500 on a deprovision it will
    // then retry forever. 404 is the SCIM answer to "that user is gone".
    const refreshed = await findUserById(deps.pool, id);
    if (!refreshed)
      return reply.status(404).header('content-type', CT).send(scimError(404, 'User not found'));
    return reply.header('content-type', CT).send(toScimUser(refreshed));
  });

  // DELETE — SCIM deprovision. Soft delete so history + audit trail survive.
  app.delete('/scim/v2/Users/:id', limited, async (req, reply) => {
    const tokenId = await requireToken(req, reply);
    if (!tokenId) return;
    const { id } = req.params as { id: string };
    const user = await findUserById(deps.pool, id);
    if (!user) return reply.status(404).header('content-type', CT).send(scimError(404, 'User not found'));
    await setUserActive(deps.pool, id, false);
    if (!user.deleted_at)
      await recordAdminEvent(deps.pool, {
        type: 'user_deactivated',
        actor: scimActor(tokenId),
        subjectType: 'user',
        subjectId: id,
        subjectLabel: user.email,
        payload: { method: 'scim', via: 'delete' },
      });
    return reply.status(204).send();
  });
}
