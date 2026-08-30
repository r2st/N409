import type pg from 'pg';
import { newUlid } from '@n409/shared';
import { openConnectionTokens, sealNullable, sealSecret } from '../crypto/connectionSecrets.js';
import type { CapTableProvider, TokenSet } from '../clients/capTableSync.js';

export type SyncFrequency = 'manual' | 'daily' | 'weekly';

export interface CapTableConnectionRow {
  id: string;
  valuation_id: string;
  provider: CapTableProvider;
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
  /**
   * Failures since the last success. Drives the retry backoff in
   * `recordSyncError`; see migration 0194 for why a scheduled connector needs
   * one at all.
   */
  sync_failures: number;
}

export type PublicCapTableConnection = Omit<CapTableConnectionRow, 'access_token' | 'refresh_token'>;

export function toPublic(row: CapTableConnectionRow): PublicCapTableConnection {
  const { access_token: _a, refresh_token: _r, ...rest } = row;
  return rest;
}

const FREQ_INTERVAL: Record<SyncFrequency, string | null> = {
  manual: null,
  daily: '1 day',
  weekly: '7 days',
};

export async function listConnections(pool: pg.Pool, valuationId: string): Promise<CapTableConnectionRow[]> {
  const { rows } = await pool.query<CapTableConnectionRow>(
    'SELECT * FROM cap_table_connections WHERE valuation_id = $1 ORDER BY provider',
    [valuationId],
  );
  return rows.map((r) => openConnectionTokens(r));
}

export async function findConnection(
  pool: pg.Pool,
  valuationId: string,
  provider: CapTableProvider,
): Promise<CapTableConnectionRow | null> {
  const { rows } = await pool.query<CapTableConnectionRow>(
    'SELECT * FROM cap_table_connections WHERE valuation_id = $1 AND provider = $2',
    [valuationId, provider],
  );
  return rows[0] ? openConnectionTokens(rows[0]) : null;
}

