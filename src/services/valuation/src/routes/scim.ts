import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { ApiProblem, databaseUnavailableReason, requestErrorContext, scrubError } from '@n409/shared';
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
  scimPage,
  SCIM_MAX_PAGE,
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
 *
 * ## Why everything below lives in one encapsulated scope
 *
 * The handlers spoke SCIM and nothing around them did, and the gap between
 * those two facts is where every real IdP landed.
 *
 * RFC 7644 §3.1 names `application/scim+json` as the media type of a SCIM
 * request, and Okta, Microsoft Entra ID and OneLogin all send it on `POST` and
 * `PATCH`. This service had a parser for `application/json` and no other, so
 * Fastify refused the body before routing: **every create and every
 * deprovision from a real connector was answered 415** — with a problem+json
 * body, which is not a document a SCIM client can read either. The routes'
 * own tests all passed, because `inject({ payload })` serialises as
 * `application/json`; the media type the specification actually names was the
 * one shape never exercised.
 *
 * The same gap runs through every refusal Fastify raises rather than a handler:
 * a body that is not JSON, a URL under `/scim/v2` that is not a route
 * (`/Groups`, which Okta probes when group push is switched on), a 500. Each
 * left as problem+json. An IdP parses `schemas` + `status` + `detail` and
 * nothing else, so all of them arrive as "the SCIM endpoint returned an
 * unintelligible response" in the admin's connector log — and, on a
 * deprovision, are retried indefinitely.
 *
 * A prefixed `register` is what makes those fixable: a content-type parser, an
 * error handler and a not-found handler set inside it apply to `/scim/v2/*`
 * and to nothing else, so the platform's problem+json contract is untouched
 * everywhere a human client is reading.
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

const CT = 'application/scim+json';

