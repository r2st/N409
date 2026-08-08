import type pg from 'pg';
import type { BrandingPatch, BrandingSource } from '../domain/branding.js';

/**
 * Branding reads and writes against `partners` (migration 0091).
 *
 * Kept apart from repos/adminUsers.ts, which owns partners as an ops
 * administration object (create, archive, count users). This module owns the
 * same table as a *tenant identity*, read on every page load by everyone and
 * written by the firm itself.
 */

const BRANDING_COLUMNS = `id, name, subdomain, brand_name, brand_tagline, brand_color, accent_color_dark,
                          logo_url, logo_dark_url, favicon_url, support_email, white_label_enabled`;

export async function findBrandingByPartnerId(
  pool: pg.Pool,
  partnerId: string,
): Promise<BrandingSource | null> {
  const { rows } = await pool.query<BrandingSource>(
    `SELECT ${BRANDING_COLUMNS} FROM partners WHERE id = $1 AND archived_at IS NULL`,
    [partnerId],
  );
  return rows[0] ?? null;
}

/**
 * Slug lookup for the signed-out login page. Archived channels resolve to null
 * so a closed firm's brand stops being served the moment it is archived.
 */
export async function findBrandingByKey(pool: pg.Pool, key: string): Promise<BrandingSource | null> {
  const { rows } = await pool.query<BrandingSource>(
    `SELECT ${BRANDING_COLUMNS} FROM partners WHERE key = $1 AND archived_at IS NULL`,
    [key],
  );
  return rows[0] ?? null;
}

/**
 * Host lookup for a white-label tenant address (migration 0106).
 *
 * Only a tenant that has actually turned white label on resolves here. A firm
 * that reserved a subdomain but has not gone live would otherwise serve
 * platform branding on its own address, which reads as a misconfiguration
 * rather than as "not launched yet" — and the caller falls back to platform
 * branding on null anyway, so the outcome is identical without the confusion of
 * a half-claimed host.
 */
export async function findBrandingBySubdomain(
  pool: pg.Pool,
  subdomain: string,
): Promise<BrandingSource | null> {
  const { rows } = await pool.query<BrandingSource>(
    `SELECT ${BRANDING_COLUMNS} FROM partners
      WHERE subdomain = $1 AND archived_at IS NULL AND white_label_enabled`,
    [subdomain],
  );
  return rows[0] ?? null;
}

/**
 * Applies a validated patch. The column allow-list is repeated here rather than
 * spread from the input: this layer builds SQL identifiers, so it cannot trust
 * that every future caller validated its object first.
 */
const WRITABLE_COLUMNS = [
  'subdomain',
  'brand_name',
  'brand_tagline',
  'brand_color',
  'accent_color_dark',
  'logo_url',
  'logo_dark_url',
  'favicon_url',
  'support_email',
  'white_label_enabled',
] as const satisfies readonly (keyof BrandingPatch)[];

export async function updateBranding(
  pool: pg.Pool,
  partnerId: string,
  patch: BrandingPatch,
): Promise<BrandingSource | null> {
  const sets: string[] = [];
  const params: unknown[] = [partnerId];
  for (const column of WRITABLE_COLUMNS) {
    const value = patch[column];
    if (value === undefined) continue;
    params.push(value);
    sets.push(`${column} = $${params.length}`);
  }
  if (sets.length === 0) return findBrandingByPartnerId(pool, partnerId);

  const { rows } = await pool.query<BrandingSource>(
    `UPDATE partners SET ${sets.join(', ')} WHERE id = $1 AND archived_at IS NULL
     RETURNING ${BRANDING_COLUMNS}`,
    params,
  );
  return rows[0] ?? null;
}
