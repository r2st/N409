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

export async function recordImport(pool: pg.Pool, id: string, summary: ImportedFinancials): Promise<void> {
  await pool.query(
    `UPDATE accounting_connections
     SET last_import_at = now(), last_import_summary = $2, status = 'connected', last_error = NULL
     WHERE id = $1`,
    [id, JSON.stringify(summary)],
  );
}

export async function recordImportError(pool: pg.Pool, id: string, error: string): Promise<void> {
  await pool.query(`UPDATE accounting_connections SET status = 'error', last_error = $2 WHERE id = $1`, [
    id,
    error.slice(0, 500),
  ]);
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