export function registerScimRoutes(
  app: FastifyInstance,
  deps: { pool: pg.Pool; limiter?: FixedWindowRateLimiter },
): void {
  const limiter = deps.limiter ?? new FixedWindowRateLimiter(SCIM_RATE_LIMIT, SCIM_RATE_WINDOW_MS);

  void app.register(
    async (scope) => {
      /**
       * The media type the specification names, parsed as the JSON it is.
       *
       * Registered on this scope only. `application/json` is inherited from the
       * parent, so a connector that sends the plainer type keeps working; this
       * adds the one RFC 7644 requires, and with it the `;charset=utf-8` that
       * Entra appends — Fastify matches a parser on the essence of the header,
       * not the whole string.
       *
       * A parse failure is handed to `done` rather than thrown, so it reaches
       * the scoped error handler below and leaves as a SCIM error rather than
       * as Fastify's own `FST_ERR_CTP_INVALID_JSON` in problem+json.
       */
      scope.addContentTypeParser(CT, { parseAs: 'string' }, (_req, body, done) => {
        const raw = (body as string).trim();
        // An empty body is a legal `PATCH`-with-nothing rather than a parse
        // error; `activeFromPatch` reads it as "no activation change".
        if (!raw) return done(null, {});
        try {
          done(null, JSON.parse(raw) as unknown);
        } catch {
          done(new ApiProblem({ status: 400, title: 'Bad Request', detail: 'Body is not valid JSON' }));
        }
      });

      /**
       * Every refusal under this prefix, in the one error shape the caller can
       * read.
       *
       * Mirrors the estate's problem+json handler (`registerProblemHandler`)
       * decision for decision — an `ApiProblem` keeps its status and detail, a
       * database that cannot answer is a 503 rather than a 500 so the connector
       * backs off instead of giving up, a 5xx is logged scrubbed and answered
       * with a constant, a 4xx Fastify raised describes the caller's own
       * request and so may be echoed — and differs only in what it writes.
       */
      scope.setErrorHandler((err: unknown, req: FastifyRequest, reply: FastifyReply) => {
        const send = (status: number, detail: string) =>
          reply.status(status).header('content-type', CT).send(scimError(status, detail));
        if (err instanceof ApiProblem) {
          if (err.retryAfterSeconds !== undefined) {
            void reply.header('retry-after', String(err.retryAfterSeconds));
          }
          return send(err.status, err.detail ?? err.title);
        }
        const fastifyErr = err as { statusCode?: number; message?: string };
        const status = fastifyErr.statusCode && fastifyErr.statusCode < 500 ? fastifyErr.statusCode : 500;
        const dbReason = databaseUnavailableReason(err);
        if (dbReason !== null) {
          req.log.warn(
            { err: scrubError(err), ...requestErrorContext(req), failure_reason: dbReason },
            'database unavailable',
          );
          return send(503, 'The directory store is temporarily unavailable. Nothing was changed.');
        }
        if (status >= 500) {
          req.log.error({ err: scrubError(err), ...requestErrorContext(req) }, 'unhandled error');
          return send(status, 'The SCIM endpoint could not complete this request');
        }
        return send(status, fastifyErr.message || 'The SCIM endpoint refused this request');
      });

      /**
       * A resource type this service does not implement.
       *
       * `/scim/v2/Groups` is the one that matters: turning on group push in
       * Okta makes it `GET /Groups` first, and the platform's problem+json 404
       * told it nothing it could parse. 404 in SCIM's own shape, naming the
       * path, is what surfaces "this service provides Users only" in the
       * connector log — which is also what `ServiceProviderConfig` says by
       * advertising no `/Groups` and `bulk: { supported: false }`.
       */
      scope.setNotFoundHandler((req, reply) =>
        reply
          .status(404)
          .header('content-type', CT)
          .send(scimError(404, `${req.url} is not a SCIM resource this service provides`)),
      );

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
      const scimActor = (tokenId: string) => ({
        actorType: 'system' as const,
        actorId: tokenId,
        source: 'scim',
      });

      /**
       * Which accounts this bearer is allowed to name at all.
       *
       * `users.provisioned_by` is `'scim'`, `'saml'` or NULL (migration 0082): the
       * directory made this account, the directory made it on first sign-in, or a
       * person registered it here. The first two are the IdP's records to manage.
       * The third are this platform's own — every administrator seeded before an
       * IdP existed, every ops account, every client who signed up through the
       * front door.
       *
       * The listing already drew that line (`WHERE provisioned_by = 'scim'`), and
       * it was the only route that did. `GET /Users/:id`, the `userName eq` filter,
       * `PATCH` and `DELETE` all went straight to `findUserById` /
       * `findUserByEmail` over the whole `users` table — so a SCIM bearer could
       * read any account on the platform by address, and `setUserActive(id, false)`
       * any of them. There is no last-administrator guard on that path the way
       * there is on `DELETE /me` and the admin user delete, so a connector
       * misconfigured against the wrong directory — or a leaked token, which is the
       * threat this endpoint's whole shape is built around, being a bearer facing
       * the open internet — deactivates every administrator and nobody can sign in
       * to undo it.
       *
       * `'saml'` is in the set rather than only `'scim'` because the two are the
       * same directory: a user JIT-provisioned by the SAML assertion consumer
       * (routes/saml.ts) is exactly who the connector then deprovisions. Excluding
       * them would answer a real deprovision with 404, which Okta and Entra both
       * surface as an integration error and then stop retrying — a failure to
       * remove access, which is worse than what this guard prevents.
       *
       * NULL is the case being closed, and it is stated as an allow-list rather
       * than `!== null` so a fourth provisioning source has to be considered rather
       * than inherited.
       */
      const DIRECTORY_PROVISIONED: ReadonlySet<string> = new Set(['scim', 'saml']);
      const managedByDirectory = (user: { provisioned_by: string | null }): boolean =>
        user.provisioned_by !== null && DIRECTORY_PROVISIONED.has(user.provisioned_by);

      /**
       * The user this request names, or null with the 404 already sent.
       *
       * 404 and not 403 for a local account, for the reason every other id-keyed
       * refusal in this service gives: the answer must not distinguish "no such
       * user" from "a user you may not touch", or the endpoint becomes a directory
       * of which addresses have accounts here.
       */
      const loadManaged = async (
        id: string,
        reply: FastifyReply,
      ): Promise<Awaited<ReturnType<typeof findUserById>>> => {
        const user = await findUserById(deps.pool, id);
        if (!user || !managedByDirectory(user)) {
          void reply.status(404).header('content-type', CT).send(scimError(404, 'User not found'));
          return null;
        }
        return user;
      };

      const defaultRole = async (): Promise<RoleKey> => {
        const config = await getSamlConfig(deps.pool);
        const role = config?.default_role ?? 'valuation_user';
        return (ROLE_KEYS as readonly string[]).includes(role) ? (role as RoleKey) : 'valuation_user';
      };

      scope.get('/ServiceProviderConfig', limited, async (_req, reply) =>
        reply.header('content-type', CT).send({
          schemas: ['urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig'],
          patch: { supported: true },
          filter: { supported: true, maxResults: SCIM_MAX_PAGE },
          bulk: { supported: false },
          changePassword: { supported: false },
          sort: { supported: false },
          authenticationSchemes: [{ name: 'OAuth Bearer Token', type: 'oauthbearertoken' }],
        }),
      );

      scope.get('/Users', limited, async (req, reply) => {
        if (!(await requireToken(req, reply))) return;
        const filter = parseUserNameFilter((req.query as { filter?: string }).filter);
        if (filter) {
          // Same boundary as `loadManaged`, and the reason it matters more here:
          // the filter takes an address rather than an id, so without it this is a
          // "does this person have an account" oracle over the whole platform that
          // anyone holding the bearer can run one address at a time.
          const user = await findUserByEmail(deps.pool, filter);
          const managed = user && managedByDirectory(user) ? user : null;
          return reply.header('content-type', CT).send(scimList(managed ? [toScimUser(managed)] : []));
        }
        // `count(*)` over the same predicate as the page, so `totalResults`
        // answers "how many are there" rather than "how many did you send" —
        // see `scimList`. Two statements rather than a window function because
        // `count: 0` is a legal request for the total with no rows at all.
        const { startIndex, count } = scimPage(req.query);
        const [{ rows: totals }, { rows }] = await Promise.all([
          deps.pool.query<{ total: string }>(
            `SELECT count(*)::text AS total FROM users WHERE provisioned_by = 'scim'`,
          ),
          deps.pool.query<ScimUserRow>(
            `SELECT id, email, first_name, last_name, scim_external_id, deleted_at, created_at
               FROM users WHERE provisioned_by = 'scim'
              ORDER BY created_at DESC, id DESC
              LIMIT $1 OFFSET $2`,
            [count, startIndex - 1],
          ),
        ]);
        return reply
          .header('content-type', CT)
          .send(scimList(rows.map(toScimUser), { totalResults: Number(totals[0]?.total ?? 0), startIndex }));
      });

      scope.get('/Users/:id', limited, async (req, reply) => {
        if (!(await requireToken(req, reply))) return;
        const { id } = req.params as { id: string };
        const user = await loadManaged(id, reply);
        if (!user) return;
        return reply.header('content-type', CT).send(toScimUser(user));
      });

      scope.post('/Users', limited, async (req, reply) => {
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
      scope.patch('/Users/:id', limited, async (req, reply) => {
        const tokenId = await requireToken(req, reply);
        if (!tokenId) return;
        const { id } = req.params as { id: string };
        const user = await loadManaged(id, reply);
        if (!user) return;
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
      scope.delete('/Users/:id', limited, async (req, reply) => {
        const tokenId = await requireToken(req, reply);
        if (!tokenId) return;
        const { id } = req.params as { id: string };
        const user = await loadManaged(id, reply);
        if (!user) return;
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
    },
    // Written as a literal rather than a constant so the source scan behind the
    // route censuses can resolve it — see test/support/routeSource.ts.
    { prefix: '/scim/v2' },
  );
}
