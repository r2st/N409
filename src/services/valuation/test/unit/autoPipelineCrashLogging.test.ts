import { describe, expect, it, vi } from 'vitest';
import { resumePipelineRun, type AutoPipelineDeps } from '../../src/pipeline/autoPipeline.js';
import type { PipelineRunRow } from '../../src/repos/pipelineRuns.js';
import type { ValuationRow } from '../../src/repos/valuations.js';

/**
 * The outermost catch of the platform's core async worker (R428, methodology M11).
 *
 * `executeRun` records its own failure and then settles the row; when *that*
 * write is what fails, the rejection escapes to `queueRun`'s catch — and the
 * row is left in an active status holding its valuation's one-active-run index
 * until `reapStalePipelineRuns` takes it.
 *
 * That catch was a hand-picked `error` with no classification and no
 * `alert: true`, which `shared/failure.ts` makes into two problems at once:
 * over-severe for a pool blip the reaper is coming for, and missing the one
 * field that decides whether a ticket fires for a failure only a person can
 * fix. Since R376 `alert: true` is counted at the logger as
 * `log_alert_lines_total`, so the flag is the alerting channel rather than
 * decoration.
 *
 * Exercised through `resumePipelineRun` because that is the entry point that
 * needs no request: it is the door the retry sweep uses, and it shares
 * `queueRun` with the upload path.
 */

const RUN = {
  id: '01HRUN',
  valuation_id: '01HVAL',
  status: 'queued',
  triggered_by: 'retry-sweep',
  attempts: 1,
} as unknown as PipelineRunRow;

const VALUATION = { id: '01HVAL', archived_at: null } as unknown as ValuationRow;

function harness(queryError: Error) {
  const log = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
  };
  const deps = {
    // Both doors: the run's own work goes through `query`, and
    // `setPipelineRunStatus` — the write whose failure is the whole subject
    // here — takes a client off `connect` for its transaction.
    pool: {
      query: vi.fn(async () => Promise.reject(queryError)),
      connect: vi.fn(async () => Promise.reject(queryError)),
    },
    aiUrl: 'http://ai.invalid',
    engineUrl: 'http://engine.invalid',
    documentsDir: '/tmp/n409-does-not-matter',
    enabled: true,
    log,
  } as unknown as AutoPipelineDeps;
  return { deps, log };
}

/** The limiter and the catch are both async; let the microtasks drain. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('a run whose failure could not be recorded', () => {
  it('logs the crash through the alerting contract rather than a hand-picked level', async () => {
    // An undefined column: permanent by the shared classifier, and the shape
    // that means a statement will fail identically on every attempt for ever.
    // This is the arm that wants a person, and therefore wants the flag.
    const err = Object.assign(new Error('column "gone" does not exist'), { code: '42703' });
    const { deps, log } = harness(err);

    resumePipelineRun(deps, RUN, VALUATION);
    await settle();

    const crash = log.error.mock.calls.find((c) => c[1] === 'auto-pipeline retry crashed');
    expect(crash, 'the crash was not logged at all').toBeDefined();
    const fields = crash![0] as Record<string, unknown>;
    // The field a rule fires on. Without it the line is one of forty thousand.
    expect(fields.alert).toBe(true);
    // A token something can group by, rather than the error's own sentence.
    expect(fields.failure_kind).toBe('permanent');
    expect(fields.failure_reason).toBe('pg.42703');
    // Still says which run, which is the only way to find the stuck row.
    expect(fields.runId).toBe('01HRUN');
    expect(fields.valuationId).toBe('01HVAL');
  });

  it('grades a transient failure down to warn, because the reaper is coming', async () => {
    /*
     * `reapStalePipelineRuns` settles exactly this shape — a run left in an
     * active status — stamping `failure_kind = 'transient'` and a
     * `next_attempt_at` the retry sweep reads. That is a real retry, so the
     * contract's downgrade is honest here and paging on it would be noise.
     */
    const err = Object.assign(new Error('connection terminated unexpectedly'), { code: '57P01' });
    const { deps, log } = harness(err);

    resumePipelineRun(deps, RUN, VALUATION);
    await settle();

    const crash = log.warn.mock.calls.find((c) => c[1] === 'auto-pipeline retry crashed');
    expect(crash, 'a transient crash should not be an error line').toBeDefined();
    const fields = crash![0] as Record<string, unknown>;
    expect(fields.failure_kind).toBe('transient');
    // No flag: the contract reserves it for the failures no retry is coming
    // for, and stamping it here would double-signal against the reaper.
    expect(fields.alert).toBeUndefined();
    expect(
      log.error.mock.calls.find((c) => c[1] === 'auto-pipeline retry crashed'),
    ).toBeUndefined();
  });
});
