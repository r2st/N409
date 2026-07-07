import type pg from 'pg';
import { isUlid } from '@n409/shared';
import type { ValuationScope } from '../auth/rbac.js';
import type { ValuationRow } from './valuations.js';

/**
 * Global search (M4, P2 #32). Matches valuations by company/service name,
 * valuation number, or exact ULID — always inside the caller's scope, in SQL.
 * User search is ops-only and lives beside it so the route returns one shape.
 */

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
  params.push(`%${q}%`);
  matches.push(`company_name ILIKE $${params.length}`);
  params.push(`%${q}%`);
  matches.push(`service_name ILIKE $${params.length}`);
  if (/^\d+$/.test(q)) {
    params.push(q);
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
    isUlid(q.toUpperCase()) ? [`%${q}%`, limit, q.toUpperCase()] : [`%${q}%`, limit],
  );
  return rows;
}
