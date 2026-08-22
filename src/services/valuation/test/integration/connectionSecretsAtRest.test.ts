import { randomBytes } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newUlid } from '@n409/shared';
import {
  findConnection,
  listConnections,
  revokeConnection,
  upsertConnection,
} from '../../src/repos/accountingConnections.js';
import {
  findConnection as findHrisConnection,
  upsertConnection as upsertHrisConnection,
} from '../../src/repos/hrisConnections.js';
import {
  findConnection as findCapTableConnection,
  upsertConnection as upsertCapTableConnection,
} from '../../src/repos/capTableConnections.js';
import {
  createWebhook,
  enabledWebhooks,
  findWebhook,
  listWebhooks,
} from '../../src/repos/partnerWebhooks.js';
import { createValuation } from '../../src/repos/valuations.js';
import { createUser } from '../../src/repos/users.js';
import { hashPassword } from '../../src/auth/password.js';
import { isDbAvailable, setupTestDb, type TestDb } from './helpers.js';

const dbUp = await isDbAvailable();

const KEY = randomBytes(32);
const ACCESS = 'live-access-token-fb31c9e2';
const REFRESH = 'live-refresh-token-77aa0d14';
const HOOK_SECRET = 'whsec-live-signing-key-5c1f';

/**
 * What the four credential columns actually contain on disk.
 *
 * The unit tests prove the envelope; this proves the wiring, and it is written
 * against the *column* rather than the repo on purpose. Every existing suite
 * over these tables passes identically whether sealing works or not, because
 * they run with no key configured and a repo that seals and then unseals is
 * indistinguishable from one that does neither. So the assertions here read the
 * raw text out of Postgres and look for the plaintext in it — the only question
 * a database dump can be asked.
 *
 * The credentials in question are not this platform's to lose: a refresh token
 * here is a standing grant to read a client company's ledger or payroll, and
 * `partner_webhooks.secret` is the HMAC key a partner authenticates our
 * deliveries with.
 */
