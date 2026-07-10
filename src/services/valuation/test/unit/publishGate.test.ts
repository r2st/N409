import { describe, expect, it } from 'vitest';
import type pg from 'pg';
import { assertPublishGate } from '../../src/domain/publishGate.js';

/** Routes the gate's three lookups by table name. */
function poolWith(args: {
  signatures?: unknown[];
  calculations?: unknown[];
  qaReviews?: unknown[];
}): pg.Pool {
  return {
    query: async (sql: string) => {
      if (sql.includes('valuation_signatures')) return { rows: args.signatures ?? [] };
      if (sql.includes('FROM calculations')) return { rows: args.calculations ?? [] };
      if (sql.includes('FROM qa_reviews')) return { rows: args.qaReviews ?? [] };
      throw new Error(`unexpected query: ${sql}`);
    },
  } as unknown as pg.Pool;
}

const SIGNED = [{ '?column?': 1 }];
const CALC = [{ id: 'calc-1', status: 'succeeded' }];

describe('publish gate (signature + QA)', () => {
  it('blocks the transition to published without a main signature', async () => {
    await expect(assertPublishGate(poolWith({}), 'v1', 'published')).rejects.toMatchObject({
      status: 409,
      detail: expect.stringContaining('signature'),
    });
  });

  it('allows publish when signed and nothing was ever calculated', async () => {
    await expect(
      assertPublishGate(poolWith({ signatures: SIGNED }), 'v1', 'published'),
    ).resolves.toBeUndefined();
  });

  it('blocks publish when the latest calculation has no QA review', async () => {
    await expect(
      assertPublishGate(poolWith({ signatures: SIGNED, calculations: CALC }), 'v1', 'published'),
    ).rejects.toMatchObject({ status: 409, detail: expect.stringContaining('QA review') });
  });

  it('blocks publish when the latest QA review failed', async () => {
    await expect(
      assertPublishGate(
        poolWith({ signatures: SIGNED, calculations: CALC, qaReviews: [{ status: 'fail' }] }),
        'v1',
        'published',
      ),
    ).rejects.toMatchObject({ status: 409, detail: expect.stringContaining('failed') });
  });

  it('allows publish with a passing or warning QA review', async () => {
    for (const status of ['pass', 'warn']) {
      await expect(
        assertPublishGate(
          poolWith({ signatures: SIGNED, calculations: CALC, qaReviews: [{ status }] }),
          'v1',
          'published',
        ),
      ).resolves.toBeUndefined();
    }
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
