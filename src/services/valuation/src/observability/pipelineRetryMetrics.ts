import type { Counter, MetricsRegistry } from '@n409/shared';

/**
 * What happened to each run the pipeline retry sweep claimed.
 *
 * WHY THIS EXISTS (R451, methodology M11). The sweep reports a single
 * `claimed` count into `background_sweep_items_total`, which says how busy the
 * retry ladder is but not what it decided. A claimed run can be resumed
 * (handed to the concurrency limiter), skipped (the valuation was retired or
 * opted out between the failure and the retry), deleted (the valuation was
 * purged), or stranded (something threw while deciding). The last one blocks
 * the valuation's one-active-run index until the stale reaper frees it — the
 * costliest outcome on this table — and it was visible only in a `warn` line
 * the sweep already writes, with no series a rule could threshold on.
 *
 * `skipped_retired` and `skipped_opted_out` are kept apart because they have
 * different fixes: one is an operational withdrawal, the other is a per-
 * engagement setting somebody changed. Both are `permanent` failures on the
 * run, but a rise in one is a different conversation from a rise in the other.
 */
let outcomes: Counter | null = null;

export type PipelineRetryOutcome =
  | 'resumed'
  | 'skipped_retired'
  | 'skipped_opted_out'
  | 'skipped_deleted'
  | 'stranded';

export function registerPipelineRetryMetrics(registry: MetricsRegistry): void {
  outcomes = registry.counter(
    'pipeline_retry_outcomes_total',
    'What happened to each run the pipeline retry sweep claimed, per outcome.',
    ['outcome'],
  );
}

export function resetPipelineRetryMetrics(): void {
  outcomes = null;
}

export function recordPipelineRetryOutcome(outcome: PipelineRetryOutcome): void {
  outcomes?.inc({ outcome });
}