describe.skipIf(!dbUp)('third-party credentials at rest', () => {
  let db: TestDb;
  let pool: pg.Pool;
  let valuationId: string;
  let partnerId: string;
  const savedKey = process.env.CONNECTION_ENCRYPTION_KEY;

  beforeAll(async () => {
    process.env.CONNECTION_ENCRYPTION_KEY = KEY.toString('hex');
    db = await setupTestDb();
    pool = db.pool;
    const user = await createUser(pool, {
      email: `atrest-${newUlid().toLowerCase()}@test.example.com`,
      passwordDigest: await hashPassword('test-password-123'),
      roles: ['valuation_user'],
      partnerId: null,
    });
    valuationId = (
      await createValuation(
        pool,
        { kind: '409a', companyName: 'Sealed Co.', userId: user.id },
        { actorType: 'human', actorId: user.id, source: 'test' },
      )
    ).id;
    partnerId = newUlid();
    await pool.query('INSERT INTO partners (id, name, key) VALUES ($1, $2, $3)', [
      partnerId,
      'At Rest Partners',
      `at-rest-${partnerId.toLowerCase()}`,
    ]);
  });

  afterAll(async () => {
    if (savedKey === undefined) delete process.env.CONNECTION_ENCRYPTION_KEY;
    else process.env.CONNECTION_ENCRYPTION_KEY = savedKey;
    await db?.teardown();
  });

  /** The raw column text, straight from Postgres, with no repo in between. */
  async function rawColumns(table: string, where: string, params: unknown[]): Promise<string[]> {
    const cols = table === 'partner_webhooks' ? 'secret' : 'access_token, refresh_token';
    const { rows } = await pool.query<Record<string, string | null>>(
      `SELECT ${cols} FROM ${table} WHERE ${where}`,
      params,
    );
    return rows.flatMap((r) => Object.values(r).filter((v): v is string => v !== null));
  }

  const tokens = {
    accessToken: ACCESS,
    refreshToken: REFRESH,
    expiresAt: null,
    externalOrgId: 'org-1',
    externalOrgName: 'Sealed Co. Books',
  };

  describe('accounting connections', () => {
    it('writes neither token to the column in a form containing the plaintext', async () => {
      await upsertConnection(pool, {
        valuationId,
        provider: 'xero',
        tokens,
        connectedBy: null,
      });
      const stored = await rawColumns('accounting_connections', 'valuation_id = $1 AND provider = $2', [
        valuationId,
        'xero',
      ]);
      expect(stored).toHaveLength(2);
      for (const value of stored) {
        expect(value).not.toContain(ACCESS);
        expect(value).not.toContain(REFRESH);
        expect(value.length).toBeGreaterThan(0);
      }
    });

    it('hands the plaintext back to the caller that has to replay it', async () => {
      // The upsert's own RETURNING row, a targeted read, and a list read: all
      // three feed a provider call, so all three must be plaintext.
      const upserted = await upsertConnection(pool, {
        valuationId,
        provider: 'quickbooks',
        tokens,
        connectedBy: null,
      });
      expect(upserted.access_token).toBe(ACCESS);
      expect(upserted.refresh_token).toBe(REFRESH);

      const found = await findConnection(pool, valuationId, 'quickbooks');
      expect(found?.access_token).toBe(ACCESS);
      expect(found?.refresh_token).toBe(REFRESH);

      const listed = await listConnections(pool, valuationId);
      const qb = listed.find((c) => c.provider === 'quickbooks');
      expect(qb?.access_token).toBe(ACCESS);
      expect(qb?.refresh_token).toBe(REFRESH);
    });

    it('reads a row written before the key existed', async () => {
      // The legacy path. Nothing migrates these columns, so a connection made
      // while the key was unset has to keep working until the next reconnect.
      await pool.query(
        `INSERT INTO accounting_connections (id, valuation_id, provider, access_token, refresh_token, connected_by)
         VALUES ($1, $2, 'sage', $3, $4, NULL)`,
        [newUlid(), valuationId, 'legacy-plaintext-access', 'legacy-plaintext-refresh'],
      );
      const found = await findConnection(pool, valuationId, 'sage');
      expect(found?.access_token).toBe('legacy-plaintext-access');
      expect(found?.refresh_token).toBe('legacy-plaintext-refresh');
    });

    it('leaves a revoked row visibly empty rather than sealed-empty', async () => {
      // '' means "no credential here" and has to stay legible as that in SQL;
      // a sealed empty string is a 36-byte blob that reads like a live one.
      await upsertConnection(pool, { valuationId, provider: 'wave', tokens, connectedBy: null });
      expect(await revokeConnection(pool, valuationId, 'wave')).toBe(true);
      const { rows } = await pool.query<{ access_token: string; refresh_token: string | null }>(
        'SELECT access_token, refresh_token FROM accounting_connections WHERE valuation_id = $1 AND provider = $2',
        [valuationId, 'wave'],
      );
      expect(rows[0]?.access_token).toBe('');
      expect(rows[0]?.refresh_token).toBeNull();
      const found = await findConnection(pool, valuationId, 'wave');
      expect(found?.access_token).toBe('');
    });
  });

  describe('HRIS and cap-table connections', () => {
    it('seals the payroll provider’s tokens too', async () => {
      await upsertHrisConnection(pool, {
        valuationId,
        provider: 'gusto',
        tokens: { accessToken: ACCESS, refreshToken: REFRESH, expiresAt: null },
        connectedBy: null,
      });
      for (const value of await rawColumns('hris_connections', 'valuation_id = $1 AND provider = $2', [
        valuationId,
        'gusto',
      ])) {
        expect(value).not.toContain(ACCESS);
        expect(value).not.toContain(REFRESH);
      }
      const found = await findHrisConnection(pool, valuationId, 'gusto');
      expect(found?.access_token).toBe(ACCESS);
      expect(found?.refresh_token).toBe(REFRESH);
    });

    it('seals the cap-table provider’s tokens too', async () => {
      await upsertCapTableConnection(pool, {
        valuationId,
        provider: 'carta',
        tokens: { accessToken: ACCESS, refreshToken: REFRESH, expiresAt: null },
        connectedBy: null,
      });
      for (const value of await rawColumns('cap_table_connections', 'valuation_id = $1 AND provider = $2', [
        valuationId,
        'carta',
      ])) {
        expect(value).not.toContain(ACCESS);
        expect(value).not.toContain(REFRESH);
      }
      const found = await findCapTableConnection(pool, valuationId, 'carta');
      expect(found?.access_token).toBe(ACCESS);
      expect(found?.refresh_token).toBe(REFRESH);
    });
  });

  describe('partner webhook signing secrets', () => {
    it('seals the column but still shows the secret in the create response', async () => {
      // The create reply is the one and only time the partner sees it, so
      // sealing must not cost that.
      const created = await createWebhook(pool, {
        partnerId,
        url: 'https://hooks.example.com/n409',
        secret: HOOK_SECRET,
        events: ['valuation.completed'],
        createdBy: null,
      });
      expect(created.secret).toBe(HOOK_SECRET);
      const stored = await rawColumns('partner_webhooks', 'id = $1', [created.id]);
      expect(stored[0]).not.toContain(HOOK_SECRET);
    });

    it('gives the delivery path the plaintext HMAC key on every read', async () => {
      const created = await createWebhook(pool, {
        partnerId,
        url: 'https://hooks.example.com/n409-2',
        secret: HOOK_SECRET,
        events: ['valuation.completed'],
        createdBy: null,
      });
      expect((await findWebhook(pool, partnerId, created.id))?.secret).toBe(HOOK_SECRET);
      const listed = await listWebhooks(pool, partnerId);
      expect(listed.length).toBeGreaterThan(0);
      for (const hook of listed) expect(hook.secret).toBe(HOOK_SECRET);
      const enabled = await enabledWebhooks(pool, partnerId);
      expect(enabled.length).toBeGreaterThan(0);
      for (const hook of enabled) expect(hook.secret).toBe(HOOK_SECRET);
    });

    it('reads a webhook registered before the key existed', async () => {
      const id = newUlid();
      await pool.query(
        `INSERT INTO partner_webhooks (id, partner_id, url, secret, events, created_by)
         VALUES ($1, $2, $3, $4, $5, NULL)`,
        [
          id,
          partnerId,
          'https://hooks.example.com/legacy',
          'whsec-legacy-plaintext',
          ['valuation.completed'],
        ],
      );
      expect((await findWebhook(pool, partnerId, id))?.secret).toBe('whsec-legacy-plaintext');
    });
  });
});
