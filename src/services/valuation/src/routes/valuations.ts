import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { isIsoCalendarDate, isUlid, problems } from '@n409/shared';
import { withPlanQuota } from '../domain/planQuota.js';
import {
  canCreateValuation,
  canReadValuation,
  isOps,
  patchableFields,
  valuationScope,
} from '../auth/rbac.js';
import {
  VALUATION_KINDS,
  VALUATION_SOURCES,
  VALUATION_STATES,
  type ValuationState,
} from '../domain/valuation.js';
import { CountryCode, CurrencyCode } from '../domain/currency.js';
import { malformedIfMatch, parseIfMatch, versionEtag } from '../domain/concurrency.js';
import { STATE_GROUP_KEYS, type StateGroup } from '../domain/operations.js';
import { NAMED_BUCKET_KEYS, type NamedBucketKey } from '../domain/workflow.js';
import { isTagSlug } from '../domain/valuationTags.js';
import { EVENT_PAGE_LIMIT, listEvents } from '../events/record.js';
import { CLIENT_VISIBLE_EVENT_TYPES, eventLabel } from '../domain/auditTrail.js';
import {
  createValuation,
  findValuationById,
  listValuations,
  markValuationRead,
  parseSortTerms,
  patchValuation,
  type ValuationFilters,
  type ValuationRow,
} from '../repos/valuations.js';
import { userExists } from '../repos/users.js';
import { assertAssignable } from '../domain/assignee.js';
import { findPartnerById } from '../repos/adminUsers.js';
import { onStateChanged, type EmailTransport, type TransitionRenderDeps } from '../hooks/stateChange.js';
import { assertPublishGate, assertPublishGateForWrite } from '../domain/publishGate.js';
import { assertTransition, assertTransitionForWrite } from '../domain/transitionGuard.js';
import { requirePrincipal } from '../plugins/auth.js';
import type { EventActor } from '../events/record.js';
import type { Principal } from '../auth/rbac.js';
import { pageParam } from '../domain/pagination.js';
import { flagParam } from '../domain/queryFlag.js';
import { int4Positive } from '../domain/int4.js';
import { visibleCommentKinds } from '../auth/operations.js';
import { loadValuationCounters } from '../repos/valuationCounters.js';
import { refuseIfRetired } from '../domain/retiredEngagement.js';
import { invalidBody, invalidQuery } from '../domain/validationProblem.js';
import { invalidSort } from '../domain/sortRefusal.js';
import { forbidden } from '../domain/accessProblem.js';
import { UlidParam } from '../plugins/params.js';
import { ulidField } from '../domain/ulidField.js';

const CreateBody = z.object({
  kind: z.enum(VALUATION_KINDS),
  company_name: z.string().trim().min(1).max(300),
  service_name: z.string().trim().min(1).max(300).optional(),
  currency: CurrencyCode.optional(),
  service_countries: z.array(CountryCode).max(50).optional(),
  source: z.enum(VALUATION_SOURCES).optional(),
  gclid: z.string().max(200).optional(),
  /*
   * Ops may create on behalf of a client / attach a partner.
   *
   * Both columns are the `ulid` domain, and a domain check is enforced on
   * assignment: a string that is not one reaches the INSERT and comes back as
   * `value for domain ulid violates check constraint` — a 500 for a body field
   * this schema is supposed to describe. That is the same thing `PatchBody`
   * says below about `assigned_reviewer_id`, which was fixed there and left
   * here, on the door that creates the row rather than the one that edits it.
   *
   * Shape here, existence in the handler below: an id that is well-formed and
   * names nobody is a different answer (`Unknown user`) from an id that is not
   * one, and both were the same 500 before.
   */
  user_id: UlidParam.optional(),
  partner_id: UlidParam.optional(),
});

