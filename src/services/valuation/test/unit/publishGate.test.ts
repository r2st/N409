import { describe, expect, it } from 'vitest';
import type pg from 'pg';
import { assertPublishGate } from '../../src/domain/publishGate.js';

function poolWithSignatures(rows: unknown[]): pg.Pool {
  return { query: async () => ({ rows }) } as unknown as pg.Pool;
}

describe('signature gating before publish (remaining-gaps §3 #3)', () => {
  it('blocks the transition to published without a main signature', async () => {
    await expect(assertPublishGate(poolWithSignatures([]), 'v1', 'published')).rejects.toMatchObject({
      status: 409,
    });
  });

  it('allows publish once the main signature is on file', async () => {
    await expect(
      assertPublishGate(poolWithSignatures([{ '?column?': 1 }]), 'v1', 'published'),
    ).resolves.toBeUndefined();
  });

  it('never queries for non-publish transitions', async () => {
    const pool = {
      query: async () => {
        throw new Error('should not be called');
      },
    } as unknown as pg.Pool;
    await expect(assertPublishGate(pool, 'v1', 'review')).resolves.toBeUndefined();
    await expect(assertPublishGate(pool, 'v1', 'cancelled')).resolves.toBeUndefined();
  });
});
