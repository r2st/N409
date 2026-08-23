/**
 * The background-work vocabulary — one status scale across five queues.
 *
 * The platform runs background work in five places and each invented its own
 * words for the same four outcomes: a pipeline run is `queued | extracting |
 * calculating | ready | failed`, an AI job is `running | succeeded | failed`,
 * an outbox message is `queued | sent | failed | skipped`, a webhook delivery
 * is `pending | delivered | failed`, and a calculation is `succeeded | failed`
 * with no in-flight state at all because it is written once it is over.
 *
 * Each of those five is right for its own table — `extracting` is genuinely
 * more informative than `running` when you are looking at a pipeline. What
 * none of them supports is the question an operator actually opens a job page
 * with, which is "is anything stuck or broken right now", across all five at
 * once. That needs one scale, so this is it, and each table's native status is
 * carried alongside as `detail` rather than thrown away.
 *
 * `skipped` is not an error and must not read as one: an outbox row is skipped
 * when the recipient's notification preferences say not to send, which is the
 * system working. It gets its own terminal status rather than being folded
 * into `succeeded`, because "we deliberately did not send this" is the answer
 * to a support question that "sent" would answer wrongly.
 */

export const JOB_SOURCES = ['pipeline_run', 'ai_job', 'calculation', 'email', 'webhook_delivery'] as const;
export type JobSource = (typeof JOB_SOURCES)[number];

export const JOB_SOURCE_LABELS: Record<JobSource, string> = {
  pipeline_run: 'Pipeline run',
  ai_job: 'AI job',
  calculation: 'Calculation',
  email: 'Outbound message',
  webhook_delivery: 'Webhook delivery',
};

export const JOB_STATUSES = ['queued', 'running', 'succeeded', 'failed', 'skipped'] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

/** Statuses that mean the work is still owed — what a "stuck" query looks at. */
export const ACTIVE_JOB_STATUSES: readonly JobStatus[] = ['queued', 'running'];

/**
 * Native status → the common scale. Exported per source rather than as one
 * merged map because two sources use the same word for different things:
 * `queued` is pre-work in `pipeline_runs` and also pre-work in `email_outbox`,
 * but `pending` is pre-work in `partner_webhook_deliveries`, and a single flat
 * map would hide which table each key came from.
 */
export const JOB_STATUS_MAP: Record<JobSource, Record<string, JobStatus>> = {
  pipeline_run: {
    queued: 'queued',
    extracting: 'running',
    calculating: 'running',
    ready: 'succeeded',
    failed: 'failed',
  },
  ai_job: { running: 'running', succeeded: 'succeeded', failed: 'failed' },
  // Written only once the engine has returned, so it is never in flight.
  calculation: { succeeded: 'succeeded', failed: 'failed' },
  email: { queued: 'queued', sent: 'succeeded', failed: 'failed', skipped: 'skipped' },
  webhook_delivery: { pending: 'queued', delivered: 'succeeded', failed: 'failed' },
};

/**
 * An unmapped native status resolves to `running` rather than throwing.
 *
 * A status this file has not heard of means a table grew a state and nobody
 * updated the map. The honest reading of that is "in flight, and we do not
 * know what it is doing" — which puts it in front of an operator on the
 * default filter, where they will notice it. Mapping it to `failed` would page
 * someone over a deployment ordering problem; mapping it to `succeeded` would
 * hide a queue that had genuinely stopped.
 */
export function normalizeJobStatus(source: JobSource, native: string): JobStatus {
  return JOB_STATUS_MAP[source][native] ?? 'running';
}

export interface JobRow {
  id: string;
  source: JobSource;
  status: JobStatus;
  /** The queue's own word for it — `extracting`, `skipped`, `pending`. */
  detail: string;
  /** What this job is about: the pipeline name, template key, or event type. */
  name: string;
  valuation_id: string | null;
  valuation_number: string | null;
  company_name: string | null;
  error: string | null;
  attempts: number | null;
  created_at: Date;
  /**
   * The earliest moment a worker may pick this row up.
   *
   * Equal to `created_at` for three of the five queues; for an outbox row and a
   * webhook delivery it is the retry ladder's next step, and it is the only
   * thing on the row that separates "queued, and nothing is taking it" from
   * "queued, and deliberately not due until 06:00". Both read `queued` on the
   * common scale and both read `pending` in the queue's own words, so without
   * this the page cannot tell an operator which one they are looking at — the
   * same question the stall alert was getting wrong. Meaningless on a settled
   * row, where it is whatever the last attempt left behind.
   */
  due_at: Date;
  finished_at: Date | null;
  /** Wall-clock ms where both ends are known, else null. */
  duration_ms: number | null;
}

export interface JobStats {
  source: JobSource;
  status: JobStatus;
  count: number;
}

/**
 * Roll the per-(source, status) counts into the four totals a header shows.
 * `skipped` is counted separately and deliberately excluded from both — it is
 * neither work outstanding nor work that failed.
 */
export function summarizeJobStats(stats: readonly JobStats[]): {
  active: number;
  failed: number;
  succeeded: number;
  skipped: number;
} {
  const total = (predicate: (s: JobStats) => boolean) =>
    stats.reduce((sum, s) => (predicate(s) ? sum + s.count : sum), 0);
  return {
    active: total((s) => ACTIVE_JOB_STATUSES.includes(s.status)),
    failed: total((s) => s.status === 'failed'),
    succeeded: total((s) => s.status === 'succeeded'),
    skipped: total((s) => s.status === 'skipped'),
  };
}