const PatchBody = z
  .object({
    company_name: z.string().trim().min(1).max(300),
    service_name: z.string().trim().min(1).max(300).nullable(),
    state: z.enum(VALUATION_STATES),
    waiting_on_client: z.boolean(),
    // The column is the `ulid` domain with a foreign key to `users`. Neither
    // was checked here, so both halves of getting it wrong — a string that is
    // not an id, and an id that is not a user — reached the driver and came
    // back as a 500. Shape here, existence in the handler.
    assigned_reviewer_id: ulidField().nullable(),
    due_date: z.string().datetime().nullable(),
    delivery_days: int4Positive().nullable(),
    paid_status: z.enum(['unpaid', 'paid', 'paid_by_partner']),
    currency: CurrencyCode,
    service_countries: z.array(CountryCode).max(50),
    qsbs_attestation: z.boolean().nullable(),
  })
  .partial()
  .strict();

const DateOnly = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD')
  .refine(isIsoCalendarDate, 'Not a real calendar date');

/**
 * M3 feature 15 — advanced filters, shared by the list, the tab counts, and
 * the CSV export (routes/operations.ts).
 */
export const ValuationFilterQuery = z.object({
  state: z.enum(VALUATION_STATES).optional(),
  kind: z.enum(VALUATION_KINDS).optional(),
  group: z.enum(STATE_GROUP_KEYS as [StateGroup, ...StateGroup[]]).optional(),
  // The nine named tabs (design §4.2). `group` stays accepted as a URL alias so
  // saved views and shared links written against the five buckets keep working.
  bucket: z.enum(NAMED_BUCKET_KEYS as [NamedBucketKey, ...NamedBucketKey[]]).optional(),
  q: z.string().max(300).optional(),
  // Comma-separated id list — lets the UI export exactly the checked rows.
  // Non-ULID entries are dropped; scope still applies on top.
  ids: z
    .string()
    .max(6000)
    .transform((s) =>
      s
        .split(',')
        .map((part) => part.trim().toUpperCase())
        .filter((part) => isUlid(part))
        .slice(0, 200),
    )
    .optional(),
  reviewer_id: ulidField().optional(),
  partner_id: ulidField().optional(),
  user_id: ulidField().optional(),
  source: z.enum(VALUATION_SOURCES).optional(),
  paid_status: z.enum(['unpaid', 'paid', 'paid_by_partner']).optional(),
  waiting_on_client: flagParam(),
  // Unread scope (gap 4) — resolved to the caller's side in the route.
  unread: flagParam(),
  created_from: DateOnly.optional(),
  created_to: DateOnly.optional(),
  due_from: DateOnly.optional(),
  due_to: DateOnly.optional(),
  /*
   * `tags=saas,pre_revenue` — every one must be accepted on the engagement.
   *
   * Unknown slugs are dropped rather than refused, which is the same call the
   * `ids` filter above makes about malformed ULIDs. A saved view or a bookmark
   * written against a tag later retired should keep working on the tags it
   * still names, and a 422 on a URL somebody saved six months ago is a worse
   * answer than a narrower result. The catalogue is served at
   * /api/v1/tag-catalogue for a caller that wants to check first.
   */
  tags: z
    .string()
    .max(600)
    .transform((s) =>
      s
        .split(',')
        .map((part) => part.trim())
        .filter((part) => isTagSlug(part))
        .slice(0, 12),
    )
    .optional(),
});

/**
 * Which side of the read marker this caller's "unread" means.
 *
 * Ops read the admin side of every conversation; everyone else reads their own.
 * It lives beside {@link toRepoFilters} because it is that function's missing
 * second argument — `unreadFor` resolves to `undefined` without it, and a
 * filter that resolves to `undefined` is not a narrower result, it is no filter
 * at all. Three routes derived this rule inline or privately and one of them
 * forgot to derive it, so there is one copy now and it is next to the thing
 * that needs it.
 */
export function readerSideFor(principal: Principal): 'admin' | 'user' {
  return isOps(principal) ? 'admin' : 'user';
}

