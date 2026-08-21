import type pg from 'pg';
import { problems } from '@n409/shared';
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
  /** Migration 0151 — the three fields the company-profile agent fills. */
  business_description: string | null;
  sic_code: string | null;
  naics_code: string | null;
  founded_on: string | null;
  employee_count: number | null;
  revenue_range: string | null;
  cap_table_summary: string | null;
  updated_by: string | null;
  /** Optimistic-lock counter — migration 0166. Moves on every write. */
  version: number;
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
  'business_description',
  'sic_code',
  'naics_code',
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
            postal_code, country, industry, business_description, sic_code, naics_code,
            founded_on::text AS founded_on, employee_count,
            revenue_range, cap_table_summary, updated_by, version, created_at, updated_at
     FROM company_profiles WHERE valuation_id = $1`,
    [valuationId],
  );
  return rows[0] ?? null;
}

const RETURNING = `valuation_id, legal_name, website, address_line1, address_line2, city, region,
                   postal_code, country, industry, business_description, sic_code, naics_code,
                   founded_on::text AS founded_on, employee_count,
                   revenue_range, cap_table_summary, updated_by, version, created_at, updated_at`;

/** Refused write: the row moved between the caller's read and this UPDATE. */
function staleProfileWrite(current: number | undefined, expected: number): never {
  throw problems.conflict(
    `This company profile was changed by someone else (expected version ${expected}, ` +
      `now ${current ?? 'unknown'}). Reload and reapply your changes.`,
  );
}

export interface UpsertProfileOptions {
  /**
   * The `version` the caller believes it is overwriting, from `If-Match`.
   *
   * The Company tab posts all sixteen columns on every save, from a snapshot it
   * took when the tab mounted, so a save built on a stale read does not lose to
   * the concurrent writer — it silently reverts them. The concurrent writer is
   * not hypothetical: the `company_profile` agent writes three of those columns
   * through this same function, and the client can edit the profile from the
   * portal while ops has it open (migration 0166).
   *
   * Omitted by the agent's own apply, which is writing what it just derived
   * rather than a form somebody has been looking at, and by any client that
   * has no opinion — which keeps the old last-write-wins behaviour.
   */
  expectedVersion?: number;
}

/** Upsert — the profile row is created lazily on first save; audited. */
export async function upsertCompanyProfile(
  pool: pg.Pool,
  valuationId: string,
  fields: Partial<Record<ProfileField, unknown>>,
  actor: EventActor,
  options: UpsertProfileOptions = {},
): Promise<CompanyProfileRow> {
  const { expectedVersion } = options;
  const present = PROFILE_FIELDS.filter((f) => f in fields);
  return withTransaction(pool, async (client) => {
    let row: CompanyProfileRow | undefined;
    if (expectedVersion === undefined) {
      const insertCols = ['valuation_id', ...present, 'updated_by'];
      const values: unknown[] = [valuationId, ...present.map((f) => fields[f] ?? null), actor.actorId];
      const placeholders = values.map((_, i) => `$${i + 1}`);
      const updates = [...present, 'updated_by']
        .map((f) => `${f} = EXCLUDED.${f}`)
        .concat('updated_at = now()', 'version = company_profiles.version + 1');
      const { rows } = await client.query<CompanyProfileRow>(
        `INSERT INTO company_profiles (${insertCols.join(', ')})
         VALUES (${placeholders.join(', ')})
         ON CONFLICT (valuation_id) DO UPDATE SET ${updates.join(', ')}
         RETURNING ${RETURNING}`,
        values,
      );
      row = rows[0];
    } else {
      // A guarded save is an UPDATE and never an INSERT. Holding a version for
      // a row that does not exist is not a state a client can honestly reach —
      // the GET returns `profile: null` and no ETag until the first save — so
      // treating it as "insert at version 1" would invent agreement out of a
      // claim about a row nobody has ever written.
      const sets = [...present, 'updated_by'].map((f, i) => `${f} = $${i + 2}`);
      sets.push('updated_at = now()', 'version = version + 1');
      const values: unknown[] = [
        valuationId,
        ...present.map((f) => fields[f] ?? null),
        actor.actorId,
        expectedVersion,
      ];
      const { rows } = await client.query<CompanyProfileRow>(
        `UPDATE company_profiles SET ${sets.join(', ')}
         WHERE valuation_id = $1 AND version = $${values.length}
         RETURNING ${RETURNING}`,
        values,
      );
      row = rows[0];
      if (!row) {
        const { rows: live } = await client.query<{ version: number }>(
          'SELECT version FROM company_profiles WHERE valuation_id = $1',
          [valuationId],
        );
        // No row at all reads as a conflict too, and deliberately: to the
        // caller holding version 4, "there is no profile" and "the profile is
        // not the one you read" are the same problem with the same fix.
        staleProfileWrite(live[0]?.version, expectedVersion);
      }
    }
    await recordEvent(client, {
      valuationId,
      type: 'company_profile_updated',
      actor,
      payload: { fields: present },
    });
    return row!;
  });
}
