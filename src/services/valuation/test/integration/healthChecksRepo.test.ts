import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newUlid } from '@n409/shared';
import { createHealthCheck, listHealthChecks } from '../../src/repos/healthChecks.js';
import type { HealthCheck, HealthSeverity } from '../../src/domain/healthChecks.js';
import { createCalculation } from '../../src/repos/calculations.js';
import { createValuation, clearValuationCache } from '../../src/repos/valuations.js';
import { createUser } from '../../src/repos/users.js';
import { hashPassword } from '../../src/auth/password.js';
import { isDbAvailable, setupTestDb, type TestDb } from './helpers.js';

const dbUp = await isDbAvailable();

/**
 * The health-check store.
 *
 * A row here is the record of one readiness gate run against one calculation,
 * and `blocking` is what stands between a valuation and finalization. Two
 * things therefore have to hold: the row and its audit event are written
 * together or not at all, and the list read is ordered so the route's
 * "is the gate satisfied" lookup finds the run for the current calculation.
 */
describe.skipIf(!dbUp)('health checks repo', () => {
  let db: TestDb;
  let pool: pg.Pool;
  let userId: string;
  let valuationId: string;
  let calculationId: string;

  beforeAll(async () => {
    db = await setupTestDb();
    pool = db.pool;
    const user = await createUser(pool, {
      email: `health-${newUlid().toLowerCase()}@test.example.com`,
      passwordDigest: await hashPassword('test-password-123'),
      roles: ['reviewer'],
      partnerId: null,
    });
    userId = user.id;
    valuationId = (
      await createValuation(
        pool,
        { kind: '409a', companyName: 'Checkpoint Systems', userId },
        { actorType: 'human', actorId: userId, source: 'test' },
      )
    ).id;
    calculationId = await newCalculation();
  });
  afterAll(async () => {
    clearValuationCache();
    await db?.teardown();
  });

  async function newCalculation(): Promise<string> {
    const row = await createCalculation(
      pool,
      {
        valuationId,
        engineVersion: 'test-1.0.0',
        status: 'succeeded',
        inputs: {},
        results: { fmv_per_share: 1.23 },
        createdBy: userId,
      },
      { actorType: 'human', actorId: userId, source: 'test' },
    );
    return row.id;
  }

  const actor = () => ({ actorType: 'system' as const, actorId: userId, source: 'health-checks' });

  const checks: HealthCheck[] = [
    {
      key: 'dlom_range',
      category: 'assumptions',
      label: 'DLOM within a defensible range',
      severity: 'warning',
      detail: 'DLOM of 45% is above the usual band',
    },
    {
      key: 'valuation_date_stale',
      category: 'temporal',
      label: 'Valuation date recent',
      severity: 'error',
      detail: 'Valuation date is 14 months old',
    },
  ];
  const counts: Record<HealthSeverity, number> = { ok: 3, info: 1, warning: 1, error: 1 };

  const create = (over: Partial<Parameters<typeof createHealthCheck>[1]> = {}) =>
    createHealthCheck(
      pool,
      {
        valuationId,
        calculationId,
        severity: 'error',
        blocking: true,
        checks,
        counts,
        createdBy: userId,
        ...over,
      },
      actor(),
    );

  const clear = () => pool.query('DELETE FROM valuation_health_checks');

  describe('createHealthCheck', () => {
    it('stores the run with its graded checks and counts intact', async () => {
      await clear();
      const row = await create();

      expect(row).toMatchObject({
        valuation_id: valuationId,
        calculation_id: calculationId,
        severity: 'error',
        blocking: true,
        created_by: userId,
      });
      expect(row.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
      expect(row.created_at).toBeInstanceOf(Date);
      // jsonb round-trips as the structure, not a string.
      expect(row.checks).toEqual(checks);
      expect(row.counts).toEqual(counts);
    });

    it('records one audit event describing the run', async () => {
      await clear();
      const row = await create();

      const { rows } = await pool.query<{
        type: string;
        actor_type: string;
        payload: Record<string, unknown>;
      }>(
        `SELECT type, actor_type, payload FROM valuation_events
          WHERE valuation_id = $1 AND type = 'health_checks_run' ORDER BY seq DESC LIMIT 1`,
        [valuationId],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]!.actor_type).toBe('system');
      expect(rows[0]!.payload).toEqual({
        health_check_id: row.id,
        calculation_id: calculationId,
        severity: 'error',
        blocking: true,
        // The count of checks, not the checks — the trail says a run happened
        // and how bad it was; the findings live on the row it points at.
        checks: 2,
      });
    });

    it('accepts a clean run with no findings', async () => {
      await clear();
      const row = await create({
        severity: 'ok',
        blocking: false,
        checks: [],
        counts: { ok: 6, info: 0, warning: 0, error: 0 },
      });
      expect(row.checks).toEqual([]);
      expect(row.blocking).toBe(false);
      expect(row.severity).toBe('ok');
    });

    it('keeps every run rather than replacing the last', async () => {
      await clear();
      // The gate is auditable: a re-run after a fix must not erase the run that
      // blocked, or the trail loses why the valuation was ever held.
      const first = await create();
      const second = await create({ severity: 'warning', blocking: false });
      expect(second.id).not.toBe(first.id);
      expect((await listHealthChecks(pool, valuationId)).runs).toHaveLength(2);
    });

    it('refuses a severity outside the graded set, writing neither row nor event', async () => {
      await clear();
      const before = await eventCount();
      await expect(create({ severity: 'catastrophic' as HealthSeverity })).rejects.toThrow();

      expect((await listHealthChecks(pool, valuationId)).runs).toEqual([]);
      // The whole thing is one transaction — a rejected row leaves no event
      // claiming a run that never happened.
      expect(await eventCount()).toBe(before);
    });

    it('refuses a run against a calculation that is not there', async () => {
      await clear();
      const before = await eventCount();
      await expect(create({ calculationId: newUlid() })).rejects.toThrow();
      expect((await listHealthChecks(pool, valuationId)).runs).toEqual([]);
      expect(await eventCount()).toBe(before);
    });

    it('refuses a run against a valuation that is not there', async () => {
      await clear();
      await expect(create({ valuationId: newUlid() })).rejects.toThrow();
    });

    async function eventCount(): Promise<number> {
      const { rows } = await pool.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM valuation_events WHERE valuation_id = $1 AND type = 'health_checks_run'",
        [valuationId],
      );
      return rows[0]!.n;
    }
  });

  describe('listHealthChecks', () => {
    it('returns nothing for a valuation that has never been checked', async () => {
      await clear();
      expect((await listHealthChecks(pool, valuationId)).runs).toEqual([]);
      expect((await listHealthChecks(pool, newUlid())).runs).toEqual([]);
    });

    it('returns the newest run first', async () => {
      await clear();
      const ids: string[] = [];
      for (const severity of ['ok', 'info', 'warning'] as const) {
        ids.push((await create({ severity, blocking: false })).id);
        // created_at is `now()`, which is the transaction clock — distinct
        // transactions, but a fast machine can land two in the same
        // microsecond, so space them enough to make the order meaningful.
        await new Promise((resolve) => setTimeout(resolve, 5));
      }

      const { runs: rows } = await listHealthChecks(pool, valuationId);
      expect(rows.map((r) => r.id)).toEqual([...ids].reverse());
    });

    it('caps the history at the twenty most recent runs', async () => {
      await clear();
      for (let i = 0; i < 22; i++) {
        await create({ severity: 'ok', blocking: false });
        await new Promise((resolve) => setTimeout(resolve, 2));
      }
      const { runs: rows } = await listHealthChecks(pool, valuationId);
      expect(rows).toHaveLength(20);
    });

    it('never returns another valuation’s runs', async () => {
      await clear();
      const otherValuation = (
        await createValuation(
          pool,
          { kind: '409a', companyName: 'Elsewhere Inc', userId },
          { actorType: 'human', actorId: userId, source: 'test' },
        )
      ).id;
      await create();

      expect((await listHealthChecks(pool, otherValuation)).runs).toEqual([]);
      expect((await listHealthChecks(pool, valuationId)).runs.map((r) => r.valuation_id)).toEqual([
        valuationId,
      ]);
    });

    it('carries the calculation id the gate keys on', async () => {
      await clear();
      // routes/healthChecks.ts decides `gate.satisfied` by finding the run whose
      // calculation_id matches the latest succeeded calculation — a run against
      // a superseded calculation must not answer for the new one.
      const older = await create({ severity: 'ok', blocking: false });
      const newerCalculation = await newCalculation();
      await new Promise((resolve) => setTimeout(resolve, 5));
      const newer = await create({ calculationId: newerCalculation, severity: 'ok', blocking: false });

      const { runs: rows } = await listHealthChecks(pool, valuationId);
      expect(rows.find((r) => r.calculation_id === newerCalculation)!.id).toBe(newer.id);
      expect(rows.find((r) => r.calculation_id === calculationId)!.id).toBe(older.id);
    });
  });
});