export function toRepoFilters(
  f: z.infer<typeof ValuationFilterQuery>,
  readerSide?: 'admin' | 'user',
): ValuationFilters {
  return {
    // The Unread tab and the `unread=true` filter key are the same predicate;
    // the tab is the filter with a name on it, not a second implementation.
    unreadFor: (f.unread || f.bucket === 'unread') && readerSide ? readerSide : undefined,
    state: f.state,
    kind: f.kind,
    group: f.group,
    bucket: f.bucket,
    q: f.q || undefined,
    ids: f.ids?.length ? f.ids : undefined,
    reviewerId: f.reviewer_id,
    partnerId: f.partner_id,
    userId: f.user_id,
    source: f.source,
    paidStatus: f.paid_status,
    waitingOnClient: f.waiting_on_client,
    createdFrom: f.created_from,
    createdTo: f.created_to,
    dueFrom: f.due_from,
    dueTo: f.due_to,
    tags: f.tags?.length ? f.tags : undefined,
  };
}

const ListQuery = ValuationFilterQuery.extend({
  // M4 rich sort: "company_name:asc,created_at:desc" (whitelisted columns)
  sort: z.string().max(200).optional(),
  page: pageParam(),
  per_page: z.coerce.number().int().min(1).max(100).default(25),
});

function actorFor(principal: Principal): EventActor {
  return { actorType: 'human', actorId: principal.id, source: 'api' };
}

function toRef(v: ValuationRow) {
  return { userId: v.user_id, partnerId: v.partner_id };
}

/**
 * Every precondition of a state write, on the client that is about to issue it.
 *
 * Both halves are re-run here rather than trusted from the route's own reads,
 * for the reason each of them documents: the row they were judged against is
 * free to move between the read and the UPDATE. Ordered as the route orders
 * them, so a contended request and an uncontended one refuse the same way.
 */
function stateWriteGuard(valuationId: string, to: ValuationState) {
  const transition = assertTransitionForWrite(valuationId, to);
  const publishGate = assertPublishGateForWrite(valuationId, to);
  return async (client: pg.PoolClient) => {
    await transition(client);
    await publishGate(client);
  };
}

async function loadAuthorized(pool: pg.Pool, principal: Principal, id: string): Promise<ValuationRow> {
  if (!isUlid(id)) throw problems.notFound();
  const valuation = await findValuationById(pool, id);
  // 404 (not 403) when out of scope — don't reveal that the id exists.
  if (!valuation || !canReadValuation(principal, toRef(valuation))) throw problems.notFound();
  return valuation;
}

