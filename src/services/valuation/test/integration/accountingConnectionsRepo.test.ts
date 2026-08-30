import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newUlid } from '@n409/shared';
import {
  findConnection,
  listConnections,
  recordImport,
  recordImportError,
  revokeConnection,
  toPublic,
  upsertConnection,
  type AccountingConnectionRow,
} from '../../src/repos/accountingConnections.js';
import type { ImportedFinancials, TokenSet } from '../../src/clients/accounting.js';
import { createValuation, clearValuationCache } from '../../src/repos/valuations.js';
import { createUser } from '../../src/repos/users.js';
import { hashPassword } from '../../src/auth/password.js';
import { isDbAvailable, setupTestDb, type TestDb } from './helpers.js';

const dbUp = await isDbAvailable();

/**
 * The accounting-connection store.
 *
 * Every row here holds a live OAuth access token for a client's accounting
 * software, so the invariants worth pinning are as much about what leaves this
 * module as about what it stores: `toPublic` is the only shape a route may
 * return, revoking must actually destroy the credential rather than flag it,
 * and a reconnect must land on the same row instead of accumulating tokens.
 */
describe.skipIf(!dbUp)('accounting connections repo', () => {
  let db: TestDb;
  let pool: pg.Pool;
  let userId: string;
  let valuationId: string;
  let otherValuationId: string;

  beforeAll(async () => {
    db = await setupTestDb();
    pool = db.pool;
    const user = await createUser(pool, {
      email: `acct-${newUlid().toLowerCase()}@test.example.com`,
      passwordDigest: await hashPassword('test-password-123'),
      roles: ['valuation_user'],
      partnerId: null,
    });
    userId = user.id;
    const actor = { actorType: 'human' as const, actorId: userId, source: 'test' };
    valuationId = (await createValuation(pool, { kind: '409a', companyName: 'Ledger Co.', userId }, actor))
      .id;
    otherValuationId = (
      await createValuation(pool, { kind: '409a', companyName: 'Other Books Ltd', userId }, actor)
    ).id;
  });
  afterAll(async () => {
    clearValuationCache();
    await db?.teardown();
  });

  const tokens = (over: Partial<TokenSet> = {}): TokenSet => ({
    accessToken: 'access-token-1',
    refreshToken: 'refresh-token-1',
    expiresAt: new Date('2030-01-01T00:00:00.000Z'),
    ...over,
  });

  const financials = (over: Partial<ImportedFinancials> = {}): ImportedFinancials =>
    ({
      currency: 'USD',
      period_start: '2025-01-01',
      period_end: '2025-12-31',
      revenue_cents: 123_456_00,
      prior_year_revenue_cents: 100_000_00,
      net_income_cents: 10_000_00,
      balance_sheet: null,
      provider: 'xero',
      ...over,
    }) as ImportedFinancials;

  /** Wipes the table between cases so `UNIQUE (valuation_id, provider)` is free. */
  const reset = () => pool.query('DELETE FROM accounting_connections');

  describe('upsertConnection', () => {
    it('stores a new connection as connected, with the org handle from the token set', async () => {
      await reset();
      const row = await upsertConnection(pool, {
        valuationId,
        provider: 'xero',
        tokens: tokens({ externalOrgId: 'tenant-1', externalOrgName: 'Ledger Co Books' }),
        connectedBy: userId,
      });

      expect(row).toMatchObject({
        valuation_id: valuationId,
        provider: 'xero',
        status: 'connected',
        access_token: 'access-token-1',
        refresh_token: 'refresh-token-1',
        external_org_id: 'tenant-1',
        external_org_name: 'Ledger Co Books',
        connected_by: userId,
        last_error: null,
        last_import_at: null,
      });
      expect(row.token_expires_at).toEqual(new Date('2030-01-01T00:00:00.000Z'));
    });

    it('prefers an explicit externalOrgId over the one the token set carried', async () => {
      await reset();
      // QuickBooks appends `realmId` to the callback; the route passes it in
      // explicitly and it must win over anything the exchange reported.
      const row = await upsertConnection(pool, {
        valuationId,
        provider: 'quickbooks',
        tokens: tokens({ externalOrgId: 'from-token' }),
        connectedBy: userId,
        externalOrgId: 'realm-9',
      });
      expect(row.external_org_id).toBe('realm-9');
    });

    it('reconnects onto the same row rather than creating a second one', async () => {
      await reset();
      const first = await upsertConnection(pool, {
        valuationId,
        provider: 'xero',
        tokens: tokens(),
        connectedBy: userId,
      });
      const second = await upsertConnection(pool, {
        valuationId,
        provider: 'xero',
        tokens: tokens({ accessToken: 'access-token-2', refreshToken: 'refresh-token-2' }),
        connectedBy: userId,
      });

      expect(second.id).toBe(first.id);
      expect(second.access_token).toBe('access-token-2');
      expect(second.refresh_token).toBe('refresh-token-2');
      expect(await listConnections(pool, valuationId)).toHaveLength(1);
    });

    it('revives an errored connection and clears the error it was carrying', async () => {
      await reset();
      const created = await upsertConnection(pool, {
        valuationId,
        provider: 'xero',
        tokens: tokens(),
        connectedBy: userId,
      });
      await recordImportError(pool, created.id, 'Xero said 401');
      expect((await findConnection(pool, valuationId, 'xero'))!.status).toBe('error');

      const revived = await upsertConnection(pool, {
        valuationId,
        provider: 'xero',
        tokens: tokens({ accessToken: 'fresh' }),
        connectedBy: userId,
      });
      expect(revived.status).toBe('connected');
      expect(revived.last_error).toBeNull();
    });

    it('revives a revoked connection with a working token', async () => {
      await reset();
      await upsertConnection(pool, {
        valuationId,
        provider: 'xero',
        tokens: tokens(),
        connectedBy: userId,
      });
      await revokeConnection(pool, valuationId, 'xero');

      const revived = await upsertConnection(pool, {
        valuationId,
        provider: 'xero',
        tokens: tokens({ accessToken: 'fresh', refreshToken: 'fresh-refresh' }),
        connectedBy: userId,
      });
      expect(revived).toMatchObject({
        status: 'connected',
        access_token: 'fresh',
        refresh_token: 'fresh-refresh',
      });
    });

    it('keeps the org identity a reconnect did not report', async () => {
      await reset();
      await upsertConnection(pool, {
        valuationId,
        provider: 'xero',
        tokens: tokens({ externalOrgId: 'tenant-1', externalOrgName: 'Ledger Co Books' }),
        connectedBy: userId,
      });
      // A refresh that reveals no tenant must not blank the one on file — the
      // COALESCE in the DO UPDATE is what keeps the import able to address it.
      const again = await upsertConnection(pool, {
        valuationId,
        provider: 'xero',
        tokens: tokens({ externalOrgId: null, externalOrgName: null }),
        connectedBy: userId,
      });
      expect(again.external_org_id).toBe('tenant-1');
      expect(again.external_org_name).toBe('Ledger Co Books');
    });

    it('accepts a null refresh token and expiry', async () => {
      await reset();
      const row = await upsertConnection(pool, {
        valuationId,
        provider: 'wave',
        tokens: { accessToken: 'a', refreshToken: null, expiresAt: null },
        connectedBy: null,
      });
      expect(row.refresh_token).toBeNull();
      expect(row.token_expires_at).toBeNull();
      expect(row.connected_by).toBeNull();
    });

    it('keeps each valuation and provider on its own row', async () => {
      await reset();
      for (const [vid, provider] of [
        [valuationId, 'xero'],
        [valuationId, 'quickbooks'],
        [otherValuationId, 'xero'],
      ] as const) {
        await upsertConnection(pool, { valuationId: vid, provider, tokens: tokens(), connectedBy: userId });
      }
      expect(await listConnections(pool, valuationId)).toHaveLength(2);
      expect(await listConnections(pool, otherValuationId)).toHaveLength(1);
    });

    it('refuses a connection for a valuation that does not exist', async () => {
      await reset();
      await expect(
        upsertConnection(pool, {
          valuationId: newUlid(),
          provider: 'xero',
          tokens: tokens(),
          connectedBy: userId,
        }),
      ).rejects.toThrow();
    });
  });

  describe('listConnections / findConnection', () => {
    it('lists only the asked-for valuation, ordered by provider', async () => {
      await reset();
      for (const provider of ['xero', 'sage', 'quickbooks'] as const) {
        await upsertConnection(pool, { valuationId, provider, tokens: tokens(), connectedBy: userId });
      }
      await upsertConnection(pool, {
        valuationId: otherValuationId,
        provider: 'wave',
        tokens: tokens(),
        connectedBy: userId,
      });

      const rows = await listConnections(pool, valuationId);
      // `ORDER BY provider` on an enum column sorts by the enum's declaration
      // order, not alphabetically — xero, quickbooks, sage.
      expect(rows.map((r) => r.provider)).toEqual(['xero', 'quickbooks', 'sage']);
    });

    it('returns an empty list for a valuation with nothing connected', async () => {
      await reset();
      expect(await listConnections(pool, valuationId)).toEqual([]);
    });

    it('finds one provider and returns null for the others', async () => {
      await reset();
      await upsertConnection(pool, {
        valuationId,
        provider: 'xero',
        tokens: tokens(),
        connectedBy: userId,
      });
      expect((await findConnection(pool, valuationId, 'xero'))!.provider).toBe('xero');
      expect(await findConnection(pool, valuationId, 'sage')).toBeNull();
      // ...and never crosses to another valuation.
      expect(await findConnection(pool, otherValuationId, 'xero')).toBeNull();
    });
  });

  describe('toPublic', () => {
    it('drops both tokens and keeps everything a client needs', async () => {
      await reset();
      const row = await upsertConnection(pool, {
        valuationId,
        provider: 'xero',
        tokens: tokens({ externalOrgName: 'Ledger Co Books' }),
        connectedBy: userId,
      });

      const view = toPublic(row);
      expect(Object.keys(view)).not.toContain('access_token');
      expect(Object.keys(view)).not.toContain('refresh_token');
      expect(JSON.stringify(view)).not.toContain('access-token-1');
      expect(JSON.stringify(view)).not.toContain('refresh-token-1');
      expect(view).toMatchObject({
        id: row.id,
        provider: 'xero',
        status: 'connected',
        external_org_name: 'Ledger Co Books',
      });
    });

    it('does not mutate the row it was handed', async () => {
      await reset();
      const row = await upsertConnection(pool, {
        valuationId,
        provider: 'xero',
        tokens: tokens(),
        connectedBy: userId,
      });
      toPublic(row);
      expect(row.access_token).toBe('access-token-1');
    });
  });

  describe('recordImport / recordImportError', () => {
    let connection: AccountingConnectionRow;

    const fresh = async (): Promise<AccountingConnectionRow> => {
      await reset();
      return upsertConnection(pool, {
        valuationId,
        provider: 'xero',
        tokens: tokens(),
        connectedBy: userId,
      });
    };

    it('stamps a successful import and stores the whole summary', async () => {
      connection = await fresh();
      const summary = financials();
      await recordImport(pool, connection.id, summary);

      const after = (await findConnection(pool, valuationId, 'xero'))!;
      expect(after.last_import_at).toBeInstanceOf(Date);
      expect(after.last_import_summary).toEqual(summary);
      expect(after.status).toBe('connected');
      expect(after.last_error).toBeNull();
    });

    it('records a failure as an errored connection without touching the token', async () => {
      connection = await fresh();
      await recordImportError(pool, connection.id, 'Xero returned 401 Unauthorized');

      const after = (await findConnection(pool, valuationId, 'xero'))!;
      expect(after.status).toBe('error');
      expect(after.last_error).toBe('Xero returned 401 Unauthorized');
      // A transient failure is not a revocation: the credential stays so a
      // retry can use it.
      expect(after.access_token).toBe('access-token-1');
    });

    it('truncates a runaway provider error to 500 characters', async () => {
      connection = await fresh();
      await recordImportError(pool, connection.id, 'x'.repeat(5_000));
      const after = (await findConnection(pool, valuationId, 'xero'))!;
      expect(after.last_error).toHaveLength(500);
    });

    it('clears a previous error when the next import succeeds', async () => {
      connection = await fresh();
      await recordImportError(pool, connection.id, 'transient');
      await recordImport(pool, connection.id, financials());

      const after = (await findConnection(pool, valuationId, 'xero'))!;
      expect(after.status).toBe('connected');
      expect(after.last_error).toBeNull();
    });

    it('is a no-op against an id that is not there', async () => {
      await fresh();
      await expect(recordImport(pool, newUlid(), financials())).resolves.toBeUndefined();
      await expect(recordImportError(pool, newUlid(), 'nope')).resolves.toBeUndefined();
    });
  });

  describe('revokeConnection', () => {
    it('destroys the stored credential rather than only flagging the row', async () => {
      await reset();
      await upsertConnection(pool, {
        valuationId,
        provider: 'xero',
        tokens: tokens(),
        connectedBy: userId,
      });

      expect(await revokeConnection(pool, valuationId, 'xero')).toBe(true);

      const after = (await findConnection(pool, valuationId, 'xero'))!;
      expect(after.status).toBe('revoked');
      // Not merely unusable — gone. A revoked row must not still be a place a
      // live access token is sitting.
      expect(after.access_token).toBe('');
      expect(after.refresh_token).toBeNull();
    });

    it('reports false when there is nothing to revoke', async () => {
      await reset();
      expect(await revokeConnection(pool, valuationId, 'xero')).toBe(false);
    });

    it('reports false on a second revoke and leaves the row alone', async () => {
      await reset();
      await upsertConnection(pool, {
        valuationId,
        provider: 'xero',
        tokens: tokens(),
        connectedBy: userId,
      });
      expect(await revokeConnection(pool, valuationId, 'xero')).toBe(true);
      expect(await revokeConnection(pool, valuationId, 'xero')).toBe(false);
    });

    it('revokes only the named provider on the named valuation', async () => {
      await reset();
      await upsertConnection(pool, {
        valuationId,
        provider: 'xero',
        tokens: tokens(),
        connectedBy: userId,
      });
      await upsertConnection(pool, {
        valuationId,
        provider: 'quickbooks',
        tokens: tokens(),
        connectedBy: userId,
      });
      await upsertConnection(pool, {
        valuationId: otherValuationId,
        provider: 'xero',
        tokens: tokens(),
        connectedBy: userId,
      });

      await revokeConnection(pool, valuationId, 'xero');

      expect((await findConnection(pool, valuationId, 'quickbooks'))!.status).toBe('connected');
      expect((await findConnection(pool, otherValuationId, 'xero'))!.status).toBe('connected');
    });

    /**
     * A revoke landing while an import is in flight.
     *
     * The scheduler and the import call are minutes apart, and "disconnect" is
     * what somebody clicks when an import is misbehaving — so the bookkeeping
     * write that follows arrives *after* the revoke. Unconditional, it put the
     * row back to `connected`, cleared `last_error` and stamped
     * `last_import_at`, over a row whose access token the revoke had already
     * blanked: the card said the integration was healthy and synced a moment
     * ago, with no credential behind it. Only `upsertConnection` — somebody
     * reconnecting with a real token — may take a connection out of `revoked`.
     */
    it('is not undone by an import that finishes after it', async () => {
      await reset();
      const conn = await upsertConnection(pool, {
        valuationId,
        provider: 'xero',
        tokens: tokens(),
        connectedBy: userId,
      });
      await revokeConnection(pool, valuationId, 'xero');

      await recordImport(pool, conn.id, financials());
      let after = (await findConnection(pool, valuationId, 'xero'))!;
      expect(after.status, 'a severed connection must not report itself connected').toBe('revoked');
      expect(after.last_import_at, 'nothing was imported for a connection with no token').toBeNull();

      // …and the same in the other direction: a provider failure belongs to a
      // connection that still exists.
      await recordImportError(pool, conn.id, 'xero said no');
      after = (await findConnection(pool, valuationId, 'xero'))!;
      expect(after.status).toBe('revoked');
      expect(after.last_error).toBeNull();
    });

    it('leaves the row listed, so the UI can offer a reconnect', async () => {
      await reset();
      await upsertConnection(pool, {
        valuationId,
        provider: 'xero',
        tokens: tokens({ externalOrgName: 'Ledger Co Books' }),
        connectedBy: userId,
      });
      await revokeConnection(pool, valuationId, 'xero');

      const rows = await listConnections(pool, valuationId);
      expect(rows).toHaveLength(1);
      // The org it was attached to survives the revoke — that is what makes the
      // reconnect prompt say which book it means.
      expect(rows[0]).toMatchObject({ status: 'revoked', external_org_name: 'Ledger Co Books' });
    });
  });
});
