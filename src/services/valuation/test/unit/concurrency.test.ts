import { beforeEach, describe, expect, it, vi } from 'vitest';
import type pg from 'pg';
import { ApiProblem } from '@n409/shared';
import { parseIfMatch, versionEtag } from '../../src/domain/concurrency.js';
import { clearValuationCache, patchValuation, type ValuationRow } from '../../src/repos/valuations.js';

describe('versionEtag', () => {
  it('quotes the version so it is a syntactically valid entity tag', () => {
    expect(versionEtag(7)).toBe('"7"');
  });
});

describe('parseIfMatch', () => {
  it('reads the quoted form a client echoes back from an ETag', () => {
    expect(parseIfMatch('"7"')).toEqual({ kind: 'version', version: 7 });
  });

  it('reads the weak form — the version is exact either way', () => {
    expect(parseIfMatch('W/"7"')).toEqual({ kind: 'version', version: 7 });
  });

  it('reads a bare number, which is what hand-rolled clients send', () => {
    expect(parseIfMatch('7')).toEqual({ kind: 'version', version: 7 });
  });

  it('treats a missing or empty header as "no check requested"', () => {
    expect(parseIfMatch(undefined)).toEqual({ kind: 'absent' });
    expect(parseIfMatch('   ')).toEqual({ kind: 'absent' });
  });

  it('treats * as "any current version", which asks for no check', () => {
    expect(parseIfMatch('*')).toEqual({ kind: 'any' });
  });

  it('takes the first value when the header is repeated', () => {
    expect(parseIfMatch(['"3"', '"9"'])).toEqual({ kind: 'version', version: 3 });
  });

  /**
   * The whole point of reporting `invalid` rather than `absent`: a header the
   * client believed was protecting its write must not be silently dropped,
   * because dropping it turns the request back into the lost update the header
   * was added to prevent.
   */
  it.each(['"abc"', '7.0', '1e3', '0x7', '-1', '""', '"7', 'W/7"'])(
    'rejects %j rather than ignoring it',
    (raw) => {
      expect(parseIfMatch(raw)).toEqual({ kind: 'invalid', raw });
    },
  );

  it('rejects a version too large to be an exact integer', () => {
    const raw = '9'.repeat(20);
    expect(parseIfMatch(raw)).toEqual({ kind: 'invalid', raw });
  });
});

// ── patchValuation's version check ────────────────────────────────────────────

const ROW: ValuationRow = {
  id: '01JAAAAAAAAAAAAAAAAAAAAAAA',
  number: '1',
  workflow_id: null,
  kind: '409a',
  state: 'pending',
  waiting_on_client: false,
  company_name: 'Acme',
  service_name: null,
  user_id: '01JBBBBBBBBBBBBBBBBBBBBBBB',
  partner_id: null,
  source: null,
  currency: 'USD',
  service_countries: [],
  paid_status: 'unpaid',
  qsbs_attestation: null,
  delivery_days: null,
  amount_raised_cents: null,
  assigned_reviewer_id: null,
  auto_pipeline: true,
  version: 4,
  created_at: new Date(0),
  due_date: null,
  published_at: null,
} as ValuationRow;

const ACTOR = { actorType: 'human', actorId: ROW.user_id, source: 'api' } as const;

/**
 * A pool whose transaction returns `updatedRows` for the UPDATE and `liveVersion`
 * for the follow-up version read, recording every statement on the way.
 */
function fakePool(opts: { updatedRows: ValuationRow[]; liveVersion?: number }) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    calls.push({ sql, params });
    if (/^\s*UPDATE valuations/.test(sql)) {
      return { rows: opts.updatedRows, rowCount: opts.updatedRows.length };
    }
    if (/SELECT version FROM valuations/.test(sql)) {
      const rows = opts.liveVersion === undefined ? [] : [{ version: opts.liveVersion }];
      return { rows, rowCount: rows.length };
    }
    return { rows: [], rowCount: 0 };
  });
  const client = { query, release: vi.fn() };
  const pool = { connect: vi.fn(async () => client), query } as unknown as pg.Pool;
  return { pool, calls };
}

const updateCall = (calls: Array<{ sql: string; params: unknown[] }>) =>
  calls.find((c) => /^\s*UPDATE valuations/.test(c.sql))!;

describe('patchValuation optimistic locking', () => {
  beforeEach(() => clearValuationCache());

  it('bumps the version on every write, checked or not', async () => {
    const { pool, calls } = fakePool({ updatedRows: [{ ...ROW, version: 5 }] });
    await patchValuation(pool, ROW, { company_name: 'Beta' }, ACTOR);
    expect(updateCall(calls).sql).toContain('version = version + 1');
  });

  it('leaves the UPDATE unconditional when no version is expected', async () => {
    const { pool, calls } = fakePool({ updatedRows: [{ ...ROW, version: 5 }] });
    await patchValuation(pool, ROW, { company_name: 'Beta' }, ACTOR);
    expect(updateCall(calls).sql).not.toContain('AND version =');
  });

  it('conditions the UPDATE on the expected version when one is given', async () => {
    const { pool, calls } = fakePool({ updatedRows: [{ ...ROW, version: 5 }] });
    await patchValuation(pool, ROW, { company_name: 'Beta' }, ACTOR, { expectedVersion: 4 });
    const call = updateCall(calls);
    expect(call.sql).toContain('AND version =');
    expect(call.params).toContain(4);
  });

  /**
   * The cheap half of the check: the caller's own copy is already behind, so
   * there is no point opening a transaction to discover it.
   */
  it('refuses a write whose expected version is already behind the row read', async () => {
    const { pool, calls } = fakePool({ updatedRows: [] });
    await expect(
      patchValuation(pool, ROW, { company_name: 'Beta' }, ACTOR, { expectedVersion: 3 }),
    ).rejects.toMatchObject({ status: 409 });
    expect(calls).toHaveLength(0);
  });

  /**
   * The half that needs the database: the caller read version 4 and it was
   * still 4 when the route checked, but a concurrent writer committed before
   * this UPDATE ran, so it matches no row.
   */
  it('refuses a write that loses the race between the read and the UPDATE', async () => {
    const { pool } = fakePool({ updatedRows: [], liveVersion: 9 });
    const err = await patchValuation(pool, ROW, { company_name: 'Beta' }, ACTOR, {
      expectedVersion: 4,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiProblem);
    expect((err as ApiProblem).status).toBe(409);
    // Both versions are named so the client can tell a concurrent save from its
    // own retry without another round trip.
    expect((err as ApiProblem).detail).toContain('4');
    expect((err as ApiProblem).detail).toContain('9');
  });

  /**
   * A no-op patch must not burn a version: doing so would make an idle tab that
   * re-saves an unchanged form conflict with a real editor for no reason.
   */
  it('writes nothing when the patch changes nothing', async () => {
    const { pool, calls } = fakePool({ updatedRows: [] });
    const out = await patchValuation(pool, ROW, { company_name: ROW.company_name }, ACTOR, {
      expectedVersion: 4,
    });
    expect(out).toBe(ROW);
    expect(calls).toHaveLength(0);
  });
});
