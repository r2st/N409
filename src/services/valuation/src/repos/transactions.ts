import type pg from 'pg';
import { newUlid } from '@n409/shared';
import { withTransaction } from '../db/pool.js';
import { recordEvent, type EventActor } from '../events/record.js';

/**
 * Transaction & funding-round history (M4, P1 #24). Every mutation writes its
 * audit event in the same transaction, matching the valuations repo.
 */

export const TRANSACTION_KINDS = [
  'issuance',
  'secondary_sale',
  'repurchase',
  'conversion',
  'transfer',
  'other',
] as const;
export type TransactionKind = (typeof TRANSACTION_KINDS)[number];

export interface FundingRoundRow {
  id: string;
  valuation_id: string;
  name: string;
  security_type: string | null;
  closed_on: string | null;
  amount_raised_cents: string | null;
  pre_money_cents: string | null;
  post_money_cents: string | null;
  shares_issued: string | null;
  notes: string | null;
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface TransactionRow {
  id: string;
  valuation_id: string;
  kind: TransactionKind;
  occurred_on: string;
  shares: string | null;
  price_per_share_cents: string | null;
  counterparty: string | null;
  notes: string | null;
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
}

export const M4_HISTORY_EVENT_TYPES = {
  roundAdded: 'funding_round_added',
  roundUpdated: 'funding_round_updated',
  roundDeleted: 'funding_round_deleted',
  transactionAdded: 'transaction_added',
  transactionUpdated: 'transaction_updated',
  transactionDeleted: 'transaction_deleted',
} as const;

// ── Funding rounds ────────────────────────────────────────────────────────────

export async function listRounds(pool: pg.Pool, valuationId: string): Promise<FundingRoundRow[]> {
  const { rows } = await pool.query<FundingRoundRow>(
    'SELECT * FROM funding_rounds WHERE valuation_id = $1 ORDER BY closed_on NULLS LAST, created_at',
    [valuationId],
  );
  return rows;
}

export interface RoundInput {
  name: string;
  securityType?: string | null;
  closedOn?: string | null;
  amountRaisedCents?: number | null;
  preMoneyCents?: number | null;
  postMoneyCents?: number | null;
  sharesIssued?: number | null;
  notes?: string | null;
}

export async function createRound(
  pool: pg.Pool,
  valuationId: string,
  input: RoundInput,
  actor: EventActor,
): Promise<FundingRoundRow> {
  return withTransaction(pool, async (client) => {
    const { rows } = await client.query<FundingRoundRow>(
      `INSERT INTO funding_rounds
         (id, valuation_id, name, security_type, closed_on, amount_raised_cents,
          pre_money_cents, post_money_cents, shares_issued, notes, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING *`,
      [
        newUlid(),
        valuationId,
        input.name,
        input.securityType ?? null,
        input.closedOn ?? null,
        input.amountRaisedCents ?? null,
        input.preMoneyCents ?? null,
        input.postMoneyCents ?? null,
        input.sharesIssued ?? null,
        input.notes ?? null,
        actor.actorId ?? null,
      ],
    );
    await recordEvent(client, {
      valuationId,
      type: M4_HISTORY_EVENT_TYPES.roundAdded,
      actor,
      payload: { round_id: rows[0]!.id, name: input.name },
    });
    return rows[0]!;
  });
}

export async function updateRound(
  pool: pg.Pool,
  valuationId: string,
  roundId: string,
  input: Partial<RoundInput>,
  actor: EventActor,
): Promise<FundingRoundRow | null> {
  const mapping: Array<[keyof RoundInput, string]> = [
    ['name', 'name'],
    ['securityType', 'security_type'],
    ['closedOn', 'closed_on'],
    ['amountRaisedCents', 'amount_raised_cents'],
    ['preMoneyCents', 'pre_money_cents'],
    ['postMoneyCents', 'post_money_cents'],
    ['sharesIssued', 'shares_issued'],
    ['notes', 'notes'],
  ];
  const sets: string[] = ['updated_at = now()'];
  const params: unknown[] = [];
  for (const [key, column] of mapping) {
    if (input[key] !== undefined) {
      params.push(input[key]);
      sets.push(`${column} = $${params.length}`);
    }
  }
  return withTransaction(pool, async (client) => {
    params.push(roundId, valuationId);
    const { rows } = await client.query<FundingRoundRow>(
      `UPDATE funding_rounds SET ${sets.join(', ')}
       WHERE id = $${params.length - 1} AND valuation_id = $${params.length}
       RETURNING *`,
      params,
    );
    if (!rows[0]) return null;
    await recordEvent(client, {
      valuationId,
      type: M4_HISTORY_EVENT_TYPES.roundUpdated,
      actor,
      payload: { round_id: roundId, fields: Object.keys(input) },
    });
    return rows[0];
  });
}

export async function deleteRound(
  pool: pg.Pool,
  valuationId: string,
  roundId: string,
  actor: EventActor,
): Promise<boolean> {
  return withTransaction(pool, async (client) => {
    const res = await client.query('DELETE FROM funding_rounds WHERE id = $1 AND valuation_id = $2', [
      roundId,
      valuationId,
    ]);
    if ((res.rowCount ?? 0) === 0) return false;
    await recordEvent(client, {
      valuationId,
      type: M4_HISTORY_EVENT_TYPES.roundDeleted,
      actor,
      payload: { round_id: roundId },
    });
    return true;
  });
}

// ── Transactions ──────────────────────────────────────────────────────────────

export async function listTransactions(pool: pg.Pool, valuationId: string): Promise<TransactionRow[]> {
  const { rows } = await pool.query<TransactionRow>(
    'SELECT * FROM valuation_transactions WHERE valuation_id = $1 ORDER BY occurred_on, created_at',
    [valuationId],
  );
  return rows;
}

export interface TransactionInput {
  kind: TransactionKind;
  occurredOn: string;
  shares?: number | null;
  pricePerShareCents?: number | null;
  counterparty?: string | null;
  notes?: string | null;
}

export async function createTransaction(
  pool: pg.Pool,
  valuationId: string,
  input: TransactionInput,
  actor: EventActor,
): Promise<TransactionRow> {
  return withTransaction(pool, async (client) => {
    const { rows } = await client.query<TransactionRow>(
      `INSERT INTO valuation_transactions
         (id, valuation_id, kind, occurred_on, shares, price_per_share_cents, counterparty, notes, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [
        newUlid(),
        valuationId,
        input.kind,
        input.occurredOn,
        input.shares ?? null,
        input.pricePerShareCents ?? null,
        input.counterparty ?? null,
        input.notes ?? null,
        actor.actorId ?? null,
      ],
    );
    await recordEvent(client, {
      valuationId,
      type: M4_HISTORY_EVENT_TYPES.transactionAdded,
      actor,
      payload: { transaction_id: rows[0]!.id, kind: input.kind },
    });
    return rows[0]!;
  });
}

export async function deleteTransaction(
  pool: pg.Pool,
  valuationId: string,
  transactionId: string,
  actor: EventActor,
): Promise<boolean> {
  return withTransaction(pool, async (client) => {
    const res = await client.query('DELETE FROM valuation_transactions WHERE id = $1 AND valuation_id = $2', [
      transactionId,
      valuationId,
    ]);
    if ((res.rowCount ?? 0) === 0) return false;
    await recordEvent(client, {
      valuationId,
      type: M4_HISTORY_EVENT_TYPES.transactionDeleted,
      actor,
      payload: { transaction_id: transactionId },
    });
    return true;
  });
}
