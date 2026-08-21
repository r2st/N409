import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { isIsoCalendarDate, isUlid, problems } from '@n409/shared';
import { canReadValuation, isOps, type Principal } from '../auth/rbac.js';
import {
  createRound,
  createTransaction,
  deleteRound,
  deleteTransaction,
  listRounds,
  listTransactions,
  TRANSACTION_KINDS,
  updateRound,
} from '../repos/transactions.js';
import { findValuationById, type ValuationRow } from '../repos/valuations.js';
import { requirePrincipal } from '../plugins/auth.js';
import type { EventActor } from '../events/record.js';
import { refuseIfRetired } from '../domain/retiredEngagement.js';

/**
 * Transaction & funding-round history (M4, P1 #24). Reads follow valuation
 * scope; writes are ops or the valuation owner (clients supply their own
 * funding history during onboarding).
 */

const cents = z.number().int().min(0).max(1e15);
const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD')
  .refine(isIsoCalendarDate, 'Not a real calendar date');

const RoundBody = z.object({
  name: z.string().min(1).max(200),
  security_type: z.string().min(1).max(200).nullable().optional(),
  closed_on: isoDate.nullable().optional(),
  amount_raised_cents: cents.nullable().optional(),
  pre_money_cents: cents.nullable().optional(),
  post_money_cents: cents.nullable().optional(),
  shares_issued: z.number().int().min(0).max(1e15).nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
});

const RoundPatchBody = RoundBody.partial().strict();

const TransactionBody = z.object({
  kind: z.enum(TRANSACTION_KINDS),
  occurred_on: isoDate,
  shares: z.number().int().min(0).max(1e15).nullable().optional(),
  price_per_share_cents: cents.nullable().optional(),
  counterparty: z.string().max(300).nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
});

function actorFor(principal: Principal): EventActor {
  return { actorType: 'human', actorId: principal.id, source: 'api' };
}

async function loadAuthorizedValuation(
  pool: pg.Pool,
  principal: Principal,
  id: string,
): Promise<ValuationRow> {
  if (!isUlid(id)) throw problems.notFound();
  const valuation = await findValuationById(pool, id);
  if (
    !valuation ||
    !canReadValuation(principal, { userId: valuation.user_id, partnerId: valuation.partner_id })
  ) {
    throw problems.notFound();
  }
  return valuation;
}

function requireWriteAccess(principal: Principal, valuation: ValuationRow): void {
  if (!isOps(principal) && valuation.user_id !== principal.id) {
    throw problems.forbidden('Only operations or the valuation owner can edit its history');
  }
}

export function registerTransactionRoutes(app: FastifyInstance, deps: { pool: pg.Pool }): void {
  // ── Funding rounds ──────────────────────────────────────────────────────────
  app.get('/api/v1/valuations/:id/rounds', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    const { id } = req.params as { id: string };
    await loadAuthorizedValuation(deps.pool, principal, id);
    return { rounds: await listRounds(deps.pool, id) };
  });

  app.post('/api/v1/valuations/:id/rounds', { preHandler: app.authenticate }, async (req, reply) => {
    const principal = requirePrincipal(req);
    const { id } = req.params as { id: string };
    const valuation = await loadAuthorizedValuation(deps.pool, principal, id);
    requireWriteAccess(principal, valuation);
    refuseIfRetired(valuation, 'accepting changes');

    const parsed = RoundBody.safeParse(req.body);
    if (!parsed.success) throw problems.unprocessable('Invalid round', { errors: parsed.error.issues });
    const b = parsed.data;
    const round = await createRound(
      deps.pool,
      id,
      {
        name: b.name,
        securityType: b.security_type,
        closedOn: b.closed_on,
        amountRaisedCents: b.amount_raised_cents,
        preMoneyCents: b.pre_money_cents,
        postMoneyCents: b.post_money_cents,
        sharesIssued: b.shares_issued,
        notes: b.notes,
      },
      actorFor(principal),
    );
    return reply.status(201).send({ round });
  });

  app.patch('/api/v1/valuations/:id/rounds/:roundId', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    const { id, roundId } = req.params as { id: string; roundId: string };
    const valuation = await loadAuthorizedValuation(deps.pool, principal, id);
    refuseIfRetired(valuation, 'accepting changes');
    requireWriteAccess(principal, valuation);
    if (!isUlid(roundId)) throw problems.notFound();

    const parsed = RoundPatchBody.safeParse(req.body);
    if (!parsed.success) throw problems.unprocessable('Invalid patch', { errors: parsed.error.issues });
    const b = parsed.data;
    const round = await updateRound(
      deps.pool,
      id,
      roundId,
      {
        name: b.name,
        securityType: b.security_type,
        closedOn: b.closed_on,
        amountRaisedCents: b.amount_raised_cents,
        preMoneyCents: b.pre_money_cents,
        postMoneyCents: b.post_money_cents,
        sharesIssued: b.shares_issued,
        notes: b.notes,
      },
      actorFor(principal),
    );
    if (!round) throw problems.notFound();
    return { round };
  });

  app.delete(
    '/api/v1/valuations/:id/rounds/:roundId',
    { preHandler: app.authenticate },
    async (req, reply) => {
      const principal = requirePrincipal(req);
      const { id, roundId } = req.params as { id: string; roundId: string };
      const valuation = await loadAuthorizedValuation(deps.pool, principal, id);
      requireWriteAccess(principal, valuation);
      if (!isUlid(roundId) || !(await deleteRound(deps.pool, id, roundId, actorFor(principal)))) {
        throw problems.notFound();
      }
      return reply.status(204).send();
    },
  );

  // ── Transactions ────────────────────────────────────────────────────────────
  app.get('/api/v1/valuations/:id/transactions', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    const { id } = req.params as { id: string };
    await loadAuthorizedValuation(deps.pool, principal, id);
    return { transactions: await listTransactions(deps.pool, id) };
  });

  app.post('/api/v1/valuations/:id/transactions', { preHandler: app.authenticate }, async (req, reply) => {
    const principal = requirePrincipal(req);
    const { id } = req.params as { id: string };
    const valuation = await loadAuthorizedValuation(deps.pool, principal, id);
    refuseIfRetired(valuation, 'accepting changes');
    requireWriteAccess(principal, valuation);

    const parsed = TransactionBody.safeParse(req.body);
    if (!parsed.success) throw problems.unprocessable('Invalid transaction', { errors: parsed.error.issues });
    const b = parsed.data;
    const transaction = await createTransaction(
      deps.pool,
      id,
      {
        kind: b.kind,
        occurredOn: b.occurred_on,
        shares: b.shares,
        pricePerShareCents: b.price_per_share_cents,
        counterparty: b.counterparty,
        notes: b.notes,
      },
      actorFor(principal),
    );
    return reply.status(201).send({ transaction });
  });

  app.delete(
    '/api/v1/valuations/:id/transactions/:transactionId',
    { preHandler: app.authenticate },
    async (req, reply) => {
      const principal = requirePrincipal(req);
      const { id, transactionId } = req.params as { id: string; transactionId: string };
      const valuation = await loadAuthorizedValuation(deps.pool, principal, id);
      requireWriteAccess(principal, valuation);
      if (
        !isUlid(transactionId) ||
        !(await deleteTransaction(deps.pool, id, transactionId, actorFor(principal)))
      ) {
        throw problems.notFound();
      }
      return reply.status(204).send();
    },
  );
}
