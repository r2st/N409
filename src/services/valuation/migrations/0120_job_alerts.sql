-- The job monitor reports, and nothing alerts (design §17.1 item 13).
--
-- `GET /admin/jobs/stats` has served `oldest_active_at` per queue since the
-- monitor shipped, with a comment saying it is the figure an alert should
-- eventually be built on — because a count cannot tell a busy queue from a
-- stopped one. Five hundred queued emails is a Monday morning; one email queued
-- since Thursday is a dead transport. This is that alert.
--
-- Two tables, and the split is the point:
--
--   * `job_alert_rules` is the threshold per queue, editable by an operator.
--     Thresholds that live in code are thresholds nobody tunes, and an alert
--     nobody tunes is an alert everybody mutes. Seeded per source below with
--     values that reflect what each queue actually promises: an AI job that has
--     been running for two hours is wedged, an outbox message that has been
--     queued for two hours is a broken SMTP host, and a pipeline run has a
--     reaper of its own so its window is wider.
--
--   * `job_alerts` is the fired alert, opened once and resolved once. The
--     partial unique index below is what makes it once: without it, a scan
--     every five minutes against a queue that stays stopped for a day writes
--     288 identical rows and notifies 288 times, which is how an operator
--     learns to ignore the channel.
--
-- Resolution is automatic and recorded rather than deleted. "This queue was
-- stalled for six hours on the 3rd" is the question someone asks a week later,
-- and a row that disappears when the problem goes away cannot answer it.

CREATE TABLE IF NOT EXISTS job_alert_rules (
  -- One of domain/jobQueue.ts JOB_SOURCES. Text, not an enum: the source list
  -- is a product decision and an unknown key here is inert rather than a
  -- broken insert — the same call 0116 made for research topics.
  source              text PRIMARY KEY,
  enabled             boolean NOT NULL DEFAULT true,
  -- Age of the oldest still-owed job before the queue is called stalled.
  stall_minutes       integer NOT NULL CHECK (stall_minutes > 0),
  -- Failures inside the window before the queue is called failing.
  failure_count       integer NOT NULL CHECK (failure_count > 0),
  failure_window_hours integer NOT NULL DEFAULT 24 CHECK (failure_window_hours > 0),
  updated_by          ulid REFERENCES users(id) ON DELETE SET NULL,
  updated_at          timestamptz NOT NULL DEFAULT now()
);

INSERT INTO job_alert_rules (source, stall_minutes, failure_count, failure_window_hours) VALUES
  -- Orchestration, with its own reaper on AUTO_PIPELINE_STALE_MINUTES. The
  -- window is wider than the reaper's so the alert fires at a run the reaper
  -- could not rescue, not at every run it is about to.
  ('pipeline_run',     120, 5, 24),
  -- A model call has a 120s budget upstream; an hour outstanding is wedged.
  ('ai_job',            60, 5, 24),
  -- Written once the engine returns, so it is never in flight — only the
  -- failure rule can fire. The stall threshold is set high rather than null so
  -- the column keeps one meaning across every row.
  ('calculation',     1440, 3, 24),
  -- Queued mail that has not moved in two hours is a dead transport, and this
  -- is the queue a client notices from the outside.
  ('email',            120, 10, 24),
  ('webhook_delivery', 120, 10, 24)
ON CONFLICT (source) DO NOTHING;

CREATE TABLE IF NOT EXISTS job_alerts (
  id          ulid PRIMARY KEY,
  source      text NOT NULL,
  kind        text NOT NULL CHECK (kind IN ('stalled', 'failing')),
  -- Human-readable at the moment it fired: "oldest queued job is 4h 12m old".
  detail      text NOT NULL,
  -- The measured figure that crossed the threshold (minutes, or a count), and
  -- the threshold it crossed. Kept so a resolved alert still says how bad it
  -- got without re-deriving it from tables that have since moved on.
  observed    numeric(14, 2) NOT NULL,
  threshold   numeric(14, 2) NOT NULL,
  opened_at   timestamptz NOT NULL DEFAULT now(),
  -- Bumped by every scan that still sees the condition, so an open alert shows
  -- how long it has been going rather than only when it started.
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz
);

-- One open alert per (queue, kind). This is the whole anti-spam mechanism.
CREATE UNIQUE INDEX IF NOT EXISTS job_alerts_open_uq
  ON job_alerts (source, kind) WHERE resolved_at IS NULL;

CREATE INDEX IF NOT EXISTS job_alerts_recent_idx ON job_alerts (opened_at DESC);

COMMENT ON TABLE job_alert_rules IS
  'Per-queue alert thresholds for the background job monitor; editable by operations.';
COMMENT ON TABLE job_alerts IS
  'Fired job-queue alerts, opened once per (source, kind) and resolved when the condition clears.';
