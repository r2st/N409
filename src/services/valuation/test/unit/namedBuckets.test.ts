import { describe, expect, it } from 'vitest';
import { NAMED_BUCKETS, NAMED_BUCKET_KEYS, namedBucket, namedBucketsFor } from '../../src/domain/workflow.js';
import { VALUATION_STATES } from '../../src/domain/valuation.js';
import { buildValuationWhere } from '../../src/repos/valuations.js';

/** Design §4.2 — the nine named listing tabs. */

describe('NAMED_BUCKETS', () => {
  it('names the nine tabs the competitor\u2019s console does', () => {
    expect(NAMED_BUCKET_KEYS).toEqual([
      'all',
      'incomplete',
      'unverified',
      'in_progress',
      'waiting_on_client',
      'drafted',
      'published',
      'unread',
      'ignored',
    ]);
  });

  /**
   * Every state has a home. Deliberately not `stateGroupOf`'s behaviour, which
   * defaults an unrecognised state to `closed` — here a missing state shows up
   * as counts that do not add to All, which is the failure an operator can see
   * rather than one that files a live engagement silently under Ignored.
   */
  it('covers every lifecycle state exactly once across the state buckets', () => {
    const seen = new Map<string, string[]>();
    for (const bucket of NAMED_BUCKETS) {
      for (const state of bucket.states) {
        seen.set(state, [...(seen.get(state) ?? []), bucket.key]);
      }
    }
    for (const state of VALUATION_STATES) {
      expect(seen.get(state), `${state} has a bucket`).toBeDefined();
      expect(seen.get(state), `${state} is in exactly one`).toHaveLength(1);
    }
  });

  it('marks the two buckets that are not state predicates', () => {
    // waiting_on_client is a boolean that cuts across the lifecycle — a file can
    // be drafted AND waiting on the client — and unread is per-reader.
    expect(namedBucket('waiting_on_client')!.waitingOnClient).toBe(true);
    expect(namedBucket('waiting_on_client')!.states).toEqual([]);
    expect(namedBucket('unread')!.unread).toBe(true);
    expect(namedBucket('unread')!.states).toEqual([]);
  });

  it('resolves an unknown key to null rather than a default bucket', () => {
    expect(namedBucket('nope')).toBeNull();
  });

  it('puts every state in All and in its own bucket', () => {
    expect(namedBucketsFor('user_finished')).toEqual(['all', 'unverified']);
    expect(namedBucketsFor('paid')).toEqual(['all', 'in_progress']);
    expect(namedBucketsFor('timeout')).toEqual(['all', 'ignored']);
  });
});

describe('bucket filtering in SQL', () => {
  it('filters a state bucket to exactly its states', () => {
    const { whereSql, params } = buildValuationWhere({ kind: 'all' }, { bucket: 'in_progress' });
    expect(whereSql).toContain('state = ANY($1::valuation_state[])');
    expect(params[0]).toEqual(['completed', 'paid', 'review', 'reviewed']);
  });

  it('filters the waiting bucket on the boolean, not on a state list', () => {
    const { whereSql, params } = buildValuationWhere({ kind: 'all' }, { bucket: 'waiting_on_client' });
    expect(whereSql).toContain('waiting_on_client');
    expect(whereSql).not.toContain('valuation_state[]');
    expect(params).toEqual([]);
  });

  it('the All bucket adds no predicate of its own', () => {
    const { whereSql } = buildValuationWhere({ kind: 'all' }, { bucket: 'all' });
    expect(whereSql).toBe('');
  });

  it('bucket wins over the legacy group alias', () => {
    // `group` stays accepted so saved views and shared links keep working, but
    // a request naming both is naming the new tab.
    const { params } = buildValuationWhere({ kind: 'all' }, { bucket: 'unverified', group: 'closed' });
    expect(params[0]).toEqual(['user_finished']);
  });

  it('an explicit state still wins over both', () => {
    const { params } = buildValuationWhere({ kind: 'all' }, { state: 'drafted', bucket: 'ignored' });
    expect(params[0]).toBe('drafted');
  });

  it('scope is still applied on top of a bucket', () => {
    const { whereSql, params } = buildValuationWhere(
      { kind: 'partner', partnerId: 'P1' },
      { bucket: 'published' },
    );
    expect(whereSql).toContain('partner_id = $1');
    expect(params[0]).toBe('P1');
  });
});
