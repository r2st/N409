import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isDbAvailable, setupTestDb, type TestDb } from './helpers.js';
import { migrate } from '../../src/db/migrate.js';
import { newUlid } from '@n409/shared';

const dbUp = await isDbAvailable();

describe.skipIf(!dbUp)('core schema (issue #2)', () => {
  let db: TestDb;
  let userId: string;
  let valuationId: string;

  beforeAll(async () => {
    db = await setupTestDb();
    userId = newUlid();
    valuationId = newUlid();
    await db.pool.query(`INSERT INTO users (id, email, password_digest) VALUES ($1, 'a@b.c', 'x')`, [userId]);
    await db.pool.query(
      `INSERT INTO valuations (id, kind, company_name, user_id) VALUES ($1, '409a', 'Acme', $2)`,
      [valuationId, userId],
    );
  });
  afterAll(async () => db?.teardown());

  it('is idempotent — re-running migrations applies nothing', async () => {
    expect(await migrate(db.pool)).toEqual([]);
  });

  it('seeds all 18 roles', async () => {
    const { rows } = await db.pool.query('SELECT key FROM roles ORDER BY key');
    // 17 original roles + 'auditor' (feature 8, migration 0081).
    expect(rows.length).toBe(18);
    expect(rows.map((r) => r.key)).toContain('god');
    expect(rows.map((r) => r.key)).toContain('valuation_user');
    expect(rows.map((r) => r.key)).toContain('auditor');
  });

  it('assigns human-friendly sequential valuation numbers', async () => {
    const { rows } = await db.pool.query('SELECT number FROM valuations WHERE id = $1', [valuationId]);
    expect(Number(rows[0].number)).toBeGreaterThanOrEqual(1);
  });

  it('rejects non-ULID primary keys', async () => {
    await expect(
      db.pool.query(`INSERT INTO users (id, email, password_digest) VALUES ('bogus', 'x@y.z', 'x')`),
    ).rejects.toThrow(/ulid/);
  });

  it('enforces unique email case-insensitively', async () => {
    await expect(
      db.pool.query(`INSERT INTO users (id, email, password_digest) VALUES ($1, 'A@B.C', 'x')`, [newUlid()]),
    ).rejects.toThrow(/duplicate key/);
  });

  it('requires at least one auth method on users', async () => {
    await expect(
      db.pool.query(`INSERT INTO users (id, email) VALUES ($1, 'no-auth@x.y')`, [newUlid()]),
    ).rejects.toThrow(/users_auth_method/);
  });

  it('enforces weights-sum-to-one on valuation_params', async () => {
    await db.pool.query('INSERT INTO valuation_params (valuation_id) VALUES ($1)', [valuationId]);
    await expect(
      db.pool.query(
        `UPDATE valuation_params
         SET weight_asset = 0.5, weight_opm = 0.5, weight_income = 0.5, weight_market = 0.5
         WHERE valuation_id = $1`,
        [valuationId],
      ),
    ).rejects.toThrow(/weights_sum_to_one/);
    await db.pool.query(
      `UPDATE valuation_params
       SET weight_asset = 0, weight_opm = 1, weight_income = 0, weight_market = 0
       WHERE valuation_id = $1`,
      [valuationId],
    );
  });

  describe('valuation_events is append-only', () => {
    let eventId: string;
    beforeAll(async () => {
      eventId = newUlid();
      await db.pool.query(
        `INSERT INTO valuation_events (id, valuation_id, type, actor_type) VALUES ($1, $2, 'test', 'system')`,
        [eventId, valuationId],
      );
    });

    it('blocks UPDATE', async () => {
      await expect(
        db.pool.query(`UPDATE valuation_events SET type = 'tampered' WHERE id = $1`, [eventId]),
      ).rejects.toThrow(/append-only/);
    });

    it('blocks DELETE', async () => {
      await expect(db.pool.query(`DELETE FROM valuation_events WHERE id = $1`, [eventId])).rejects.toThrow(
        /append-only/,
      );
    });

    it('blocks TRUNCATE', async () => {
      await expect(db.pool.query('TRUNCATE valuation_events')).rejects.toThrow(/append-only/);
    });

    it('keeps per-valuation seq strictly increasing', async () => {
      await db.pool.query(
        `INSERT INTO valuation_events (id, valuation_id, type, actor_type) VALUES ($1, $2, 'test2', 'system')`,
        [newUlid(), valuationId],
      );
      const { rows } = await db.pool.query(
        'SELECT seq FROM valuation_events WHERE valuation_id = $1 ORDER BY seq',
        [valuationId],
      );
      const seqs = rows.map((r) => Number(r.seq));
      expect(seqs.length).toBeGreaterThanOrEqual(2);
      expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
      expect(new Set(seqs).size).toBe(seqs.length);
    });
  });
});

if (!dbUp) {
  console.warn('[schema.test] Postgres not reachable — integration tests skipped. Run: npm run dev:db');
}
