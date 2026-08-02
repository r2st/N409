import { describe, expect, it, vi } from 'vitest';
import type pg from 'pg';
import { confirmTotpEnrollment, disableTotp, regenerateBackupCodes } from '../../src/repos/mfa.js';
import { backupCodeMatches } from '../../src/auth/mfaCrypto.js';

/**
 * A pool stand-in that records every statement the repo issues, including the
 * ones inside `withTransaction` — `pool.connect()` hands back the same
 * recorder, so BEGIN/COMMIT and the transactional writes land in one list.
 */
function fakePool() {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    calls.push({ sql, params });
    return { rows: [], rowCount: 0 };
  });
  const client = { query, release: vi.fn() };
  const pool = { query, connect: vi.fn(async () => client) } as unknown as pg.Pool;
  return { pool, calls };
}

/** Statements that actually touch the backup-code table. */
const backupCodeWrites = (calls: Array<{ sql: string }>) =>
  calls.filter((c) => /INSERT INTO mfa_backup_codes/i.test(c.sql));

describe.each([
  ['confirmTotpEnrollment', confirmTotpEnrollment],
  ['regenerateBackupCodes', regenerateBackupCodes],
] as const)('%s', (_name, fn) => {
  it('writes the whole backup-code set in a single round trip', async () => {
    const { pool, calls } = fakePool();
    const codes = await fn(pool, '01USER');

    // Ten codes used to mean ten INSERTs inside the transaction.
    const inserts = backupCodeWrites(calls);
    expect(inserts).toHaveLength(1);
    expect(codes.length).toBeGreaterThan(1);
  });

  it('batches over unnest() arrays, one entry per code', async () => {
    const { pool, calls } = fakePool();
    const codes = await fn(pool, '01USER');

    const [insert] = backupCodeWrites(calls);
    expect(insert!.sql).toContain('unnest($2::ulid[], $3::text[])');

    const [userId, ids, hashes] = insert!.params as [string, string[], string[]];
    expect(userId).toBe('01USER');
    expect(ids).toHaveLength(codes.length);
    expect(hashes).toHaveLength(codes.length);
  });

  it('gives every code its own id', async () => {
    const { pool, calls } = fakePool();
    await fn(pool, '01USER');

    const ids = (backupCodeWrites(calls)[0]!.params as [string, string[], string[]])[1];
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it('stores only hashes — never a plaintext code', async () => {
    const { pool, calls } = fakePool();
    const codes = await fn(pool, '01USER');

    const hashes = (backupCodeWrites(calls)[0]!.params as [string, string[], string[]])[2];
    const serialised = JSON.stringify(calls);
    for (const code of codes) {
      expect(serialised).not.toContain(code);
    }
    // ...and the hashes stored are the ones that verify the returned codes.
    for (const code of codes) {
      expect(backupCodeMatches(code, hashes)).not.toBeNull();
    }
  });

  it('replaces the previous set rather than adding to it', async () => {
    const { pool, calls } = fakePool();
    await fn(pool, '01USER');

    const deleteAt = calls.findIndex((c) => /DELETE FROM mfa_backup_codes/i.test(c.sql));
    const insertAt = calls.findIndex((c) => /INSERT INTO mfa_backup_codes/i.test(c.sql));
    expect(deleteAt).toBeGreaterThanOrEqual(0);
    expect(deleteAt).toBeLessThan(insertAt);
  });

  it('does the whole swap in one transaction', async () => {
    const { pool, calls } = fakePool();
    await fn(pool, '01USER');

    const sql = calls.map((c) => c.sql.trim());
    expect(sql[0]).toBe('BEGIN');
    expect(sql.at(-1)).toBe('COMMIT');
  });
});

describe('confirmTotpEnrollment', () => {
  it('enables TOTP before issuing the codes', async () => {
    const { pool, calls } = fakePool();
    await confirmTotpEnrollment(pool, '01USER');

    const enableAt = calls.findIndex((c) => /totp_enabled = true/i.test(c.sql));
    const insertAt = calls.findIndex((c) => /INSERT INTO mfa_backup_codes/i.test(c.sql));
    expect(enableAt).toBeGreaterThanOrEqual(0);
    expect(enableAt).toBeLessThan(insertAt);
  });
});

describe('regenerateBackupCodes', () => {
  it('leaves the TOTP secret alone — it only rotates the codes', async () => {
    const { pool, calls } = fakePool();
    await regenerateBackupCodes(pool, '01USER');

    expect(calls.some((c) => /totp_secret/i.test(c.sql))).toBe(false);
  });
});

describe('disableTotp', () => {
  it('wipes the secret, the codes and the trusted devices together', async () => {
    const { pool, calls } = fakePool();
    await disableTotp(pool, '01USER');

    const sql = calls.map((c) => c.sql);
    expect(sql.some((s) => /totp_secret = NULL/i.test(s))).toBe(true);
    expect(sql.some((s) => /DELETE FROM mfa_backup_codes/i.test(s))).toBe(true);
    expect(sql.some((s) => /DELETE FROM mfa_trusted_devices/i.test(s))).toBe(true);
    expect(calls[0]!.sql.trim()).toBe('BEGIN');
    expect(calls.at(-1)!.sql.trim()).toBe('COMMIT');
  });
});
