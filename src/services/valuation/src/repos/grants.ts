import type pg from 'pg';
import { newUlid } from '@n409/shared';
import { withTransaction } from '../db/pool.js';
import { calendarDateRow } from '../domain/calendarDate.js';
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

/**
 * `grant_date` and `vesting_start_date` are `date` columns the interface above
 * declares `string`, and the grants routes send the row as it stands. See
 * domain/calendarDate.ts. The vesting schedule is built from these two, so a
 * row that leaves as an instant moves every tranche with it.
 */
const hydrated = (row: GrantRow): GrantRow => calendarDateRow(row, 'grant_date', 'vesting_start_date');

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
    return hydrated(rows[0]!);
  });
}

/**
 * The cap on one valuation's option grants.
 *
 * Set an order of magnitude above any real cap table — the largest private
 * companies this platform values have low thousands of live grants — because
 * this list is not only a screen. The auditor workbook builds a sheet from it,
 * and a deliverable that silently omits grants is worse than one that refuses
 * to build, so the export checks `truncated` and refuses rather than shipping
 * a short one. What the cap actually guards against is the HRIS import: a
 * misconfigured connector replaying its whole population into one engagement
 * had no ceiling at all before this.
 */
export const GRANT_PAGE_LIMIT = 10_000;

export async function listGrants(
  pool: pg.Pool,
  valuationId: string,
  opts: { limit?: number } = {},
): Promise<{ grants: GrantRow[]; truncated: boolean }> {
  const limit = Math.min(Math.max(opts.limit ?? GRANT_PAGE_LIMIT, 1), GRANT_PAGE_LIMIT);
  const { rows } = await pool.query<GrantRow>(
    `SELECT * FROM option_grants
      WHERE valuation_id = $1
      ORDER BY grant_date DESC, created_at DESC
      LIMIT $2`,
    [valuationId, limit + 1],
  );
  return { grants: rows.slice(0, limit).map(hydrated), truncated: rows.length > limit };
}

export async function findGrantById(pool: pg.Pool, id: string): Promise<GrantRow | null> {
  const { rows } = await pool.query<GrantRow>('SELECT * FROM option_grants WHERE id = $1', [id]);
  return rows[0] ? hydrated(rows[0]) : null;
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
    return hydrated(rows[0]!);
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
    return hydrated(rows[0]!);
  });
}
