import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { ApiProblem, isIsoCalendarDate, isUlid, problems } from '@n409/shared';
import {
  consumeValuation,
  findActiveSubscription,
  findPlanForSubscription,
  releaseValuation,
} from '../repos/billing.js';
import { planLimitDetail, quotaAwaitsRenewal } from '../domain/billing.js';
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
import { CurrencyCode } from '../domain/currency.js';
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
  parseSort,
  patchValuation,
  type ValuationFilters,
  type ValuationRow,
} from '../repos/valuations.js';
import { userExists } from '../repos/users.js';
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
import { forbidden } from '../domain/accessProblem.js';

const CreateBody = z.object({
  kind: z.enum(VALUATION_KINDS),
  company_name: z.string().min(1).max(300),
  service_name: z.string().min(1).max(300).optional(),
  currency: CurrencyCode.optional(),
  service_countries: z.array(z.string().length(2)).max(50).optional(),
  source: z.enum(VALUATION_SOURCES).optional(),
  gclid: z.string().max(200).optional(),
  // ops may create on behalf of a client / attach a partner
  user_id: z.string().optional(),
  partner_id: z.string().optional(),
});

const PatchBody = z
  .object({
    company_name: z.string().min(1).max(300),
    service_name: z.string().min(1).max(300).nullable(),
    state: z.enum(VALUATION_STATES),
    waiting_on_client: z.boolean(),
    // The column is the `ulid` domain with a foreign key to `users`. Neither
    // was checked here, so both halves of getting it wrong — a string that is
    // not an id, and an id that is not a user — reached the driver and came
    // back as a 500. Shape here, existence in the handler.
    assigned_reviewer_id: z.string().refine(isUlid, 'Not a valid id').nullable(),
    due_date: z.string().datetime().nullable(),
    delivery_days: int4Positive().nullable(),
    paid_status: z.enum(['unpaid', 'paid', 'paid_by_partner']),
    currency: CurrencyCode,
    service_countries: z.array(z.string().length(2)).max(50),
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
  reviewer_id: z.string().optional(),
  partner_id: z.string().optional(),
  user_id: z.string().optional(),
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

    // Feature 7: subscribers consume against their plan limit; a user with no
    // active subscription is on the one-time per-valuation flow and unaffected.
    const subscription = await findActiveSubscription(deps.pool, userId);
    if (subscription && !(await consumeValuation(deps.pool, userId))) {
      /*
       * The plan is read only on the refusal, never on the way through. The
       * limit itself is enforced inside `consumeValuation`'s own UPDATE, so
       * this lookup buys nothing but the sentence — and the sentence is the
       * whole of what the caller gets. A tier retired from the catalogue is
       * still the tier this subscriber is on, so it is `findPlanForSubscription`
       * (which does not filter `active`) rather than `findPlan`; a missing row
       * leaves the figures out and the remedy in.
       */
      const plan = await findPlanForSubscription(deps.pool, subscription.plan_tier);
      /**
       * And said out loud, which a 402 is not.
       *
       * The shared error handler logs 5xx and the two database branches; a 4xx
       * `ApiProblem` is a described refusal and passes without a line, which is
       * right for a bad request and wrong for this one. A plan limit reached is
       * not a malformed call — it is a paying customer being turned away from
       * the product, the single most actionable commercial signal this service
       * produces, and it was legible only to the customer who hit it.
       *
       * It is also the symptom of the two ways the quota accounting goes wrong,
       * neither of which anybody can see from the outside: a renewal that moved
       * `current_period_start` without moving `quota_period_start` (see
       * `upsertSubscription`, where the reset is gated on the money as well as
       * the date) leaves an exhausted counter across a period that was in fact
       * paid for, and a release that failed leaves it one high forever. Both
       * present as this refusal and nothing else — so the line carries the two
       * periods that decide which it is.
       *
       * `warn` and no alert: the refusal is correct behaviour and the customer
       * has a remedy in the sentence they were given. What it needs is to be
       * countable.
       */
      req.log.warn(
        {
          userId,
          subscriptionId: subscription.id,
          planTier: subscription.plan_tier,
          valuationsUsed: subscription.valuations_used,
          valuationLimit: plan?.valuation_limit ?? null,
          quotaPeriodStart: subscription.quota_period_start?.toISOString() ?? null,
          currentPeriodStart: subscription.current_period_start?.toISOString() ?? null,
          currentPeriodEnd: subscription.current_period_end?.toISOString() ?? null,
          subscriptionStatus: subscription.status,
          awaitingRenewal: quotaAwaitsRenewal(subscription),
        },
        'plan valuation limit reached — creation refused',
      );
      throw new ApiProblem({
        status: 402,
        title: 'Plan limit reached',
        type: 'urn:n409:problem:plan-limit',
        detail: planLimitDetail({
          plan_name: plan?.name ?? 'your plan',
          valuation_limit: plan?.valuation_limit ?? null,
          valuations_used: subscription.valuations_used,
          current_period_end: subscription.current_period_end,
          awaiting_renewal: quotaAwaitsRenewal(subscription),
        }),
      });
    }

    let valuation;
    try {
      valuation = await createValuation(
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
      );
    } catch (err) {
      /**
       * The quota is spent above and the row is inserted here, and the two are
       * separate statements — `createValuation` is its own transaction, so a
       * failure means no valuation exists at all. Without this the subscriber
       * was charged one of the plan's valuations for one they did not get, and
       * there is no way back: the counter is only ever reset by a renewal, so
       * on an annual retainer the twelfth could be spent on a 500 and the
       * customer would wait a year for it.
       *
       * Best-effort and logged either way. The failure being handled is the
       * reason to doubt the next statement too, and a refund that itself throws
       * must not replace the error the caller needs to see.
       */
      if (subscription) {
        try {
          const released = await releaseValuation(deps.pool, userId);
          req.log.warn({ err, userId, released }, 'valuation create failed — plan quota returned');
        } catch (refundErr) {
          req.log.error(
            { err: refundErr, cause: err, userId, alert: true },
            'valuation create failed and the plan quota it spent could not be returned',
          );
        }
      }
      throw err;
    }
    return reply.status(201).send({ valuation });
  });

  app.get('/api/v1/valuations', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    const parsed = ListQuery.safeParse(req.query);
    if (!parsed.success) throw invalidQuery(parsed.error);
    const { page, per_page } = parsed.data;

    const sort = parseSort(parsed.data.sort);
    if (sort === null) throw problems.badRequest('Invalid sort');

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
      throw problems.forbidden(`Not allowed to update: ${denied.join(', ')}`);
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
      if (!(await userExists(deps.pool, parsed.data.assigned_reviewer_id))) {
        throw problems.unprocessable('Unknown reviewer', {
          errors: [{ path: ['assigned_reviewer_id'] }],
        });
      }
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
