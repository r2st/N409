import { describe, expect, it } from 'vitest';
import { BulkActionBody, dedupeIds, toBulkInput } from '../../src/routes/workflow.js';
import { ValuationFilterQuery, toRepoFilters } from '../../src/routes/valuations.js';
import { buildValuationWhere } from '../../src/repos/valuations.js';

/** Improvement 5 — POST /valuations/bulk-action contract + selected-ids export filter. */

const ID_A = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const ID_B = '01BX5ZZKBKACTAV9WEVGEMMVRZ';

describe('BulkActionBody', () => {
  it('accepts { action, valuation_ids, params } and normalizes to the executor input', () => {
    const parsed = BulkActionBody.safeParse({
      action: 'set_state',
      valuation_ids: [ID_A, ID_B],
      params: { state: 'review' },
    });
    expect(parsed.success).toBe(true);
    expect(toBulkInput(parsed.data!)).toEqual({
      ids: [ID_A, ID_B],
      action: 'set_state',
      state: 'review',
      reviewer_id: undefined,
    });
  });

  it('carries reviewer_id (including explicit null = unassign) through params', () => {
    const assign = BulkActionBody.parse({
      action: 'assign_reviewer',
      valuation_ids: [ID_A],
      params: { reviewer_id: ID_B },
    });
    expect(toBulkInput(assign).reviewer_id).toBe(ID_B);

    const unassign = BulkActionBody.parse({
      action: 'assign_reviewer',
      valuation_ids: [ID_A],
      params: { reviewer_id: null },
    });
    expect(toBulkInput(unassign).reviewer_id).toBeNull();
  });

  it('params is optional for parameterless actions (advance / restart)', () => {
    const parsed = BulkActionBody.safeParse({ action: 'advance', valuation_ids: [ID_A] });
    expect(parsed.success).toBe(true);
    expect(toBulkInput(parsed.data!)).toEqual({
      ids: [ID_A],
      action: 'advance',
      state: undefined,
      reviewer_id: undefined,
    });
  });

  it('rejects unknown actions, empty and oversized id lists', () => {
    expect(BulkActionBody.safeParse({ action: 'delete_all', valuation_ids: [ID_A] }).success).toBe(false);
    expect(BulkActionBody.safeParse({ action: 'advance', valuation_ids: [] }).success).toBe(false);
    expect(
      BulkActionBody.safeParse({ action: 'advance', valuation_ids: Array(201).fill(ID_A) }).success,
    ).toBe(false);
  });
});

describe('dedupeIds (a bulk action is not idempotent per id)', () => {
  it('keeps the first occurrence and drops repeats, preserving order', () => {
    expect(dedupeIds([ID_A, ID_B, ID_A])).toEqual([ID_A, ID_B]);
  });

  it('treats a differently-cased ULID as the same valuation, because the database does', () => {
    expect(dedupeIds([ID_A, ID_A.toLowerCase()])).toEqual([ID_A]);
  });

  it('leaves a list with no repeats untouched', () => {
    expect(dedupeIds([ID_A, ID_B])).toEqual([ID_A, ID_B]);
    expect(dedupeIds([])).toEqual([]);
  });

  it('normalizes at the contract boundary, so `advance` cannot take two steps at once', () => {
    // Twice through the executor is `pending → started → review` from one
    // click, with a client email for each — see dedupeIds.
    const parsed = BulkActionBody.parse({
      action: 'advance',
      valuation_ids: [ID_A, ID_A.toLowerCase(), ID_B],
    });
    expect(toBulkInput(parsed).ids).toEqual([ID_A, ID_B]);
  });
});

describe('ids filter (bulk export of a selection)', () => {
  it('parses a comma-separated list, drops non-ULIDs, and uppercases', () => {
    const parsed = ValuationFilterQuery.parse({
      ids: `${ID_A.toLowerCase()}, not-a-ulid ,${ID_B}`,
    });
    expect(parsed.ids).toEqual([ID_A, ID_B]);
  });

  it('caps the list at 200 ids', () => {
    // 200-char-limited input can't hold 200 real ULIDs, so exercise the slice directly.
    const many = Array(210).fill(ID_A).join(',');
    const parsed = ValuationFilterQuery.parse({ ids: many.slice(0, 5990) });
    expect(parsed.ids!.length).toBeLessThanOrEqual(200);
  });

  it('maps into repo filters only when non-empty', () => {
    expect(toRepoFilters(ValuationFilterQuery.parse({ ids: 'garbage' })).ids).toBeUndefined();
    expect(toRepoFilters(ValuationFilterQuery.parse({ ids: ID_A })).ids).toEqual([ID_A]);
  });

  it('builds an id = ANY(...) clause scoped on top of RBAC', () => {
    const { whereSql, params } = buildValuationWhere({ kind: 'own', userId: 'U1' }, { ids: [ID_A, ID_B] });
    expect(whereSql).toContain('user_id = $1');
    expect(whereSql).toContain('id = ANY($2)');
    expect(params).toEqual(['U1', [ID_A, ID_B]]);
  });

  it('prefixes the alias for joined export queries', () => {
    const { whereSql } = buildValuationWhere({ kind: 'all' }, { ids: [ID_A] }, 'v.');
    expect(whereSql).toContain('v.id = ANY($1)');
  });
});
