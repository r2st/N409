import type pg from 'pg';
import { isUlid } from '@n409/shared';
import { likeContains } from '../db/like.js';
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

export async function searchValuations(
  pool: pg.Pool,
  scope: ValuationScope,
  q: string,
  limit = 10,
): Promise<ValuationRow[]> {
  if (scope.kind === 'none') return [];

  const where: string[] = [];
  const params: unknown[] = [];
  const add = (clause: string, value: unknown) => {
    params.push(value);
    where.push(clause.replace('?', `$${params.length}`));
  };
  if (scope.kind === 'partner') add('partner_id = ?', scope.partnerId);
  if (scope.kind === 'own') add('user_id = ?', scope.userId);

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

export async function searchUsers(pool: pg.Pool, q: string, limit = 10): Promise<UserSearchHit[]> {
  const { rows } = await pool.query<UserSearchHit>(
    `SELECT id, email, first_name, last_name, partner_id FROM users
     WHERE email ILIKE $1
        OR (coalesce(first_name, '') || ' ' || coalesce(last_name, '')) ILIKE $1
        ${isUlid(q.toUpperCase()) ? 'OR id = $3' : ''}
     ORDER BY created_at DESC LIMIT $2`,
    isUlid(q.toUpperCase()) ? [likeContains(q), limit, q.toUpperCase()] : [likeContains(q), limit],
  );
  return rows;
}
