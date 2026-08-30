import type pg from 'pg';
import { emailWithheldSql, suppressionExemptSql } from './emailOutbox.js';
import {
  JOB_SOURCES,
  JOB_STATUS_MAP,
  normalizeJobStatus,
  type JobRow,
  type JobSource,
  type JobStats,
  type JobStatus,
} from '../domain/jobQueue.js';

/**
 * The unified job feed — five tables read as one queue (409.ai's Published
 * Tasks page).
 *
 * A UNION ALL over five heterogeneous tables rather than a jobs table they all
 * write to. The alternative was tempting and wrong: a shared queue table means
 * every one of the five writes twice, in the same transaction, forever, to
 * populate a read-only page. The cost of the union is that this file has to
 * know all five schemas; the cost of the table would have been that all five
 * have to know about this page. The dependency points the right way here.
 *
 * Every branch projects the same nine columns in the same order, and each
 * carries its own status vocabulary through as `detail` — `domain/jobQueue.ts`
 * maps it onto the common scale. The mapping is applied in SQL rather than in
 * JS because the status *filter* has to run before LIMIT, and a filter applied
 * after paging is not a filter.
 */

export interface JobFilter {
  source?: JobSource;
  status?: JobStatus;
  valuationId?: string;
  page: number;
  perPage: number;
}

/** `CASE native WHEN … THEN 'queued' … END` for one source, built from the map. */
function statusCase(source: JobSource, column: string): string {
  const entries = Object.entries(JOB_STATUS_MAP[source]);
  const whens = entries.map(([native, common]) => `WHEN '${native}' THEN '${common}'`).join(' ');
  // ELSE mirrors normalizeJobStatus: an unmapped state is in flight and
  // unexplained, which belongs in front of an operator rather than hidden.
  return `CASE ${column}::text ${whens} ELSE 'running' END`;
}

/**
 * The five SELECT branches. `name` is whatever identifies the unit of work to
 * a person reading the row: the pipeline the AI job ran, the template the
 * message used, the event the webhook carried.
 *
 * `due_at` is the earliest moment the row's own worker may pick it up — the
 * same predicate that queue's claim uses, restated here. For three of the five
 * that is simply when the row was created; two carry a retry ladder, and for
 * those "still owed" and "owed *now*" are different questions. See
 * `oldestActiveJobs`, which is the only reader that needs the distinction.
 */
function branch(source: JobSource): string {
  switch (source) {
    case 'pipeline_run':
      return `
        SELECT p.id, 'pipeline_run' AS source, ${statusCase('pipeline_run', 'p.status')} AS status,
               p.status::text AS detail, p.trigger AS name,
               p.valuation_id, p.error, NULL::integer AS attempts,
               -- 0161's ladder only ever schedules a *failed* run, which is
               -- never active, so an in-flight run is owed the moment it exists.
               p.created_at, p.created_at AS due_at,
               CASE WHEN p.status IN ('ready','failed') THEN p.updated_at END AS finished_at
        FROM pipeline_runs p`;
    case 'ai_job':
      return `
        SELECT j.id, 'ai_job' AS source, ${statusCase('ai_job', 'j.status')} AS status,
               j.status::text AS detail, j.pipeline::text AS name,
               j.valuation_id, j.error, NULL::integer AS attempts,
               j.created_at, j.created_at AS due_at, j.completed_at AS finished_at
        FROM ai_jobs j`;
    case 'calculation':
      return `
        SELECT c.id, 'calculation' AS source, ${statusCase('calculation', 'c.status')} AS status,
               c.status::text AS detail, c.engine_version AS name,
               c.valuation_id, c.error, NULL::integer AS attempts,
               -- A calculation row is written when the engine returns, so its
               -- start and end are the same instant and duration is always 0.
               -- Recorded honestly rather than left null: 0 is what we know.
               c.created_at, c.created_at AS due_at, c.created_at AS finished_at
        FROM calculations c`;
    case 'email':
      return `
        SELECT e.id, 'email' AS source, ${statusCase('email', 'e.status')} AS status,
               e.status::text AS detail, e.template_key AS name,
               e.valuation_id, e.error, e.attempts,
               -- 0159: NULL means "no wait" — a fresh row, or one whose ladder
               -- is spent. claimRetryableEmails reads it the same way.
               e.created_at, coalesce(e.next_attempt_at, e.created_at) AS due_at,
               e.sent_at AS finished_at
        FROM email_outbox e`;
    case 'webhook_delivery':
      return `
        SELECT d.id, 'webhook_delivery' AS source, ${statusCase('webhook_delivery', 'd.status')} AS status,
               d.status::text AS detail, d.event_type AS name,
               d.valuation_id, d.last_error AS error, d.attempts,
               -- 0103: NOT NULL, defaulted to now() on insert, and moved up the
               -- ladder by every failed attempt. claimDueDeliveries claims on
               -- next_attempt_at <= now(), and this must agree with it.
               d.created_at, d.next_attempt_at AS due_at, d.delivered_at AS finished_at
        FROM partner_webhook_deliveries d`;
  }
}

