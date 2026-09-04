import type pg from 'pg';
import { TtlCache } from '@n409/shared';
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

/**
 * `domain/branding.publicPartnerName`, for a query that joins `partners`.
 *
 * The client-facing sends resolve the firm's name inside SQL — a campaign scan
 * reads one row per candidate and a state change reads the partner beside its
 * templates — so the rule has to exist in both languages. Both spellings are
 * held together by `partnerNameCensus`.
 *
 * `nullif(btrim(...))` is `brand_name?.trim() ||`: a brand name of spaces is
 * not a brand name.
 */
export function publicPartnerNameSql(alias: string): string {
  return `CASE WHEN ${alias}.white_label_enabled
               THEN coalesce(nullif(btrim(${alias}.brand_name), ''), ${alias}.name)
               ELSE ${alias}.name END`;
}

/** What `GET /api/partner/v1/me` reports about the organisation behind a key. */
export interface PartnerIdentity {
  id: string;
  name: string;
  key: string;
  white_label_enabled: boolean;
  created_at: Date;
}

/**
 * The partner behind an API key, for the `/me` endpoint.
 *
 * Deliberately not `findBrandingByPartnerId` with extra columns: that read runs
 * on every page load and its column list is tuned for it, while this one runs
 * once per integration and wants `key` (which a partner reconciles against
 * their own records) and `white_label_enabled` (which decides what their
 * report PDFs look like) and nothing else branding-shaped.
 *
 * Archived partners resolve to null, the same rule the branding reads use — a
 * key belonging to a closed firm should stop identifying it, not go on
 * describing an organisation that no longer exists.
 */
export async function findPartnerIdentity(pool: pg.Pool, id: string): Promise<PartnerIdentity | null> {
  const { rows } = await pool.query<PartnerIdentity>(
    `SELECT id, name, key, white_label_enabled, created_at
     FROM partners WHERE id = $1 AND archived_at IS NULL`,
    [id],
  );
  return rows[0] ?? null;
}

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

/* ── The read-through cache the three resolved-branding reads share ──────────
 *
 * Lives here rather than in `routes/branding.ts`, where it was, because the
 * table has two writers and the cache could only be reached from one of them.
 *
 * `PATCH /api/v1/branding` (the firm's own editor, `updateBranding` above) held
 * the cache in its route closure and invalidated correctly. `PATCH
 * /api/v1/partners/:id` — the ops console's partner form, `updatePartner` in
 * repos/adminUsers.ts — writes `name`, `brand_color`, `logo_url`, `subdomain`
 * and `archived_at` on the same rows and could not invalidate anything, because
 * the cache was not a thing another module could name. Every one of those
 * columns changes what these reads answer:
 *
 *   * `name` is what `publicPartnerName` resolves to whenever white label is
 *     off or `brand_name` is blank — which is most tenants — so a firm renamed
 *     in the console kept its old name on every branded surface.
 *   * `brand_color` and `logo_url` are the brand itself, and they are in
 *     `BRANDING_COLUMNS`: the console writes the same two columns the firm's
 *     own editor does, through a different door.
 *   * `archived_at` is the whole resolution rule — all three reads are `AND
 *     archived_at IS NULL` — so a closed firm went on branding the login page
 *     at its own address after it was closed.
 *   * `subdomain` moves which address resolves to the tenant at all.
 *
 * Sixty seconds of it, so it heals; the point is that the administrator
 * watching for the change is told the write did not take. Same shape as the
 * valuation row cache: the TTL is the ceiling on staleness for a writer nobody
 * wired up, and the invalidation is what makes it correct.
 */
const BRANDING_CACHE_TTL_MS = 60_000;

const brandingCache = new TtlCache<BrandingSource | null>({ ttlMs: BRANDING_CACHE_TTL_MS });

/**
 * The tag every cached entry carries: the partner it resolved to.
 *
 * Derived from the loaded row rather than from the key. The same tenant is
 * cached under three unrelated keys — `key:<slug>`, `subdomain:<label>`,
 * `partner:<id>` — and only the row knows they are the same tenant, so a write
 * names the partner it wrote and never has to know how many ways that partner
 * is filed. A miss cached as `null` carries no tag, because there is no tenant
 * for it to belong to; those are dropped by key — see {@link invalidateBranding}.
 */
const brandingTags = (row: BrandingSource | null): readonly string[] | undefined =>
  row?.id ? [`partner:${row.id}`] : undefined;

/** Cached {@link findBrandingByKey}, for the signed-out login page. */
export async function loadBrandingByKey(pool: pg.Pool, key: string): Promise<BrandingSource | null> {
  return brandingCache.getOrLoad(`key:${key}`, () => findBrandingByKey(pool, key), brandingTags);
}

/** Cached {@link findBrandingBySubdomain}, for a white-label tenant address. */
export async function loadBrandingBySubdomain(
  pool: pg.Pool,
  subdomain: string,
): Promise<BrandingSource | null> {
  return brandingCache.getOrLoad(
    `subdomain:${subdomain}`,
    () => findBrandingBySubdomain(pool, subdomain),
    brandingTags,
  );
}

/** Cached {@link findBrandingByPartnerId}, for the signed-in tenant's brand. */
export async function loadBrandingByPartnerId(
  pool: pg.Pool,
  partnerId: string,
): Promise<BrandingSource | null> {
  return brandingCache.getOrLoad(
    `partner:${partnerId}`,
    () => findBrandingByPartnerId(pool, partnerId),
    brandingTags,
  );
}

/**
 * Drop a tenant from the branding cache. Call after any statement that writes
 * a `partners` column these reads resolve — from either writer.
 *
 * The tag drops every key the tenant is filed under, whatever that key was
 * called when it was written, so a rename needs no special handling: the entry
 * under the *old* subdomain resolved to this partner and is tagged with it.
 *
 * What the tag cannot cover is a cached `null` — an address or a slug that
 * resolved to nobody has no partner to be tagged with, and a write is exactly
 * what makes such a miss wrong. So `keys` names the slug and the label the
 * write is claiming, and they are dropped by key: a firm taking `acme`, a firm
 * already holding `acme` turning white label on, a partner created under a slug
 * somebody 404'd for a minute ago, and an archived firm reopened under both.
 */
export function invalidateBranding(
  partnerId: string,
  keys: { key?: string | null; subdomain?: string | null } = {},
): void {
  brandingCache.invalidateTag(`partner:${partnerId}`);
  if (keys.key) brandingCache.delete(`key:${keys.key}`);
  if (keys.subdomain) brandingCache.delete(`subdomain:${keys.subdomain}`);
}

/** Empties the cache. For tests. */
export function clearBrandingCache(): void {
  brandingCache.clear();
}
