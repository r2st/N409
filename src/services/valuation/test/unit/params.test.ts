import { describe, expect, it } from 'vitest';
import { newUlid } from '@n409/shared';
import { ID_PARAM_NAMES, UlidParam, invalidIdParams } from '../../src/plugins/params.js';

/**
 * Route-parameter validation. The ids are ULIDs, not UUIDs — see the note in
 * plugins/params.ts and the `ulid` domain in migration 0001.
 */

describe('UlidParam', () => {
  it('accepts a freshly minted id', () => {
    expect(UlidParam.safeParse(newUlid()).success).toBe(true);
  });

  it('accepts the platform 01K… id shape', () => {
    expect(UlidParam.safeParse('01K0000000000000000000000A').success).toBe(true);
  });

  it.each([
    ['empty', ''],
    ['too short', '01K'],
    ['too long', `${newUlid()}A`],
    ['lowercase', newUlid().toLowerCase()],
    ['excluded letter I', '01KIIIIIIIIIIIIIIIIIIIIIII'],
    ['excluded letter L', '01KLLLLLLLLLLLLLLLLLLLLLLL'],
    ['excluded letter O', '01KOOOOOOOOOOOOOOOOOOOOOOO'],
    ['excluded letter U', '01KUUUUUUUUUUUUUUUUUUUUUUU'],
    ['a UUID', '3f2504e0-4f89-11d3-9a0c-0305e82c3301'],
    ['SQL-ish', "01K' OR 1=1--"],
    ['path traversal', '../../etc/passwd'],
  ])('rejects %s', (_label, value) => {
    expect(UlidParam.safeParse(value).success).toBe(false);
  });

  it.each([
    ['a number', 1],
    ['null', null],
    ['undefined', undefined],
    ['an array', [newUlid()]],
    ['an object', { toString: () => newUlid() }],
  ])('rejects non-string %s', (_label, value) => {
    expect(UlidParam.safeParse(value).success).toBe(false);
  });
});

describe('invalidIdParams', () => {
  it('passes a params object whose ids are all valid', () => {
    expect(invalidIdParams({ id: newUlid(), grantId: newUlid() })).toEqual([]);
  });

  it('names every offending id parameter', () => {
    expect(invalidIdParams({ id: 'nope', grantId: 'also-nope' }).sort()).toEqual([
      'grantId',
      'id',
    ]);
  });

  it('reports only the bad one in a mixed params object', () => {
    expect(invalidIdParams({ id: newUlid(), pid: 'bad' })).toEqual(['pid']);
  });

  it('leaves non-id parameters alone', () => {
    // These are lookup keys and version numbers, not ids — validating them as
    // ULIDs would 404 every legitimate request to their routes.
    expect(
      invalidIdParams({
        provider: 'google',
        role: 'admin',
        slug: 'getting-started',
        key: 'summarize',
        field_key: 'dlom',
        dataType: 'valuations',
        pipeline: 'auto',
        version: '3',
      }),
    ).toEqual([]);
  });

  it('checks a non-id parameter when told to', () => {
    expect(invalidIdParams({ tenant: 'nope' }, new Set(['tenant']))).toEqual(['tenant']);
  });

  it('tolerates a request with no params at all', () => {
    expect(invalidIdParams({})).toEqual([]);
    expect(invalidIdParams(null)).toEqual([]);
    expect(invalidIdParams(undefined)).toEqual([]);
  });

  it('covers the id parameter names the routes actually declare', () => {
    // Guards against a new `:somethingId` route slipping past the hook.
    for (const name of ['id', 'pid', 'grantId', 'valuationId', 'accessId', 'compareId']) {
      expect(ID_PARAM_NAMES.has(name)).toBe(true);
    }
  });
});
