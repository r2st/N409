import type pg from 'pg';
import { withTransaction } from '../db/pool.js';
import { recordEvent, type EventActor } from '../events/record.js';

export interface CompanyProfileRow {
  valuation_id: string;
  legal_name: string | null;
  website: string | null;
  address_line1: string | null;
  address_line2: string | null;
  city: string | null;
  region: string | null;
  postal_code: string | null;
  country: string | null;
  industry: string | null;
  founded_on: string | null;
  employee_count: number | null;
  revenue_range: string | null;
  cap_table_summary: string | null;
  updated_by: string | null;
  created_at: Date;
  updated_at: Date;
}

export const PROFILE_FIELDS = [
  'legal_name',
  'website',
  'address_line1',
  'address_line2',
  'city',
  'region',
  'postal_code',
  'country',
  'industry',
  'founded_on',
  'employee_count',
  'revenue_range',
  'cap_table_summary',
] as const;
export type ProfileField = (typeof PROFILE_FIELDS)[number];

export async function findCompanyProfile(
  pool: pg.Pool,
  valuationId: string,
): Promise<CompanyProfileRow | null> {
  const { rows } = await pool.query<CompanyProfileRow>(
    `SELECT valuation_id, legal_name, website, address_line1, address_line2, city, region,
            postal_code, country, industry, founded_on::text AS founded_on, employee_count,
            revenue_range, cap_table_summary, updated_by, created_at, updated_at
     FROM company_profiles WHERE valuation_id = $1`,
    [valuationId],
  );
  return rows[0] ?? null;
}

/** Upsert — the profile row is created lazily on first save; audited. */
export async function upsertCompanyProfile(
  pool: pg.Pool,
  valuationId: string,
  fields: Partial<Record<ProfileField, unknown>>,
  actor: EventActor,
): Promise<CompanyProfileRow> {
  const present = PROFILE_FIELDS.filter((f) => f in fields);
  const insertCols = ['valuation_id', ...present, 'updated_by'];
  const values: unknown[] = [valuationId, ...present.map((f) => fields[f] ?? null), actor.actorId];
  const placeholders = values.map((_, i) => `$${i + 1}`);
  const updates = [...present, 'updated_by'].map((f) => `${f} = EXCLUDED.${f}`).concat('updated_at = now()');
  return withTransaction(pool, async (client) => {
    const { rows } = await client.query<CompanyProfileRow>(
      `INSERT INTO company_profiles (${insertCols.join(', ')})
       VALUES (${placeholders.join(', ')})
       ON CONFLICT (valuation_id) DO UPDATE SET ${updates.join(', ')}
       RETURNING valuation_id, legal_name, website, address_line1, address_line2, city, region,
                 postal_code, country, industry, founded_on::text AS founded_on, employee_count,
                 revenue_range, cap_table_summary, updated_by, created_at, updated_at`,
      values,
    );
    await recordEvent(client, {
      valuationId,
      type: 'company_profile_updated',
      actor,
      payload: { fields: present },
    });
    return rows[0]!;
  });
}