export function registerValuationRoutes(
  app: FastifyInstance,
  deps: { pool: pg.Pool; transport?: EmailTransport } & TransitionRenderDeps,
): void {
  app.post('/api/v1/valuations', { preHandler: app.authenticate }, async (req, reply) => {
    const principal = requirePrincipal(req);
    if (!canCreateValuation(principal)) throw forbidden('Creating a valuation', 'ops');

    const parsed = CreateBody.safeParse(req.body);
    if (!parsed.success) throw invalidBody('Invalid valuation', parsed.error);
    const body = parsed.data;

    // Non-ops principals always create for themselves, inside their own partner scope.
    const ops = isOps(principal);
    const userId = ops && body.user_id ? body.user_id : principal.id;
    const partnerId = ops && body.partner_id !== undefined ? body.partner_id : principal.partnerId;

    /*
     * The other half of the schema's shape check, in the shape the admin
     * console already uses for the same two columns (`assertAssignablePartner`
     * in routes/adminUsers.ts): a well-formed id naming nobody is a foreign key
     * violation on the INSERT below, which arrives as a 500 for a body field
     * that was simply wrong. Only on the ops path — everywhere else these are
     * the principal's own ids and exist by construction.
     *
     * `userExists` rather than `findUserById`, which is `SELECT u.*` and a join
     * to build a role array nobody here reads. Both are `unprocessable` rather
     * than `notFound`: the valuation route was reached, and it is a field of the
     * body that names nothing.
     */
    if (ops && body.user_id && !(await userExists(deps.pool, body.user_id))) {
      throw problems.unprocessable('Unknown user', { errors: [{ path: ['user_id'] }] });
    }
    /*
     * `assertAssignablePartner` has two refusals and this had copied one.
     *
     * The comment above claims the admin console's shape "for the same two
     * columns", and the console's helper reads: unknown partner, *and* — under
     * "new partner assignments must reference a live (non-archived) partner" —
     * archived partner. Only the first was here, so `archived_at` did nothing
     * at the door that files the work itself.
     *
     * `partners.archived_at` is the platform's soft delete for a firm, and the
     * rule it states is the one `convertIntakeLink` gives in a sentence: "a
     * withdrawn firm acquiring fresh work is the thing being prevented". R342
     * closed the API key that created engagements under an archived firm and
     * the fan-out that told it about them; this is the console doing the same
     * thing through the front door, and it is the shorter route of the two.
     *
     * Asked of the *resolved* partner rather than of the body field, so the
     * member path is covered as well: archiving a firm does not sign its
     * people out, and their own `principal.partnerId` is the id this writes
     * when ops did not name one. Two answers because they are two faults — an
     * ops caller named a field that will not do, and a member of a withdrawn
     * firm is being told about their firm rather than about their request.
     *
     * Skipped entirely for a null partner, which is every platform-side
     * engagement and the ops path that explicitly clears the field.
     */
    if (partnerId) {
      const partner = await findPartnerById(deps.pool, partnerId);
      // Only reachable from the body: a principal's `partner_id` is a foreign
      // key and the row it names exists.
      if (!partner) throw problems.unprocessable('Unknown partner', { errors: [{ path: ['partner_id'] }] });
      if (partner.archived_at) {
        throw ops && body.partner_id
          ? problems.unprocessable('This partner is archived', { errors: [{ path: ['partner_id'] }] })
          : problems.conflict(
              'This firm has been withdrawn from the platform, so no new engagements can be created ' +
                'under it. Ask an administrator to restore it first.',
            );
      }
    }

    // Feature 7: subscribers consume against their plan limit; a user with no
    // active subscription is on the one-time per-valuation flow and unaffected.
    // The draw, the 402 and the refund on a failed insert are
    // `domain/planQuota.ts`, shared with the three other doors that open an
    // engagement for a user — the metered account is `userId`, the one the
    // engagement is opened *for*, not the operator opening it.
    const valuation = await withPlanQuota(deps.pool, req.log, userId, 'create', () =>
      createValuation(
        deps.pool,
        {
          kind: body.kind,
          companyName: body.company_name,
          serviceName: body.service_name,
          userId,
          partnerId,
          source: body.source ?? (partnerId ? 'partner' : undefined),
          currency: body.currency,
          serviceCountries: body.service_countries,
          gclid: body.gclid,
        },
        actorFor(principal),
      ),
    );
    return reply.status(201).send({ valuation });
  });

  app.get('/api/v1/valuations', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    const parsed = ListQuery.safeParse(req.query);
    if (!parsed.success) throw invalidQuery(parsed.error);
    const { page, per_page } = parsed.data;

    const parsedSort = parseSortTerms(parsed.data.sort);
    if (parsedSort.refusal !== null) throw invalidSort(parsedSort.refusal);
    const sort = parsedSort.specs;

    const readerSide = readerSideFor(principal);
    const { items, total } = await listValuations(deps.pool, valuationScope(principal), {
      ...toRepoFilters(parsed.data, readerSide),
      sort,
      page,
      perPage: per_page,
      readerSide,
    });
    return { valuations: items, page, per_page, total };
  });

  app.get('/api/v1/valuations/:id', { preHandler: app.authenticate }, async (req, reply) => {
    const principal = requirePrincipal(req);
    const { id } = req.params as { id: string };
    const valuation = await loadAuthorized(deps.pool, principal, id);
    // The validator a PATCH sends back as If-Match. Set here rather than left
    // to the client to read out of the body, so the round trip is the ordinary
    // HTTP one and an intermediary cannot serve a body whose version has moved.
    reply.header('ETag', versionEtag(valuation.version));
    // Opening a valuation clears its unread marker for the viewer's side
    // (gap 4). Ops read the admin marker; the owner reads the user marker.
    if (isOps(principal)) await markValuationRead(deps.pool, valuation.id, 'admin');
    else if (principal.id === valuation.user_id) await markValuationRead(deps.pool, valuation.id, 'user');

    /**
     * The header chip row and the Calculations nav badge (design §4.6, §7.3).
     *
     * Served on the detail read rather than as its own endpoint: the workspace
     * cannot render its header without them, and a second request for five
     * numbers is a second chance for the header to disagree with the page
     * under it.
     *
     * Computed after the read marker is cleared, deliberately. The marker and
     * `unread_comments` are different things — one is "has anyone looked at
     * this engagement", the other is "what has been said since *I* last read
     * the thread" — and the comment count is not cleared by opening the
     * workspace, only by opening the thread.
     */
    const counters = await loadValuationCounters(deps.pool, valuation.id, principal.id, [
      ...visibleCommentKinds(principal),
    ]);
    return { valuation, counters };
  });

  app.patch('/api/v1/valuations/:id', { preHandler: app.authenticate }, async (req, reply) => {
    const principal = requirePrincipal(req);
    const { id } = req.params as { id: string };
    const valuation = await loadAuthorized(deps.pool, principal, id);
    refuseIfRetired(valuation, 'accepting edits');

    // Opt-in concurrency check: a client that echoes the ETag it read gets its
    // write refused if somebody else has saved since (migration 0137). Parsed
    // before the body so a malformed header fails the same way whatever the
    // patch contains.
    const ifMatch = parseIfMatch(req.headers['if-match']);
    if (ifMatch.kind === 'invalid') {
      throw malformedIfMatch(ifMatch);
    }
    const expectedVersion = ifMatch.kind === 'version' ? ifMatch.version : undefined;

    const parsed = PatchBody.safeParse(req.body);
    if (!parsed.success) throw invalidBody('Invalid patch', parsed.error);

    const allowed = patchableFields(principal, toRef(valuation));
    const requested = Object.keys(parsed.data);
    const denied = requested.filter((f) => !allowed.has(f));
    if (denied.length > 0) {
      /*
       * A 403 that names the fields *and* says whose they are (R350).
       *
       * `Not allowed to update: state, due_date` is a list of column names and
       * nothing else: no reason, no remedy, and no `required_access` token —
       * the three things `accessProblem` exists to put on every 403, and which
       * R180 gave to twenty-nine bare `problems.forbidden()` calls. This one
       * escaped that sweep by already having a string.
       *
       * Two audiences reach it and they need different sentences.
       * `patchableFields` returns the empty set for a principal who may read
       * the engagement but does not own it, so *every* key is denied and the
       * list says nothing; that is `own-record`. The other is the owner asking
       * for a field their analyst owns — a client, who must not be told to ask
       * for an operations role, which is why that has a kind of its own.
       *
       * The field names stay in the message either way. They are the caller's
       * own keys, echoed back the way `validationDetail` echoes a rejected
       * field, and on a whole-form PATCH they are the only thing saying which
       * part of the form to leave alone.
       */
      throw forbidden(
        allowed.size === 0
          ? 'Editing this engagement'
          : `Setting ${denied.join(', ')} on this engagement`,
        allowed.size === 0 ? 'own-record' : 'ops-managed-field',
      );
    }
    if (requested.length === 0) {
      reply.header('ETag', versionEtag(valuation.version));
      return { valuation };
    }

    // `valuations_assigned_reviewer_id_fkey` references `users`, so a reviewer
    // who has since been deleted — or an id from a stale list — is a 23503 in
    // the driver and a 500 to the caller. Same check and same message as the
    // bulk reassign in routes/workflow.ts, which is the other way to set this.
    if (parsed.data.assigned_reviewer_id != null) {
      await assertAssignable(deps.pool, parsed.data.assigned_reviewer_id, 'reviewer', 'assigned_reviewer_id');
    }

    if (parsed.data.state && parsed.data.state !== valuation.state) {
      // Legality first: an engagement that cannot legally reach `published`
      // should be told that, not told to go and find a signature for a
      // transition that would be refused once it had one.
      assertTransition(valuation.state, parsed.data.state);
      await assertPublishGate(deps.pool, valuation.id, parsed.data.state);
    }
    const updated = await patchValuation(
      deps.pool,
      valuation,
      parsed.data as Record<string, unknown>,
      actorFor(principal),
      {
        /*
         * `If-Match` is opt-in for an ordinary field save, and cannot be for a
         * state write.
         *
         * The transition is judged against `valuation.state`, and the
         * `state_changed` event records that value as the `from` of the move.
         * A caller whose read has been overtaken therefore does not merely
         * apply a stale edit — it writes an audit line describing a transition
         * that did not happen, out of a state the row left before the request
         * arrived. The table check below refuses the edge that is illegal from
         * the live row and the one that has already reached the target, but
         * `reviewed → review` is a legal edge and a stale `completed → review`
         * lands on it silently, spine and client email included.
         *
         * So a body carrying `state` supplies its own version when the caller
         * did not, which is the rule every derived transition follows (see
         * `applyValuationState`). It costs nothing uncontended: `valuation` was
         * read by this request.
         */
        ...(expectedVersion !== undefined
          ? { expectedVersion }
          : parsed.data.state
            ? { expectedVersion: valuation.version }
            : {}),
        // Both gates re-run under the row lock, in the same order. The two
        // checks above answer for the uncontended case; these answer for the
        // row as it stands at the moment of the UPDATE.
        ...(parsed.data.state ? { preCommit: stateWriteGuard(valuation.id, parsed.data.state) } : {}),
      },
    );
    reply.header('ETag', versionEtag(updated.version));
    // M4: state changes fire the auto email workflows + in-app notifications.
    if (parsed.data.state && parsed.data.state !== valuation.state) {
      await onStateChanged(
        {
          pool: deps.pool,
          transport: deps.transport,
          log: app.log,
          publicBaseUrl: deps.publicBaseUrl,
          settings: deps.settings,
        },
        updated,
        updated.state,
      );
    }
    return { valuation: updated };
  });

  /**
   * The raw event spine, newest end first-class.
   *
   * `valuation_events` is append-only and never pruned: a param patch, a
   * calculation, a document, a comment and an AI job each write one, so an
   * engagement rolled forward across a few years holds thousands, each with a
   * `payload` JSONB beside it. This selected all of them — every row, every
   * payload — for a sidebar panel, on a table the audit-trail route on the
   * same spine had already decided to cap at MAX_TRAIL_EVENTS. One door was
   * bounded and the one next to it was not.
   *
   * Capped at the newest `limit`, because the newest is what an activity panel
   * is for, and `truncated` says when the cap bit rather than letting the
   * timeline quietly stop somewhere. The full history is the audit-trail route,
   * which is paginated and filterable and is where a reader who wants all of it
   * should be.
   */
  app.get('/api/v1/valuations/:id/events', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    const { id } = req.params as { id: string };
    await loadAuthorized(deps.pool, principal, id);

    const parsed = z
      .object({
        limit: z.coerce.number().int().min(1).max(EVENT_PAGE_LIMIT).default(EVENT_PAGE_LIMIT),
      })
      .safeParse(req.query ?? {});
    if (!parsed.success) throw invalidQuery(parsed.error);

    // One more than asked for, so "there are older events" is answered by the
    // same query rather than by a second COUNT over the same rows.
    const { limit } = parsed.data;
    // The visibility half of the same question. The catalog marks 37 of its 66
    // types as analyst tooling, and until now this route was the only door onto
    // the spine that did not ask: the audit trail filters them for non-ops, the
    // progress timeline reads a client allow-list, the evidence bundle and the
    // engagement panel are ops-only, and this one handed a client-owner
    // `overwrite_applied` and every internal `comment_added` with its payload.
    // Pushed into the query rather than applied to the page, so `limit` and
    // `truncated` still describe what the reader is allowed to see.
    const rows = await listEvents(deps.pool, id, {
      limit: limit + 1,
      ...(isOps(principal) ? {} : { types: CLIENT_VISIBLE_EVENT_TYPES }),
    });
    return {
      // `label` travels with the row: this panel used to name events from a
      // map in the frontend that had drifted from the catalog the change log
      // reads, so the same event was called two things two clicks apart.
      events: rows.slice(-limit).map((row) => ({ ...row, label: eventLabel(row.type) })),
      truncated: rows.length > limit,
      page_limit: EVENT_PAGE_LIMIT,
    };
  });
}
