import { describe, expect, it } from 'vitest';
import type pg from 'pg';
import { assertPublishGate } from '../../src/domain/publishGate.js';

/** Routes the gate's four lookups by table name. */
function poolWith(args: {
  signatures?: unknown[];
  calculations?: unknown[];
  qaReviews?: unknown[];
  reports?: unknown[];
}): pg.Pool {
  return {
    query: async (sql: string) => {
      if (sql.includes('valuation_signatures')) return { rows: args.signatures ?? [] };
      if (sql.includes('FROM calculations')) return { rows: args.calculations ?? [] };
      if (sql.includes('FROM qa_reviews')) return { rows: args.qaReviews ?? [] };
      if (sql.includes('FROM reports')) return { rows: args.reports ?? [] };
      throw new Error(`unexpected query: ${sql}`);
    },
  } as unknown as pg.Pool;
}

const SIGNED = [{ '?column?': 1 }];
const CALC = [{ id: 'calc-1', status: 'succeeded' }];
/** A report whose current body is the one the review below graded. */
const REPORT_V4 = [{ current_version: 4 }];

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
          poolWith({
            signatures: SIGNED,
            calculations: CALC,
            reports: REPORT_V4,
            qaReviews: [{ status, report_version: 4 }],
          }),
          'v1',
          'published',
        ),
      ).resolves.toBeUndefined();
    }
  });

  it('allows publish when the engagement has no report at all', async () => {
    // Nothing to have graded, which is what `runQa` files as a null and what
    // rule 3 has to return early on — otherwise the rule would block every
    // engagement whose deliverable is not a report body.
    await expect(
      assertPublishGate(
        poolWith({
          signatures: SIGNED,
          calculations: CALC,
          reports: [],
          qaReviews: [{ status: 'pass', report_version: null }],
        }),
        'v1',
        'published',
      ),
    ).resolves.toBeUndefined();
  });

  it('blocks publish when the body has been saved since the review', async () => {
    await expect(
      assertPublishGate(
        poolWith({
          signatures: SIGNED,
          calculations: CALC,
          reports: [{ current_version: 5 }],
          qaReviews: [{ status: 'pass', report_version: 4 }],
        }),
        'v1',
        'published',
      ),
    ).rejects.toMatchObject({ status: 409, detail: expect.stringContaining('edited since') });
  });

  it('blocks publish when the review does not say which body it graded', async () => {
    // A review filed before `qa_reviews.report_version` existed, on an
    // engagement that has a report. Read as "does not say" rather than as "did
    // not change": the column answers a compliance question, and an unknown is
    // not a yes.
    await expect(
      assertPublishGate(
        poolWith({
          signatures: SIGNED,
          calculations: CALC,
          reports: REPORT_V4,
          qaReviews: [{ status: 'pass', report_version: null }],
        }),
        'v1',
        'published',
      ),
    ).rejects.toMatchObject({ status: 409, detail: expect.stringContaining('QA review') });
  });

  it('does not read the report before the rules that come first', async () => {
    // Order matters for the message an operator gets: an unsigned engagement
    // must be told about the signature, not about a body nobody has graded.
    await expect(
      assertPublishGate(poolWith({ reports: [{ current_version: 9 }] }), 'v1', 'published'),
    ).rejects.toMatchObject({ detail: expect.stringContaining('signature') });
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
