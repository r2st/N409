import { describe, expect, it } from 'vitest';
import type pg from 'pg';
import { assertPublishGate } from '../../src/domain/publishGate.js';

/** Routes the gate's five lookups by table name. */
function poolWith(args: {
  signatures?: unknown[];
  calculations?: unknown[];
  qaReviews?: unknown[];
  reports?: unknown[];
  reportVersions?: unknown[];
}): pg.Pool {
  return {
    query: async (sql: string) => {
      if (sql.includes('valuation_signatures')) return { rows: args.signatures ?? [] };
      if (sql.includes('FROM calculations')) return { rows: args.calculations ?? [] };
      if (sql.includes('FROM qa_reviews')) return { rows: args.qaReviews ?? [] };
      // Before `FROM reports`: the version lookup names `report_versions`, and
      // a substring test for the shorter table name matches both.
      if (sql.includes('FROM report_versions')) return { rows: args.reportVersions ?? WRITTEN_BEFORE };
      if (sql.includes('FROM reports')) return { rows: args.reports ?? [] };
      throw new Error(`unexpected query: ${sql}`);
    },
  } as unknown as pg.Pool;
}

const SIGNED_AT = new Date('2026-08-15T00:00:00Z');
const SIGNED = [{ role: 'main', signed_at: SIGNED_AT }];
/** The concurring reviewer signed at the same instant the analyst did. */
const SIGNED_BOTH = [
  { role: 'main', signed_at: SIGNED_AT },
  { role: 'second', signed_at: SIGNED_AT },
];
/** The analyst re-signed after the change; the concurring reviewer did not. */
const SIGNED_MAIN_LATER = [
  { role: 'main', signed_at: new Date('2026-08-17T00:00:00Z') },
  { role: 'second', signed_at: SIGNED_AT },
];
/** The body the signature is about: written before it was signed. */
const WRITTEN_BEFORE = [{ created_at: new Date('2026-08-14T00:00:00Z') }];
/** The body written after — rule 4's case. */
const WRITTEN_AFTER = [{ created_at: new Date('2026-08-16T00:00:00Z') }];
/** The run the signature is about: computed before it was signed. */
const CALC = [{ id: 'calc-1', status: 'succeeded', created_at: new Date('2026-08-13T00:00:00Z') }];
/** The run computed after — rule 5's case. */
const RECALCULATED = [{ id: 'calc-2', status: 'succeeded', created_at: new Date('2026-08-16T00:00:00Z') }];
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

  it('blocks publish when the body has been saved since it was signed', async () => {
    // Rule 4, and the reason it is not rule 3 wearing a different hat: the
    // review below graded the current body and passed, so every QA rule is
    // satisfied. What has not been satisfied is the certification page, which
    // prints the analyst's name and the date they signed against prose written
    // the day after.
    await expect(
      assertPublishGate(
        poolWith({
          signatures: SIGNED,
          calculations: CALC,
          reports: REPORT_V4,
          reportVersions: WRITTEN_AFTER,
          qaReviews: [{ status: 'pass', report_version: 4 }],
        }),
        'v1',
        'published',
      ),
    ).rejects.toMatchObject({ status: 409, detail: expect.stringContaining('since it was signed') });
  });

  it('blocks publish when the engine has been re-run since it was signed', async () => {
    // Rule 5. Every QA rule is satisfied — the review below grades the *new*
    // run and the body nobody touched — and rule 4 passes, because a
    // recalculation writes no report version. What has changed is the concluded
    // value: the summary page, the exhibits and the per-share figure are
    // resolved from the newest run at render time, so the certification page
    // would print the analyst's name and the 15th against a number computed on
    // the 16th.
    await expect(
      assertPublishGate(
        poolWith({
          signatures: SIGNED,
          calculations: RECALCULATED,
          reports: REPORT_V4,
          qaReviews: [{ status: 'pass', report_version: 4 }],
        }),
        'v1',
        'published',
      ),
    ).rejects.toMatchObject({ status: 409, detail: expect.stringContaining('recalculated since it was signed') });
  });

  it('applies the recalculation rule to an engagement with no report body', async () => {
    // Rule 5 sits before rule 4's `if (!report) return`, because a conclusion
    // outlives the absence of a report: the auditor portal and the partner API
    // both serve `equity_value` / `fmv_per_share` off this same latest run.
    await expect(
      assertPublishGate(
        poolWith({
          signatures: SIGNED,
          calculations: RECALCULATED,
          reports: [],
          qaReviews: [{ status: 'pass', report_version: null }],
        }),
        'v1',
        'published',
      ),
    ).rejects.toMatchObject({ status: 409, detail: expect.stringContaining('recalculated since it was signed') });
  });

  /*
   * R380: the certification page prints a dated line per signatory, and rules 4
   * and 5 read `main` alone. So the sequence rule 4 exists to stop stayed open
   * one row over — the analyst re-signs after the edit, the concurring reviewer
   * does not, and the deliverable goes out with their line dated before the
   * body it certifies.
   */
  it('blocks publish when only the second signature predates the body', async () => {
    await expect(
      assertPublishGate(
        poolWith({
          signatures: SIGNED_MAIN_LATER,
          calculations: CALC,
          reports: REPORT_V4,
          qaReviews: [{ status: 'pass', report_version: 4 }],
          reportVersions: WRITTEN_AFTER,
        }),
        'v1',
        'published',
      ),
    ).rejects.toMatchObject({
      status: 409,
      detail: expect.stringContaining('second signature was given'),
    });
  });

  it('blocks publish when only the second signature predates the calculation', async () => {
    await expect(
      assertPublishGate(
        poolWith({
          signatures: SIGNED_MAIN_LATER,
          calculations: RECALCULATED,
          reports: REPORT_V4,
          qaReviews: [{ status: 'pass', report_version: 4 }],
        }),
        'v1',
        'published',
      ),
    ).rejects.toMatchObject({
      status: 409,
      detail: expect.stringContaining('second signature was given'),
    });
  });

  it('names both signatories when both predate the change', async () => {
    await expect(
      assertPublishGate(
        poolWith({
          signatures: SIGNED_BOTH,
          calculations: RECALCULATED,
          reports: REPORT_V4,
          qaReviews: [{ status: 'pass', report_version: 4 }],
        }),
        'v1',
        'published',
      ),
    ).rejects.toMatchObject({ status: 409, detail: expect.stringContaining('both signatures on file') });
  });

  it('allows publish when both signatories signed after the change', async () => {
    // The optional row is held to currency, not to existence: a second
    // signature given after the edit is as good as the analyst's.
    await expect(
      assertPublishGate(
        poolWith({
          signatures: SIGNED_BOTH,
          calculations: CALC,
          reports: REPORT_V4,
          qaReviews: [{ status: 'pass', report_version: 4 }],
        }),
        'v1',
        'published',
      ),
    ).resolves.toBeUndefined();
  });

  it('asks about the QA review before it asks about the re-signing', async () => {
    // The remedy for a recalculation is two steps in an order: re-run QA over
    // the new run, then sign what QA cleared. A gate that named the signature
    // first would send the operator to sign a run no reviewer had graded, and
    // they would be back here a moment later — rule 4's own argument.
    await expect(
      assertPublishGate(
        poolWith({ signatures: SIGNED, calculations: RECALCULATED, reports: REPORT_V4 }),
        'v1',
        'published',
      ),
    ).rejects.toMatchObject({ detail: expect.stringContaining('QA review') });
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
