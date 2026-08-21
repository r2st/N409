import type pg from 'pg';
import { problems } from '@n409/shared';
import { withTransaction } from '../db/pool.js';
import { diffRecords } from '../domain/auditTrail.js';
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

/**
 * Upsert — the profile row is created lazily on first save; audited.
 *
 * The audit event records the fields that *moved*, with their before and after
 * values, and not the fields the caller sent. Those used to be the same list,
 * because the Company tab sends all sixteen columns on every save: an analyst
 * correcting a postcode produced `company_profile_updated` naming legal name,
 * website, industry, description, SIC, NAICS and ten more, none of which had
 * changed and none of which carried a value. Every save looked identical, so
 * the trail could answer "somebody saved the profile" and nothing else — not
 * which field, not what it had been, and in particular not whether the
 * description on the page was written by the analyst or drafted by the agent.
 * That is the one question the audit trail exists to answer about a row three
 * different parties can write.
 *
 * A save that moves nothing therefore writes nothing: no row, no event, no
 * version. `patchValuation` takes the same line, and here it matters twice
 * over — a no-op save that burned a version would conflict a colleague's open
 * form over a click that changed nothing.
 */
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
    // Read under the lock, because the diff has to be against the row that is
    // really there rather than against the one the caller last saw. A stale
    // snapshot produces a change list describing a transition that did not
    // happen — the same trap `patchParams` documents at length.
    const { rows: locked } = await client.query<CompanyProfileRow>(
      `SELECT ${RETURNING} FROM company_profiles WHERE valuation_id = $1 FOR UPDATE`,
      [valuationId],
    );
    const before = locked[0];

    if (expectedVersion !== undefined && before?.version !== expectedVersion) {
      // No row at all reads as a conflict too, and deliberately: to the caller
      // holding version 4, "there is no profile" and "the profile is not the
      // one you read" are the same problem with the same fix. A guarded save is
      // an UPDATE and never an INSERT — the GET returns `profile: null` and no
      // ETag until the first save, so a version for a row nobody has written is
      // not a state an honest client can reach.
      staleProfileWrite(before?.version, expectedVersion);
    }

    // A row that does not exist yet is every column at null, not an empty
    // object. `diffRecords` compares with `===`, so diffing against `{}` reads
    // `undefined !== null` and reports the blank fields of a first save as
    // changes — `cap_table_summary: null → null` in the trail, which is not an
    // edit anybody made.
    const baseline: Record<string, unknown> =
      (before as unknown as Record<string, unknown> | undefined) ??
      Object.fromEntries(PROFILE_FIELDS.map((f) => [f, null]));
    const changes = diffRecords(baseline, fields as Record<string, unknown>, present);
    // Nothing to write, so nothing to record and nothing to invalidate.
    if (before && Object.keys(changes).length === 0) return before;

    // Only the columns that moved. Writing back the unchanged fifteen would be
    // harmless to the row and misleading in `updated_at`, and it is the habit
    // that made the event above meaningless in the first place.
    const moved = present.filter((f) => f in changes);
    let row: CompanyProfileRow | undefined;
    if (before) {
      const sets = [...moved, 'updated_by'].map((f, i) => `${f} = $${i + 2}`);
      sets.push('updated_at = now()', 'version = version + 1');
      const values: unknown[] = [valuationId, ...moved.map((f) => fields[f] ?? null), actor.actorId];
      const { rows } = await client.query<CompanyProfileRow>(
        `UPDATE company_profiles SET ${sets.join(', ')}
         WHERE valuation_id = $1
         RETURNING ${RETURNING}`,
        values,
      );
      row = rows[0];
    } else {
      // First save. `FOR UPDATE` locks no row that does not exist, so a
      // concurrent first save is still possible and `ON CONFLICT` is what
      // settles it — the loser updates rather than raising a unique violation.
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
    }

    await recordEvent(client, {
      valuationId,
      type: 'company_profile_updated',
      actor,
      // `fields` alongside `changes` because the audit reader understands both
      // and the older events on this engagement carry only the former; keeping
      // the key means one row's history does not change shape mid-way.
      payload: { changes, fields: moved.length > 0 ? moved : present },
    });
    return row!;
  });
}
