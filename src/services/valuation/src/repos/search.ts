import type pg from 'pg';
import { isUlid } from '@n409/shared';
import { likeContains, userSearchSql } from '../db/like.js';
import type { ValuationScope } from '../auth/rbac.js';
import type { ValuationRow } from './valuations.js';

/**
 * Global search (M4, P2 #32). Matches valuations by company/service name,
 * valuation number, or exact ULID — always inside the caller's scope, in SQL.
 * User search is ops-only and lives beside it so the route returns one shape.
 */

export { escapeLike } from '../db/like.js';

/** Largest value `valuations.number` (a bigint) can hold. */
const MAX_BIGINT = 9223372036854775807n;

/**
 * The query as a valuation number, or null when it is not one.
 *
 * An all-digit query is compared against `valuations.number`, which is a
 * bigint — and in Postgres a cast that overflows is an *error*, not a
 * non-match. A query of 23 digits therefore took the entire search endpoint
 * down with a 500 (`value ... is out of range for type bigint`) instead of
 * returning the empty result it obviously has, and it took the company-name
 * matches down with it: the number clause is OR'd into the same statement, so
 * one unreachable branch failed the whole query. Anyone who pasted a long
 * digit string — an account number, a phone number, an id from another system
 * — into the search box got a broken page.
 *
 * The valuations list filter has always bounded its digit run for this reason
 * (`/^#?\d{1,12}$/`); search is the one place that never did. Bounding by the
 * column's actual range rather than a digit count keeps every number that
 * exists findable.
 */
export function valuationNumberQuery(q: string): string | null {
  if (!/^\d+$/.test(q)) return null;
  return BigInt(q) <= MAX_BIGINT ? q : null;
}

export interface UserSearchHit {
  id: string;
  email: string;
  first_name: string | null;
  last_name: string | null;
  partner_id: string | null;
}

export interface DocumentSearchHit {
  id: string;
  valuation_id: string;
  filename: string;
  kind: string;
  category: string | null;
  content_type: string;
  size_bytes: string;
  created_at: Date;
  /** Denormalized so a hit is identifiable without a second round trip. */
  company_name: string;
  valuation_number: string;
}

/**
 * The scope predicate every search shares, as SQL against a `valuations` row.
 *
 * `searchValuations` builds this inline against the table's own columns;
 * document search needs the same rule applied to the *joined* valuation, so
 * the clause is written once here and qualified with the caller's alias.
 * Keeping one source for the rule is what stops the two endpoints drifting
 * into different answers about who can see what.
 */
function scopeClause(
  scope: Exclude<ValuationScope, { kind: 'none' }>,
  alias: string,
  params: unknown[],
): string | null {
  if (scope.kind === 'partner') {
    params.push(scope.partnerId);
    return `${alias}.partner_id = $${params.length}`;
  }
  if (scope.kind === 'own') {
    params.push(scope.userId);
    return `${alias}.user_id = $${params.length}`;
  }
  return null;
}

export async function searchValuations(
  pool: pg.Pool,
  scope: ValuationScope,
  q: string,
  limit = 10,
): Promise<ValuationRow[]> {
  if (scope.kind === 'none') return [];

  const where: string[] = [];
  const params: unknown[] = [];
  const scoped = scopeClause(scope, 'valuations', params);
  if (scoped) where.push(scoped);

  const matches: string[] = [];
  const contains = likeContains(q);
  params.push(contains);
  matches.push(`company_name ILIKE $${params.length}`);
  params.push(contains);
  matches.push(`service_name ILIKE $${params.length}`);
  const asNumber = valuationNumberQuery(q);
  if (asNumber !== null) {
    params.push(asNumber);
    matches.push(`number = $${params.length}::bigint`);
  }
  if (isUlid(q.toUpperCase())) {
    params.push(q.toUpperCase());
    matches.push(`id = $${params.length}`);
  }
  where.push(`(${matches.join(' OR ')})`);

  params.push(limit);
  const { rows } = await pool.query<ValuationRow>(
    `SELECT * FROM valuations WHERE ${where.join(' AND ')}
     ORDER BY created_at DESC LIMIT $${params.length}`,
    params,
  );
  return rows;
}

/**
 * Documents by filename, or by exact document id.
 *
 * Uploads were the one thing the search box could not find. A 409A engagement
 * accumulates dozens of them — cap tables, option ledgers, board consents,
 * audited financials — and the only way to reach one was to remember which
 * valuation it hung off and page through that valuation's documents tab. The
 * filename is what anybody actually remembers, so it is what this matches.
 *
 * Scope is enforced on the *joined valuation*, not on the document: documents
 * carry no owner of their own, so the row's visibility is entirely inherited
 * from the valuation it belongs to. Doing the join in SQL rather than
 * filtering in JS is what keeps a partner from seeing another partner's
 * filenames, which leak deal names even when the bytes stay unreachable.
 *
 * Soft-deleted rows are excluded — a deleted upload is deleted, and the
 * partial index on `documents (valuation_id) WHERE deleted_at IS NULL` already
 * reflects that this is the only interesting slice.
 */
export async function searchDocuments(
  pool: pg.Pool,
  scope: ValuationScope,
  q: string,
  limit = 10,
): Promise<DocumentSearchHit[]> {
  if (scope.kind === 'none') return [];

  const params: unknown[] = [];
  const where: string[] = ['d.deleted_at IS NULL'];
  const scoped = scopeClause(scope, 'v', params);
  if (scoped) where.push(scoped);

  const matches: string[] = [];
  params.push(likeContains(q));
  matches.push(`d.filename ILIKE $${params.length}`);
  if (isUlid(q.toUpperCase())) {
    params.push(q.toUpperCase());
    matches.push(`d.id = $${params.length}`);
  }
  where.push(`(${matches.join(' OR ')})`);

  params.push(limit);
  const { rows } = await pool.query<DocumentSearchHit>(
    `SELECT d.id, d.valuation_id, d.filename, d.kind::text AS kind, d.category::text AS category,
            d.content_type, d.size_bytes::text AS size_bytes, d.created_at,
            v.company_name, v.number::text AS valuation_number
       FROM documents d
       JOIN valuations v ON v.id = d.valuation_id
      WHERE ${where.join(' AND ')}
      ORDER BY d.created_at DESC
      LIMIT $${params.length}`,
    params,
  );
  return rows;
}

export async function searchUsers(pool: pg.Pool, q: string, limit = 10): Promise<UserSearchHit[]> {
  const { rows } = await pool.query<UserSearchHit>(
    `SELECT id, email, first_name, last_name, partner_id FROM users
     WHERE ${userSearchSql('$1')}
        ${isUlid(q.toUpperCase()) ? 'OR id = $3' : ''}
     ORDER BY created_at DESC LIMIT $2`,
    isUlid(q.toUpperCase()) ? [likeContains(q), limit, q.toUpperCase()] : [likeContains(q), limit],
  );
  return rows;
}
