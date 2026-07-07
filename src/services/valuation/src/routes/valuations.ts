import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { isUlid, problems } from '@n409/shared';
import {
  canCreateValuation,
  canReadValuation,
  isOps,
  patchableFields,
  valuationScope,
} from '../auth/rbac.js';
import { VALUATION_KINDS, VALUATION_SOURCES, VALUATION_STATES } from '../domain/valuation.js';
import { listEvents } from '../events/record.js';
import {
  createValuation,
  findValuationById,
  listValuations,
  patchValuation,
  type ValuationRow,
} from '../repos/valuations.js';
import { requirePrincipal } from '../plugins/auth.js';
import type { EventActor } from '../events/record.js';
import type { Principal } from '../auth/rbac.js';

const CreateBody = z.object({
  kind: z.enum(VALUATION_KINDS),
  company_name: z.string().min(1).max(300),
  service_name: z.string().min(1).max(300).optional(),
  currency: z.string().length(3).optional(),
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
    delivery_days: z.number().int().positive().nullable(),
    paid_status: z.enum(['unpaid', 'paid', 'paid_by_partner']),
    currency: z.string().length(3),
    service_countries: z.array(z.string().length(2)).max(50),
    qsbs_attestation: z.boolean().nullable(),
  })
  .partial()
  .strict();

const ListQuery = z.object({
  state: z.enum(VALUATION_STATES).optional(),
  kind: z.enum(VALUATION_KINDS).optional(),
  page: z.coerce.number().int().min(1).default(1),
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

export function registerValuationRoutes(app: FastifyInstance, deps: { pool: pg.Pool }): void {
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
    const { page, per_page, state, kind } = parsed.data;

    const { items, total } = await listValuations(deps.pool, valuationScope(principal), {
      state,
      kind,
      page,
      perPage: per_page,
    });
    return { valuations: items, page, per_page, total };
  });

  app.get('/api/v1/valuations/:id', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    const { id } = req.params as { id: string };
    return { valuation: await loadAuthorized(deps.pool, principal, id) };
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

    const updated = await patchValuation(
      deps.pool,
      valuation,
      parsed.data as Record<string, unknown>,
      actorFor(principal),
    );
    return { valuation: updated };
  });

  app.get('/api/v1/valuations/:id/events', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    const { id } = req.params as { id: string };
    await loadAuthorized(deps.pool, principal, id);
    return { events: await listEvents(deps.pool, id) };
  });
}
