import { describe, expect, it, vi } from 'vitest';
import type pg from 'pg';
import { onboardingFacts } from '../../src/repos/onboarding.js';
import { EMPTY_FACTS } from '../../src/domain/onboarding.js';

/** A pool stand-in that records the single query the repo issues. */
function fakePool(row: Record<string, string> | undefined) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const pool = {
    query: vi.fn(async (sql: string, params: unknown[]) => {
      calls.push({ sql, params });
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    }),
  } as unknown as pg.Pool;
  return { pool, calls };
}

const FULL_ROW = {
  valuations: '3',
  capTables: '1',
  documents: '7',
  methodology: '1',
  assumptions: '1',
  calculations: '2',
  reports: '1',
  boardSignoffs: '1',
};

describe('onboardingFacts', () => {
  it('parses the bigint counts postgres returns as strings', async () => {
    const { pool } = fakePool(FULL_ROW);
    expect(await onboardingFacts(pool, { kind: 'all' })).toEqual({
      valuations: 3,
      capTables: 1,
      documents: 7,
      methodology: 1,
      assumptions: 1,
      calculations: 2,
      reports: 1,
      boardSignoffs: 1,
    });
  });

  it('scopes a client to their own valuations in SQL', async () => {
    const { pool, calls } = fakePool(FULL_ROW);
    await onboardingFacts(pool, { kind: 'own', userId: '01USER' });

    const { sql, params } = calls[0]!;
    // Archived engagements are out of the facts as well as out of the list —
    // an onboarding checklist that counts work the firm has retired is telling
    // the user to finish something that is gone.
    expect(sql).toContain(
      'WITH scoped AS (SELECT id FROM valuations WHERE archived_at IS NULL AND user_id = $1)',
    );
    expect(params).toEqual(['01USER']);
    // Every count must run through the scoped set, never the bare table.
    for (const table of ['cap_tables', 'documents', 'valuation_params', 'calculations', 'reports']) {
      expect(sql).toContain(`FROM ${table}`);
    }
    expect(sql.match(/JOIN scoped s ON s\.id =/g)).toHaveLength(7);
  });

  it('scopes a partner to their organisation', async () => {
    const { pool, calls } = fakePool(FULL_ROW);
    await onboardingFacts(pool, { kind: 'partner', partnerId: '01PARTNER' });
    expect(calls[0]!.sql).toContain('WHERE archived_at IS NULL AND partner_id = $1');
    expect(calls[0]!.params).toEqual(['01PARTNER']);
  });

  it('never queries at all for a principal with no scope', async () => {
    const { pool, calls } = fakePool(FULL_ROW);
    expect(await onboardingFacts(pool, { kind: 'none' })).toEqual(EMPTY_FACTS);
    expect(calls).toHaveLength(0);
  });

  it('counts only signed board sign-offs and rendered reports', async () => {
    const { pool, calls } = fakePool(FULL_ROW);
    await onboardingFacts(pool, { kind: 'all' });
    const { sql } = calls[0]!;
    expect(sql).toContain("b.status = 'signed'");
    expect(sql).toContain('r.current_version > 0');
    // A soft-deleted document must not tick the financials step.
    expect(sql).toContain('d.deleted_at IS NULL');
    // An empty cap table is not a built cap table.
    expect(sql).toContain('jsonb_array_length(c.entries) > 0');
  });

  it('degrades to zeroes when the query returns no row', async () => {
    const { pool } = fakePool(undefined);
    expect(await onboardingFacts(pool, { kind: 'all' })).toEqual(EMPTY_FACTS);
  });

  it('treats an unparseable count as zero rather than NaN', async () => {
    const { pool } = fakePool({ ...FULL_ROW, valuations: 'not-a-number' });
    const facts = await onboardingFacts(pool, { kind: 'all' });
    expect(facts.valuations).toBe(0);
    expect(facts.documents).toBe(7);
  });
});
