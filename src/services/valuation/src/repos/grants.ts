import type pg from 'pg';
import { newUlid } from '@n409/shared';
import { withTransaction } from '../db/pool.js';
import { recordEvent, type EventActor } from '../events/record.js';
import { GRANT_EVENT_TYPES } from '../domain/vesting.js';

export interface GrantRow {
  id: string;
  valuation_id: string;
  grantee_name: string;
  grantee_email: string | null;
  grant_date: string;
  options_count: number;
  exercise_price: string;
  currency: string;
  vesting_template: string;
  vesting_start_date: string;
  vesting_months: number;
  cliff_months: number;
  frequency_months: number;
  status: 'active' | 'cancelled';
  notes: string | null;
  created_by: string;
  created_at: Date;
  updated_at: Date;
}

export interface CreateGrantInput {
  valuationId: string;
  granteeName: string;
  granteeEmail?: string | null;
  grantDate: string;
  optionsCount: number;
  exercisePrice: number;
  currency: string;
  vestingTemplate: string;
  vestingStartDate: string;
  vestingMonths: number;
  cliffMonths: number;
  frequencyMonths: number;
  notes?: string | null;
  createdBy: string;
  /** Provenance for HRIS-imported grants (feature 11). */
  source?: string;
  externalId?: string | null;
}

export async function createGrant(
  pool: pg.Pool,
  input: CreateGrantInput,
  actor: EventActor,
): Promise<GrantRow> {
  return withTransaction(pool, async (client) => {
    const id = newUlid();
    const { rows } = await client.query<GrantRow>(
      `INSERT INTO option_grants
         (id, valuation_id, grantee_name, grantee_email, grant_date, options_count,
          exercise_price, currency, vesting_template, vesting_start_date,
          vesting_months, cliff_months, frequency_months, notes, created_by, source, external_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
       RETURNING *`,
      [
        id,
        input.valuationId,
        input.granteeName,
        input.granteeEmail ?? null,
        input.grantDate,
        input.optionsCount,
        input.exercisePrice,
        input.currency,
        input.vestingTemplate,
        input.vestingStartDate,
        input.vestingMonths,
        input.cliffMonths,
        input.frequencyMonths,
        input.notes ?? null,
        input.createdBy,
        input.source ?? 'manual',
        input.externalId ?? null,
      ],
    );
    await recordEvent(client, {
      valuationId: input.valuationId,
      type: GRANT_EVENT_TYPES.granted,
      actor,
      payload: {
        grant_id: id,
        grantee_name: input.granteeName,
        options_count: input.optionsCount,
        exercise_price: input.exercisePrice,
      },
    });
    return rows[0]!;
  });
}

export async function listGrants(pool: pg.Pool, valuationId: string): Promise<GrantRow[]> {
  const { rows } = await pool.query<GrantRow>(
    'SELECT * FROM option_grants WHERE valuation_id = $1 ORDER BY grant_date DESC, created_at DESC',
    [valuationId],
  );
  return rows;
}

export async function findGrantById(pool: pg.Pool, id: string): Promise<GrantRow | null> {
  const { rows } = await pool.query<GrantRow>('SELECT * FROM option_grants WHERE id = $1', [id]);
  return rows[0] ?? null;
}

const MUTABLE_FIELDS: Record<string, string> = {
  grantee_name: 'grantee_name',
  grantee_email: 'grantee_email',
  grant_date: 'grant_date',
  options_count: 'options_count',
  vesting_template: 'vesting_template',
  vesting_start_date: 'vesting_start_date',
  vesting_months: 'vesting_months',
  cliff_months: 'cliff_months',
  frequency_months: 'frequency_months',
  notes: 'notes',
};

export async function updateGrant(
  pool: pg.Pool,
  grant: GrantRow,
  patch: Record<string, unknown>,
  actor: EventActor,
): Promise<GrantRow> {
  const sets: string[] = [];
  const values: unknown[] = [grant.id];
  for (const [key, col] of Object.entries(MUTABLE_FIELDS)) {
    if (key in patch) {
      values.push(patch[key]);
      sets.push(`${col} = $${values.length}`);
    }
  }
  if (sets.length === 0) return grant;
  return withTransaction(pool, async (client) => {
    const { rows } = await client.query<GrantRow>(
      `UPDATE option_grants SET ${sets.join(', ')}, updated_at = now() WHERE id = $1 RETURNING *`,
      values,
    );
    await recordEvent(client, {
      valuationId: grant.valuation_id,
      type: GRANT_EVENT_TYPES.updated,
      actor,
      payload: { grant_id: grant.id, fields: Object.keys(patch) },
    });
    return rows[0]!;
  });
}

export async function cancelGrant(pool: pg.Pool, grant: GrantRow, actor: EventActor): Promise<GrantRow> {
  return withTransaction(pool, async (client) => {
    const { rows } = await client.query<GrantRow>(
      "UPDATE option_grants SET status = 'cancelled', updated_at = now() WHERE id = $1 RETURNING *",
      [grant.id],
    );
    await recordEvent(client, {
      valuationId: grant.valuation_id,
      type: GRANT_EVENT_TYPES.cancelled,
      actor,
      payload: { grant_id: grant.id },
    });
    return rows[0]!;
  });
}