export async function upsertConnection(
  pool: pg.Pool,
  input: {
    valuationId: string;
    provider: CapTableProvider;
    tokens: TokenSet;
    connectedBy: string | null;
    externalCompanyId?: string | null;
  },
): Promise<CapTableConnectionRow> {
  const { rows } = await pool.query<CapTableConnectionRow>(
    `INSERT INTO cap_table_connections
       (id, valuation_id, provider, access_token, refresh_token, token_expires_at,
        external_company_id, external_company_name, connected_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (valuation_id, provider) DO UPDATE SET
       status = 'connected',
       access_token = EXCLUDED.access_token,
       refresh_token = EXCLUDED.refresh_token,
       token_expires_at = EXCLUDED.token_expires_at,
       external_company_id = COALESCE(EXCLUDED.external_company_id, cap_table_connections.external_company_id),
       external_company_name = COALESCE(EXCLUDED.external_company_name, cap_table_connections.external_company_name),
       connected_by = EXCLUDED.connected_by,
       connected_at = now(),
       last_error = NULL,
       -- Reconnecting is what the authorisation failures ask a person to do,
       -- and what they ask it for is the schedule. A terminal failure clears
       -- the next-sync time, so a reconnect that only cleared the error would
       -- leave the cadence select reading Daily over a connection that never
       -- syncs again -- the same lie in a new place.
       sync_failures = 0,
       next_sync_at = CASE WHEN cap_table_connections.sync_frequency = 'manual' THEN NULL ELSE now() END
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

/**
 * Revocation is the end of the connection, so every bookkeeping write below is
 * conditional on it not having happened.
 *
 * `revokeConnection` blanks the stored tokens and refuses to run twice
 * (`status <> 'revoked'`), which says plainly that `revoked` is terminal — and
 * every other writer of `status` was unconditional. A revoke landing while a
 * sync or import is in flight is the ordinary case rather than an exotic one:
 * the scheduler runs on a fifteen-minute tick against provider calls measured
 * in seconds to minutes, and "disconnect" is exactly what somebody clicks when
 * a sync is misbehaving.
 *
 * What the unguarded write then did was report a connection the client had
 * just severed as `connected`, with `last_error` cleared and `last_synced_at`
 * stamped a moment ago — over a row whose access token is now the empty
 * string. The card in the product says the integration is healthy and synced;
 * the credential behind it is gone. `error` is the same untruth the other way
 * round: a provider failure attributed to a connection that no longer exists,
 * which reads as something to fix rather than something deliberately ended.
 */
/** Record a successful sync and schedule the next one per the cadence. */
export async function recordSync(
  pool: pg.Pool,
  id: string,
  summary: Record<string, unknown>,
  frequency: SyncFrequency,
): Promise<void> {
  const interval = FREQ_INTERVAL[frequency];
  await pool.query(
    `UPDATE cap_table_connections
     SET last_synced_at = now(), last_sync_summary = $2, status = 'connected', last_error = NULL,
         sync_failures = 0,
         next_sync_at = ${interval ? `now() + interval '${interval}'` : 'NULL'}
     WHERE id = $1 AND status <> 'revoked'`,
    [id, JSON.stringify(summary)],
  );
}

/**
 * Record a failed sync, and say when — if ever — to try again.
 *
 * The `status = 'error'` half is what this always did, and on its own it ended
 * the schedule: both sweeps ask for `status = 'connected'`, and nothing moved a
 * connection back. One 503 at three in the morning and the daily sync was over,
 * with the panel still showing the cadence somebody chose.
 *
 * So the failure now schedules its own retry, on a backoff that grows with the
 * number of failures since the last success — 15m, 30m, 1h, 2h, 4h, then 8h —
 * and the sweeps admit `error` rows whose time has come. Retrying on the
 * ordinary fifteen-minute tick would be the wrong answer in the other
 * direction: that is how a provider's rate limit becomes a longer rate limit.
 *
 * `terminal` is for the failure a retry cannot clear — a refresh token the
 * provider has refused, which it will refuse identically forever. Those clear
 * `next_sync_at` and wait for a person to reconnect, which is what their
 * message asks for. A connection whose cadence is `manual` also gets no time:
 * it never had one.
 */
export async function recordSyncError(
  pool: pg.Pool,
  id: string,
  error: string,
  opts: { terminal?: boolean } = {},
): Promise<void> {
  await pool.query(
    `UPDATE cap_table_connections
        SET status = 'error',
            last_error = $2,
            sync_failures = sync_failures + 1,
            next_sync_at = CASE
              WHEN $3::boolean THEN NULL
              WHEN sync_frequency = 'manual' THEN NULL
              -- Reads the pre-increment count: a first failure waits 15
              -- minutes, a sixth and every one after it waits eight hours.
              ELSE now() + interval '15 minutes' * power(2, LEAST(sync_failures, 5))
            END
      WHERE id = $1 AND status <> 'revoked'`,
    [id, error.slice(0, 500), opts.terminal ?? false],
  );
}

export async function setSyncFrequency(pool: pg.Pool, id: string, frequency: SyncFrequency): Promise<void> {
  const interval = FREQ_INTERVAL[frequency];
  await pool.query(
    `UPDATE cap_table_connections
     SET sync_frequency = $2,
         next_sync_at = ${interval ? `now() + interval '${interval}'` : 'NULL'}
     WHERE id = $1 AND status <> 'revoked'`,
    [id, frequency],
  );
}

/**
 * Store a refreshed credential.
 *
 * Guarded on `status <> 'revoked'` like every other writer on this row: a
 * revoke landing while a sync is in flight ends the connection, and writing a
 * live access token back over the blanked one would resurrect a credential the
 * client just severed.
 *
 * `refreshToken` is `undefined` when the provider did not rotate it, which is
 * the common case, and the column is then left alone — writing `null` there
 * would make that the last successful refresh this connection ever had.
 */
export async function updateTokens(
  pool: pg.Pool,
  id: string,
  tokens: { accessToken: string; refreshToken?: string | undefined; expiresAt: Date | null },
): Promise<void> {
  await pool.query(
    `UPDATE cap_table_connections
        SET access_token = $2,
            refresh_token = COALESCE($3, refresh_token),
            token_expires_at = $4
      WHERE id = $1 AND status <> 'revoked'`,
    [id, sealSecret(tokens.accessToken), sealNullable(tokens.refreshToken ?? null), tokens.expiresAt],
  );
}

export async function revokeConnection(
  pool: pg.Pool,
  valuationId: string,
  provider: CapTableProvider,
): Promise<boolean> {
  const { rowCount } = await pool.query(
    `UPDATE cap_table_connections
     SET status = 'revoked', access_token = '', refresh_token = NULL, sync_frequency = 'manual', next_sync_at = NULL
     WHERE valuation_id = $1 AND provider = $2 AND status <> 'revoked'`,
    [valuationId, provider],
  );
  return (rowCount ?? 0) > 0;
}

/**
 * Connections whose next scheduled sync is due (background scheduler).
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
export async function findDueConnections(pool: pg.Pool, limit = 25): Promise<CapTableConnectionRow[]> {
  const { rows } = await pool.query<CapTableConnectionRow>(
    `SELECT c.* FROM cap_table_connections c
       JOIN valuations v ON v.id = c.valuation_id AND v.archived_at IS NULL
     WHERE c.status IN ('connected', 'error') AND c.sync_frequency <> 'manual'
       AND c.next_sync_at IS NOT NULL AND c.next_sync_at <= now()
     ORDER BY c.next_sync_at ASC
     LIMIT $1`,
    [limit],
  );
  return rows.map((r) => openConnectionTokens(r));
}
