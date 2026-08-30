import type pg from 'pg';
import { newUlid } from '@n409/shared';
import { openConnectionTokens, sealNullable, sealSecret } from '../crypto/connectionSecrets.js';
import type { AccountingProvider, ImportedFinancials, TokenSet } from '../clients/accounting.js';

export interface AccountingConnectionRow {
  id: string;
  valuation_id: string;
  provider: AccountingProvider;
  status: 'connected' | 'error' | 'revoked';
  external_org_id: string | null;
  external_org_name: string | null;
  access_token: string;
  refresh_token: string | null;
  token_expires_at: Date | null;
  connected_by: string | null;
  connected_at: Date;
  last_import_at: Date | null;
  last_import_summary: ImportedFinancials | null;
  last_error: string | null;
}

/** Everything the client may see — tokens never leave the server. */
export type PublicConnection = Omit<AccountingConnectionRow, 'access_token' | 'refresh_token'>;

export function toPublic(row: AccountingConnectionRow): PublicConnection {
  const { access_token: _a, refresh_token: _r, ...rest } = row;
  return rest;
}

export async function listConnections(
  pool: pg.Pool,
  valuationId: string,
): Promise<AccountingConnectionRow[]> {
  const { rows } = await pool.query<AccountingConnectionRow>(
    'SELECT * FROM accounting_connections WHERE valuation_id = $1 ORDER BY provider',
    [valuationId],
  );
  return rows.map((r) => openConnectionTokens(r));
}

export async function findConnection(
  pool: pg.Pool,
  valuationId: string,
  provider: AccountingProvider,
): Promise<AccountingConnectionRow | null> {
  const { rows } = await pool.query<AccountingConnectionRow>(
    'SELECT * FROM accounting_connections WHERE valuation_id = $1 AND provider = $2',
    [valuationId, provider],
  );
  return rows[0] ? openConnectionTokens(rows[0]) : null;
}

/** Reconnecting replaces tokens and revives a revoked/errored connection. */
export async function upsertConnection(
  pool: pg.Pool,
  input: {
    valuationId: string;
    provider: AccountingProvider;
    tokens: TokenSet;
    connectedBy: string | null;
    externalOrgId?: string | null;
  },
): Promise<AccountingConnectionRow> {
  const { rows } = await pool.query<AccountingConnectionRow>(
    `INSERT INTO accounting_connections
       (id, valuation_id, provider, access_token, refresh_token, token_expires_at,
        external_org_id, external_org_name, connected_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (valuation_id, provider) DO UPDATE SET
       status = 'connected',
       access_token = EXCLUDED.access_token,
       refresh_token = EXCLUDED.refresh_token,
       token_expires_at = EXCLUDED.token_expires_at,
       external_org_id = COALESCE(EXCLUDED.external_org_id, accounting_connections.external_org_id),
       external_org_name = COALESCE(EXCLUDED.external_org_name, accounting_connections.external_org_name),
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
      input.externalOrgId ?? input.tokens.externalOrgId ?? null,
      input.tokens.externalOrgName ?? null,
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
export async function recordImport(pool: pg.Pool, id: string, summary: ImportedFinancials): Promise<void> {
  await pool.query(
    `UPDATE accounting_connections
     SET last_import_at = now(), last_import_summary = $2, status = 'connected', last_error = NULL
     WHERE id = $1 AND status <> 'revoked'`,
    [id, JSON.stringify(summary)],
  );
}

export async function recordImportError(pool: pg.Pool, id: string, error: string): Promise<void> {
  await pool.query(
    `UPDATE accounting_connections SET status = 'error', last_error = $2
     WHERE id = $1 AND status <> 'revoked'`,
    [id, error.slice(0, 500)],
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
    `UPDATE accounting_connections
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
  provider: AccountingProvider,
): Promise<boolean> {
  const { rowCount } = await pool.query(
    `UPDATE accounting_connections
     SET status = 'revoked', access_token = '', refresh_token = NULL
     WHERE valuation_id = $1 AND provider = $2 AND status <> 'revoked'`,
    [valuationId, provider],
  );
  return (rowCount ?? 0) > 0;
}
