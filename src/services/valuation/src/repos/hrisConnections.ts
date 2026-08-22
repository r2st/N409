import type pg from 'pg';
import { newUlid } from '@n409/shared';
import { openConnectionTokens, sealNullable, sealSecret } from '../crypto/connectionSecrets.js';
import type { HrisProvider, TokenSet } from '../clients/hris.js';

export type SyncFrequency = 'manual' | 'daily' | 'weekly';

export interface HrisConnectionRow {
  id: string;
  valuation_id: string;
  provider: HrisProvider;
  status: 'connected' | 'error' | 'revoked';
  external_company_id: string | null;
  external_company_name: string | null;
  access_token: string;
  refresh_token: string | null;
  token_expires_at: Date | null;
  sync_frequency: SyncFrequency;
  next_sync_at: Date | null;
  connected_by: string | null;
  connected_at: Date;
  last_synced_at: Date | null;
  last_sync_summary: Record<string, unknown> | null;
  last_error: string | null;
}

export type PublicHrisConnection = Omit<HrisConnectionRow, 'access_token' | 'refresh_token'>;

export function toPublic(row: HrisConnectionRow): PublicHrisConnection {
  const { access_token: _a, refresh_token: _r, ...rest } = row;
  return rest;
}

const FREQ_INTERVAL: Record<SyncFrequency, string | null> = {
  manual: null,
  daily: '1 day',
  weekly: '7 days',
};

export async function listConnections(pool: pg.Pool, valuationId: string): Promise<HrisConnectionRow[]> {
  const { rows } = await pool.query<HrisConnectionRow>(
    'SELECT * FROM hris_connections WHERE valuation_id = $1 ORDER BY provider',
    [valuationId],
  );
  return rows.map((r) => openConnectionTokens(r));
}

export async function findConnection(
  pool: pg.Pool,
  valuationId: string,
  provider: HrisProvider,
): Promise<HrisConnectionRow | null> {
  const { rows } = await pool.query<HrisConnectionRow>(
    'SELECT * FROM hris_connections WHERE valuation_id = $1 AND provider = $2',
    [valuationId, provider],
  );
  return rows[0] ? openConnectionTokens(rows[0]) : null;
}

export async function upsertConnection(
  pool: pg.Pool,
  input: {
    valuationId: string;
    provider: HrisProvider;
    tokens: TokenSet;
    connectedBy: string | null;
    externalCompanyId?: string | null;
  },
): Promise<HrisConnectionRow> {
  const { rows } = await pool.query<HrisConnectionRow>(
    `INSERT INTO hris_connections
       (id, valuation_id, provider, access_token, refresh_token, token_expires_at,
        external_company_id, external_company_name, connected_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (valuation_id, provider) DO UPDATE SET
       status = 'connected',
       access_token = EXCLUDED.access_token,
       refresh_token = EXCLUDED.refresh_token,
       token_expires_at = EXCLUDED.token_expires_at,
       external_company_id = COALESCE(EXCLUDED.external_company_id, hris_connections.external_company_id),
       external_company_name = COALESCE(EXCLUDED.external_company_name, hris_connections.external_company_name),
       connected_by = EXCLUDED.connected_by,
       connected_at = now(),
       last_error = NULL
     RETURNING *`,
    [
      newUlid(),
      input.valuationId,
      input.provider,
      sealSecret(input.tokens.accessToken),
      sealNullable(input.tokens.refreshToken),
      input.tokens.expiresAt,
      input.externalCompanyId ?? input.tokens.externalCompanyId ?? null,
      input.tokens.externalCompanyName ?? null,
      input.connectedBy,
    ],
  );
  return openConnectionTokens(rows[0]!);
}

export async function recordSync(
  pool: pg.Pool,
  id: string,
  summary: Record<string, unknown>,
  frequency: SyncFrequency,
): Promise<void> {
  const interval = FREQ_INTERVAL[frequency];
  await pool.query(
    `UPDATE hris_connections
     SET last_synced_at = now(), last_sync_summary = $2, status = 'connected', last_error = NULL,
         next_sync_at = ${interval ? `now() + interval '${interval}'` : 'NULL'}
     WHERE id = $1`,
    [id, JSON.stringify(summary)],
  );
}

export async function recordSyncError(pool: pg.Pool, id: string, error: string): Promise<void> {
  await pool.query(`UPDATE hris_connections SET status = 'error', last_error = $2 WHERE id = $1`, [
    id,
    error.slice(0, 500),
  ]);
}

export async function setSyncFrequency(pool: pg.Pool, id: string, frequency: SyncFrequency): Promise<void> {
  const interval = FREQ_INTERVAL[frequency];
  await pool.query(
    `UPDATE hris_connections
     SET sync_frequency = $2,
         next_sync_at = ${interval ? `now() + interval '${interval}'` : 'NULL'}
     WHERE id = $1`,
    [id, frequency],
  );
}

export async function revokeConnection(
  pool: pg.Pool,
  valuationId: string,
  provider: HrisProvider,
): Promise<boolean> {
  const { rowCount } = await pool.query(
    `UPDATE hris_connections
     SET status = 'revoked', access_token = '', refresh_token = NULL, sync_frequency = 'manual', next_sync_at = NULL
     WHERE valuation_id = $1 AND provider = $2 AND status <> 'revoked'`,
    [valuationId, provider],
  );
  return (rowCount ?? 0) > 0;
}

/**
 * Connections whose next scheduled sync is due.
 *
 * WHY THE JOIN. Three of this service's timers wrote to a valuation without
 * ever asking whether the engagement still existed. R89 put a refusal on all
 * 86 mutating routes and the route beside this one has one; the *timer* that
 * performs the same write on a schedule went through no route at all. So a
 * firm could withdraw an engagement and a scheduled sync would go on pulling
 * the client's cap table from Carta and applying it — hours after every button
 * in the product had stopped accepting changes.
 *
 * Filtered here rather than checked at the apply, deliberately. Checking later
 * would still have called the provider, which means still telling a third
 * party we are working a file the firm has withdrawn; and a sweep that fetches
 * and then discards is a sweep whose cost is invisible.
 *
 * A retirement is reversible (R90), so the connection is skipped rather than
 * disabled: restore the engagement and the schedule picks up where it was.
 */
export async function findDueConnections(pool: pg.Pool, limit = 25): Promise<HrisConnectionRow[]> {
  const { rows } = await pool.query<HrisConnectionRow>(
    `SELECT c.* FROM hris_connections c
       JOIN valuations v ON v.id = c.valuation_id AND v.archived_at IS NULL
     WHERE c.status = 'connected' AND c.sync_frequency <> 'manual'
       AND next_sync_at IS NOT NULL AND next_sync_at <= now()
     ORDER BY next_sync_at ASC LIMIT $1`,
    [limit],
  );
  return rows.map((r) => openConnectionTokens(r));
}

/** External grant ids already imported for this valuation (idempotency). */
export async function existingGrantExternalIds(pool: pg.Pool, valuationId: string): Promise<Set<string>> {
  const { rows } = await pool.query<{ external_id: string }>(
    'SELECT external_id FROM option_grants WHERE valuation_id = $1 AND external_id IS NOT NULL',
    [valuationId],
  );
  return new Set(rows.map((r) => r.external_id));
}
