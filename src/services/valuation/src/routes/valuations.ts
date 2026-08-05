import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { ApiProblem, isIsoCalendarDate, isUlid, problems } from '@n409/shared';
import { consumeValuation, findActiveSubscription } from '../repos/billing.js';
import {
  canCreateValuation,
  canReadValuation,
  isOps,
  patchableFields,
  valuationScope,
} from '../auth/rbac.js';
import { VALUATION_KINDS, VALUATION_SOURCES, VALUATION_STATES } from '../domain/valuation.js';
import { CurrencyCode } from '../domain/currency.js';
import { STATE_GROUP_KEYS, type StateGroup } from '../domain/operations.js';
import { listEvents } from '../events/record.js';
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
import { onStateChanged, type EmailTransport } from '../hooks/stateChange.js';
import { assertPublishGate } from '../domain/publishGate.js';
import { requirePrincipal } from '../plugins/auth.js';
import type { EventActor } from '../events/record.js';
import type { Principal } from '../auth/rbac.js';
import { pageParam } from '../domain/pagination.js';
import { int4Positive } from '../domain/int4.js';

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
    assigned_reviewer_id: z.string().nullable(),
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
  waiting_on_client: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
  // Unread scope (gap 4) — resolved to the caller's side in the route.
  unread: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
  created_from: DateOnly.optional(),
  created_to: DateOnly.optional(),
  due_from: DateOnly.optional(),
  due_to: DateOnly.optional(),
});

export function toRepoFilters(
  f: z.infer<typeof ValuationFilterQuery>,
  readerSide?: 'admin' | 'user',
): ValuationFilters {
  return {
    unreadFor: f.unread && readerSide ? readerSide : undefined,
    state: f.state,
    kind: f.kind,
    group: f.group,
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

async function loadAuthorized(pool: pg.Pool, principal: Principal, id: string): Promise<ValuationRow> {
  if (!isUlid(id)) throw problems.notFound();
  const valuation = await findValuationById(pool, id);
  // 404 (not 403) when out of scope — don't reveal that the id exists.
  if (!valuation || !canReadValuation(principal, toRef(valuation))) throw problems.notFound();
  return valuation;
}

export function registerValuationRoutes(
  app: FastifyInstance,
  deps: { pool: pg.Pool; transport?: EmailTransport },
): void {
  app.post('/api/v1/valuations', { preHandler: app.authenticate }, async (req, reply) => {
    const principal = requirePrincipal(req);
    if (!canCreateValuation(principal)) throw problems.forbidden();

    const parsed = CreateBody.safeParse(req.body);
    if (!parsed.success) throw problems.unprocessable('Invalid valuation', { errors: parsed.error.issues });
    const body = parsed.data;

    // Non-ops principals always create for themselves, inside their own partner scope.
    const ops = isOps(principal);
    const userId = ops && body.user_id ? body.user_id : principal.id;
    const partnerId = ops && body.partner_id !== undefined ? body.partner_id : principal.partnerId;

    // Feature 7: subscribers consume against their plan limit; a user with no
    // active subscription is on the one-time per-valuation flow and unaffected.
    const subscription = await findActiveSubscription(deps.pool, userId);
    if (subscription && !(await consumeValuation(deps.pool, userId))) {
      throw new ApiProblem({
        status: 402,
        title: 'Plan limit reached',
        type: 'urn:n409:problem:plan-limit',
        detail:
          "Your plan's included valuations are used up for this period — upgrade or purchase additional valuations to continue.",
      });
    }

    const valuation = await createValuation(
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
    return reply.status(201).send({ valuation });
  });

  app.get('/api/v1/valuations', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    const parsed = ListQuery.safeParse(req.query);
    if (!parsed.success) throw problems.badRequest('Invalid query', { errors: parsed.error.issues });
    const { page, per_page } = parsed.data;

    const sort = parseSort(parsed.data.sort);
    if (sort === null) throw problems.badRequest('Invalid sort');

    const readerSide = isOps(principal) ? 'admin' : 'user';
    const { items, total } = await listValuations(deps.pool, valuationScope(principal), {
      ...toRepoFilters(parsed.data, readerSide),
      sort,
      page,
      perPage: per_page,
      readerSide,
    });
    return { valuations: items, page, per_page, total };
  });

  app.get('/api/v1/valuations/:id', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    const { id } = req.params as { id: string };
    const valuation = await loadAuthorized(deps.pool, principal, id);
    // Opening a valuation clears its unread marker for the viewer's side
    // (gap 4). Ops read the admin marker; the owner reads the user marker.
    if (isOps(principal)) await markValuationRead(deps.pool, valuation.id, 'admin');
    else if (principal.id === valuation.user_id) await markValuationRead(deps.pool, valuation.id, 'user');
    return { valuation };
  });

  app.patch('/api/v1/valuations/:id', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    const { id } = req.params as { id: string };
    const valuation = await loadAuthorized(deps.pool, principal, id);

    const parsed = PatchBody.safeParse(req.body);
    if (!parsed.success) throw problems.unprocessable('Invalid patch', { errors: parsed.error.issues });

    const allowed = patchableFields(principal, toRef(valuation));
    const requested = Object.keys(parsed.data);
    const denied = requested.filter((f) => !allowed.has(f));
    if (denied.length > 0) {
      throw problems.forbidden(`Not allowed to update: ${denied.join(', ')}`);
    }
    if (requested.length === 0) return { valuation };

    if (parsed.data.state && parsed.data.state !== valuation.state) {
      await assertPublishGate(deps.pool, valuation.id, parsed.data.state);
    }
    const updated = await patchValuation(
      deps.pool,
      valuation,
      parsed.data as Record<string, unknown>,
      actorFor(principal),
    );
    // M4: state changes fire the auto email workflows + in-app notifications.
    if (parsed.data.state && parsed.data.state !== valuation.state) {
      await onStateChanged(
        { pool: deps.pool, transport: deps.transport, log: app.log },
        updated,
        updated.state,
      );
    }
    return { valuation: updated };
  });

  app.get('/api/v1/valuations/:id/events', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    const { id } = req.params as { id: string };
    await loadAuthorized(deps.pool, principal, id);
    return { events: await listEvents(deps.pool, id) };
  });
}
