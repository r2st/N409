import type pg from 'pg';
import { newUlid } from '@n409/shared';
import { withTransaction } from '../db/pool.js';
import {
  EVENT_TYPES,
  type ValuationKind,
  type ValuationSource,
  type ValuationState,
} from '../domain/valuation.js';
import { recordEvent, type EventActor } from '../events/record.js';
import type { ValuationScope } from '../auth/rbac.js';

export interface ValuationRow {
  id: string;
  number: string;
  workflow_id: string | null;
  kind: ValuationKind;
  state: ValuationState;
  waiting_on_client: boolean;
  company_name: string;
  service_name: string | null;
  user_id: string;
  partner_id: string | null;
  source: ValuationSource | null;
  currency: string;
  service_countries: string[];
  paid_status: 'unpaid' | 'paid' | 'paid_by_partner';
  qsbs_attestation: boolean | null;
  delivery_days: number | null;
  assigned_reviewer_id: string | null;
  created_at: Date;
  due_date: Date | null;
  published_at: Date | null;
  [key: string]: unknown;
}

export interface CreateValuationInput {
  kind: ValuationKind;
  companyName: string;
  serviceName?: string;
  userId: string;
  partnerId?: string | null;
  source?: ValuationSource;
  currency?: string;
  serviceCountries?: string[];
  gclid?: string;
}

/** Creates the aggregate root + its 1:1 params row + the birth event, atomically. */
export async function createValuation(
  pool: pg.Pool,
  input: CreateValuationInput,
  actor: EventActor,
): Promise<ValuationRow> {
  return withTransaction(pool, async (client) => {
    const id = newUlid();
    const { rows } = await client.query<ValuationRow>(
      `INSERT INTO valuations
         (id, kind, company_name, service_name, user_id, partner_id, source, currency, service_countries, gclid)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING *`,
      [
        id,
        input.kind,
        input.companyName,
        input.serviceName ?? null,
        input.userId,
        input.partnerId ?? null,
        input.source ?? null,
        input.currency ?? 'USD',
        input.serviceCountries ?? [],
        input.gclid ?? null,
      ],
    );
    await client.query('INSERT INTO valuation_params (valuation_id) VALUES ($1)', [id]);
    await recordEvent(client, {
      valuationId: id,
      type: EVENT_TYPES.created,
      actor,
      payload: { kind: input.kind, company_name: input.companyName, state: 'pending' },
    });
    return rows[0]!;
  });
}

export async function findValuationById(pool: pg.Pool, id: string): Promise<ValuationRow | null> {
  const { rows } = await pool.query<ValuationRow>('SELECT * FROM valuations WHERE id = $1', [id]);
  return rows[0] ?? null;
}

export interface ListFilters {
  state?: ValuationState;
  kind?: ValuationKind;
  page: number;
  perPage: number;
}

/** Scope is enforced in SQL, not post-filtered — partner data never leaves the DB. */
export async function listValuations(
  pool: pg.Pool,
  scope: ValuationScope,
  filters: ListFilters,
): Promise<{ items: ValuationRow[]; total: number }> {
  if (scope.kind === 'none') return { items: [], total: 0 };

  const where: string[] = [];
  const params: unknown[] = [];
  const add = (clause: string, value: unknown) => {
    params.push(value);
    where.push(clause.replace('?', `$${params.length}`));
  };

  if (scope.kind === 'partner') add('partner_id = ?', scope.partnerId);
  if (scope.kind === 'own') add('user_id = ?', scope.userId);
  if (filters.state) add('state = ?', filters.state);
  if (filters.kind) add('kind = ?', filters.kind);

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const { rows: countRows } = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM valuations ${whereSql}`,
    params,
  );

  params.push(filters.perPage, (filters.page - 1) * filters.perPage);
  const { rows } = await pool.query<ValuationRow>(
    `SELECT * FROM valuations ${whereSql}
     ORDER BY created_at DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  return { items: rows, total: Number(countRows[0]!.count) };
}

const TIMESTAMP_ON_STATE: Partial<Record<ValuationState, string>> = {
  started: 'started_at',
  user_finished: 'user_finished_at',
  completed: 'completed_at',
  drafted: 'drafted_at',
  draft_accepted: 'draft_accepted_at',
  published: 'published_at',
};

/**
 * Applies a field-level patch and writes `valuation_updated` (plus
 * `state_changed` when state moves) in the same transaction.
 */
export async function patchValuation(
  pool: pg.Pool,
  current: ValuationRow,
  fields: Record<string, unknown>,
  actor: EventActor,
): Promise<ValuationRow> {
  const entries = Object.entries(fields).filter(([k, v]) => current[k] !== v);
  if (entries.length === 0) return current;

  return withTransaction(pool, async (client) => {
    const sets: string[] = [];
    const params: unknown[] = [];
    for (const [key, value] of entries) {
      params.push(value);
      sets.push(`${key} = $${params.length}`);
    }

    const newState = fields.state as ValuationState | undefined;
    if (newState && newState !== current.state) {
      const tsColumn = TIMESTAMP_ON_STATE[newState];
      if (tsColumn) sets.push(`${tsColumn} = now()`);
    }

    params.push(current.id);
    const { rows } = await client.query<ValuationRow>(
      `UPDATE valuations SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING *`,
      params,
    );

    const changes = Object.fromEntries(entries.map(([k, v]) => [k, { from: current[k] ?? null, to: v }]));
    await recordEvent(client, {
      valuationId: current.id,
      type: EVENT_TYPES.updated,
      actor,
      payload: { changes },
    });
    if (newState && newState !== current.state) {
      await recordEvent(client, {
        valuationId: current.id,
        type: EVENT_TYPES.stateChanged,
        actor,
        payload: { from: current.state, to: newState },
      });
    }
    return rows[0]!;
  });
}