function unionSql(sources: readonly JobSource[]): string {
  return sources.map(branch).join('\n        UNION ALL\n');
}

export interface JobPage {
  items: JobRow[];
  total: number;
}

export async function listJobs(pool: pg.Pool, filter: JobFilter): Promise<JobPage> {
  const sources = filter.source ? [filter.source] : JOB_SOURCES;
  const params: unknown[] = [];
  const where: string[] = [];
  if (filter.status) {
    params.push(filter.status);
    where.push(`j.status = $${params.length}`);
  }
  if (filter.valuationId) {
    params.push(filter.valuationId);
    where.push(`j.valuation_id = $${params.length}`);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  // The valuation join is on the outside of the union: five copies of it
  // inside would be five index lookups per row for one label.
  const from = `
    FROM (${unionSql(sources)}) j
    LEFT JOIN valuations v ON v.id = j.valuation_id
    ${whereSql}`;

  const { rows: counts } = await pool.query<{ total: string }>(
    `SELECT count(*)::text AS total ${from}`,
    params,
  );

  const offset = (filter.page - 1) * filter.perPage;
  params.push(filter.perPage, offset);
  const { rows } = await pool.query<Omit<JobRow, 'duration_ms'>>(
    `SELECT j.id, j.source, j.status, j.detail, j.name, j.valuation_id,
            j.error, j.attempts, j.created_at, j.due_at, j.finished_at,
            v.number AS valuation_number, v.company_name
     ${from}
     ORDER BY j.created_at DESC, j.id DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );

  return {
    items: rows.map((r) => ({
      ...r,
      // Computed here rather than in SQL so the five branches stay symmetric —
      // three of them would need a different expression for it.
      duration_ms: r.finished_at ? r.finished_at.getTime() - r.created_at.getTime() : null,
      status: normalizeJobStatus(r.source, r.detail),
    })),
    total: Number(counts[0]?.total ?? 0),
  };
}

/**
 * Per-(source, status) counts over a trailing window.
 *
 * Windowed because the totals are a health signal, and an all-time count is
 * not one: after a year of successful sends a header reading "412,000
 * succeeded, 3 failed" says nothing about whether mail is working today.
 */
export async function jobStats(pool: pg.Pool, sinceHours: number): Promise<JobStats[]> {
  const { rows } = await pool.query<{ source: JobSource; status: JobStatus; count: string }>(
    `SELECT j.source, j.status, count(*)::text AS count
     FROM (${unionSql(JOB_SOURCES)}) j
     WHERE j.created_at > now() - make_interval(hours => $1::integer)
        -- Anything still owed is shown however old it is. A run that queued
        -- eight days ago and never moved is the single most important row on
        -- this page, and a trailing window is exactly what would hide it.
        OR j.status IN ('queued', 'running')
     GROUP BY j.source, j.status`,
    [sinceHours],
  );
  return rows.map((r) => ({ source: r.source, status: r.status, count: Number(r.count) }));
}

/**
 * The database's wall clock.
 *
 * Every timestamp the monitor reads — `created_at` on all five queues — is
 * written by Postgres, so the only clock that can be subtracted from them
 * without inventing an error term is Postgres'. The application process runs
 * on a different host with a different clock, and the difference is not
 * hypothetical: a few milliseconds of drift is normal on a container host and
 * a second or more is unremarkable against a managed database. That error
 * lands in two places that matter — the age an operator reads in the alert,
 * and the `minutes > stall_minutes` comparison that decides whether the alert
 * fires at all.
 *
 * `clock_timestamp()` rather than `now()`: `now()` is transaction start, and a
 * sweep that reads it inside a longer transaction would time the transaction
 * instead of the queue.
 */
export async function dbNow(pool: pg.Pool): Promise<Date> {
  const { rows } = await pool.query<{ at: Date }>('SELECT clock_timestamp() AS at');
  return new Date(rows[0]!.at);
}

/**
 * The oldest job a worker could have picked up by now and has not — "how far
 * behind is each queue".
 *
 * A count of active jobs cannot distinguish a busy queue from a stopped one.
 * An age can, and this is the number `evaluateJobAlerts` compares against
 * `stall_minutes`.
 *
 * **Owed is not the same as owed *now*.** Two of the five queues express a
 * deliberate wait as an active status: a webhook delivery backing off sits at
 * `pending` (0103/0139) and an outbox row can carry a schedule (0159). Anchor
 * the age at `created_at` and a receiver that is merely down reads as a stalled
 * queue — 0139 widened the webhook ladder to 1+5+30+120+360 minutes precisely
 * so an overnight outage would be survived, which put every retry past the
 * 120-minute `stall_minutes` 0120 chose when the ladder only reached 36. The
 * alert then fires on the mechanism working: a partner's receiver goes down for
 * three hours, and an operator is paged about *our* webhook queue.
 *
 * So both halves come from `due_at` — the row's own claim predicate:
 *
 *   * a row not yet due is not counted at all. Nothing is late about it, and
 *     it will become due on its own;
 *   * the age is measured from when the row *became* due, not from when it was
 *     created, so it reads as "how long has the worker not touched this".
 *
 * This keeps the threshold sensitive rather than blinding it. A webhook sweep
 * that has genuinely stopped still crosses 120 minutes, because its due rows
 * stay due; a healthy sweep never has a row overdue by more than its interval.
 * The counts on the page are unaffected — `jobStats` still shows every pending
 * delivery, and `observeQueues` takes `active` from there.
 *
 * `now()` rather than `clock_timestamp()`, deliberately, and unlike `dbNow`:
 * this predicate must agree with the claim it is mirroring
 * (`claimDueDeliveries`, `claimRetryableEmails`), and those read `now()`.
 */
export async function oldestActiveJobs(
  pool: pg.Pool,
): Promise<Array<{ source: JobSource; oldest_due_at: Date; active: number }>> {
  const { rows } = await pool.query<{ source: JobSource; oldest_due_at: Date; active: string }>(
    `SELECT j.source, min(j.due_at) AS oldest_due_at, count(*)::text AS active
     FROM (${unionSql(JOB_SOURCES)}) j
     WHERE j.status IN ('queued', 'running')
       AND j.due_at <= now()
       -- …and the outbox's other half of the claim predicate: the four facts
       -- that hold a row back without scheduling it (emailWithheldSql). A row
       -- the sweep will never take is not a queue running late — it is work
       -- nobody is waiting on, and it sits at due_at = created_at getting older
       -- every minute. So one message for a closed account made this queue read
       -- as an ever-worsening stall, which is the alert that exists to say a
       -- dead SMTP host has left one email queued since Thursday. And because
       -- an alert is keyed (source, kind) and announced once, that row held
       -- email/stalled open and the real outage after it announced nothing.
       --
       -- A semi-join over the queued rows rather than a fourth subquery inside
       -- the union: this predicate belongs to one of the five sources, the
       -- union is what every other reader of these branches pays for, and only
       -- rows the outer filter would have counted need testing at all.
       AND NOT (
         j.source = 'email'
         AND j.id IN (
           SELECT e.id FROM email_outbox e
            WHERE e.status = 'queued' AND ${emailWithheldSql('e', suppressionExemptSql())}
         )
       )
     GROUP BY j.source
     ORDER BY oldest_due_at ASC`,
  );
  return rows.map((r) => ({ ...r, active: Number(r.active) }));
}
