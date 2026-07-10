-- 409.ai §15.5 + §15.6 — communication templates and auto email/SMS drip
-- campaigns.
--
-- communication_templates: DB-backed {{var}} templates. A row whose key
-- matches a built-in workflow/transactional templateKey overrides the
-- hard-coded content when enabled; enabled = false falls back to the code
-- default (never suppresses the send). Drip campaigns reference templates by
-- key and have no code fallback, so their template must exist and be enabled.
--
-- auto_emails: lifecycle-triggered sequences. A campaign fires for valuations
-- sitting in trigger_state for at least delay_hours (measured from the
-- state_changed event), subject to condition, at most max_sends times with
-- repeat_hours between sends.

CREATE TYPE comm_channel AS ENUM ('email', 'sms');

CREATE TABLE communication_templates (
  id          ulid PRIMARY KEY,
  key         text NOT NULL UNIQUE CHECK (key ~ '^[a-z0-9_]+$'),
  channel     comm_channel NOT NULL DEFAULT 'email',
  description text NOT NULL DEFAULT '',
  subject     text NOT NULL DEFAULT '',   -- unused for sms
  body        text NOT NULL,
  enabled     boolean NOT NULL DEFAULT true,
  updated_by  ulid REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE auto_emails (
  id            ulid PRIMARY KEY,
  name          text NOT NULL UNIQUE CHECK (name ~ '^[a-z0-9_]+$'),
  channel       comm_channel NOT NULL DEFAULT 'email',
  trigger_state valuation_state NOT NULL,
  condition     text NOT NULL DEFAULT 'always'
                CHECK (condition IN ('always', 'unpaid', 'no_documents', 'waiting_on_client')),
  delay_hours   integer NOT NULL DEFAULT 24 CHECK (delay_hours >= 0),
  repeat_hours  integer CHECK (repeat_hours > 0),
  max_sends     integer NOT NULL DEFAULT 1 CHECK (max_sends BETWEEN 1 AND 10),
  template_key  text NOT NULL REFERENCES communication_templates(key) ON UPDATE CASCADE,
  enabled       boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE auto_email_sends (
  id            ulid PRIMARY KEY,
  auto_email_id ulid NOT NULL REFERENCES auto_emails(id) ON DELETE CASCADE,
  valuation_id  ulid NOT NULL REFERENCES valuations(id) ON DELETE CASCADE,
  outbox_id     ulid REFERENCES email_outbox(id),
  sent_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX auto_email_sends_lookup
  ON auto_email_sends (auto_email_id, valuation_id, sent_at DESC);

-- SMS rides the same outbox (status/attempts/audit UI come for free); for
-- channel = 'sms' the to_email column carries the destination phone number.
ALTER TABLE email_outbox ADD COLUMN channel comm_channel NOT NULL DEFAULT 'email';

-- ── Seeds ─────────────────────────────────────────────────────────────────────
-- Workflow keys mirror domain/emailWorkflows.ts defaults so ops start from the
-- real content; drip templates are new (the built-ins never send these).

INSERT INTO communication_templates (id, key, channel, description, subject, body) VALUES
  (
    '01N409CT000000000000000001',
    'valuation_started',
    'email',
    'Sent to the client when work on their valuation begins.',
    'We''ve started your {{kind_label}} valuation for {{company_name}}',
    'Work on your {{kind_label}} valuation for {{company_name}} has begun. We''ll let you know as soon as anything needs your input.'
  ),
  (
    '01N409CT000000000000000002',
    'review_needed',
    'email',
    'Sent to the assigned reviewer when a valuation is ready for review.',
    'Review needed: {{kind_label}} valuation for {{company_name}}',
    'The {{kind_label}} valuation for {{company_name}} is ready for review. Please pick it up in the dashboard.'
  ),
  (
    '01N409CT000000000000000003',
    'draft_ready',
    'email',
    'Sent to the client when a draft report is ready to accept or send back.',
    'Your draft {{kind_label}} valuation for {{company_name}} is ready',
    'A draft of your {{kind_label}} valuation for {{company_name}} is ready for your review. Sign in to accept it or request changes.'
  ),
  (
    '01N409CT000000000000000004',
    'valuation_completed',
    'email',
    'Sent to the client when the final report is published.',
    'Your {{kind_label}} valuation for {{company_name}} is complete',
    'Your {{kind_label}} valuation for {{company_name}} has been finalized and published. The report is available in your dashboard.'
  ),
  (
    '01N409CT000000000000000005',
    'valuation_cancelled',
    'email',
    'Sent to the client when a valuation is cancelled.',
    'Your {{kind_label}} valuation for {{company_name}} was cancelled',
    'Your {{kind_label}} valuation for {{company_name}} has been cancelled. Reply to this email if that''s unexpected.'
  ),
  (
    '01N409CT000000000000000006',
    'payment_reminder',
    'email',
    'Drip: nudges an unpaid valuation toward checkout.',
    'Payment pending for your {{kind_label}} valuation',
    'Your {{kind_label}} valuation for {{company_name}} is on hold until payment is completed. Sign in and finish checkout to keep your delivery date.'
  ),
  (
    '01N409CT000000000000000007',
    'document_upload_nudge',
    'email',
    'Drip: reminds clients who haven''t uploaded any documents yet.',
    'Documents needed for your {{kind_label}} valuation',
    'We''re ready to start on your {{kind_label}} valuation for {{company_name}}, but no documents have been uploaded yet. Upload your cap table and financials to get things moving.'
  ),
  (
    '01N409CT000000000000000008',
    'sms_payment_reminder',
    'sms',
    'Drip (SMS): payment reminder text.',
    '',
    '{{company_name}}: your {{kind_label}} valuation is waiting on payment. Finish checkout at your dashboard to keep your delivery date.'
  ),
  (
    '01N409CT000000000000000009',
    'sms_document_reminder',
    'sms',
    'Drip (SMS): document upload reminder text.',
    '',
    '{{company_name}}: we still need your documents to start the {{kind_label}} valuation. Upload them from your dashboard.'
  )
ON CONFLICT (key) DO NOTHING;

INSERT INTO auto_emails (id, name, channel, trigger_state, condition, delay_hours, repeat_hours, max_sends, template_key, enabled) VALUES
  ('01N409AE000000000000000001', 'payment_reminder_1', 'email', 'started', 'unpaid', 72, NULL, 1, 'payment_reminder', true),
  ('01N409AE000000000000000002', 'payment_reminder_2', 'email', 'started', 'unpaid', 168, NULL, 1, 'payment_reminder', true),
  ('01N409AE000000000000000003', 'document_upload_nudge', 'email', 'started', 'no_documents', 48, 96, 3, 'document_upload_nudge', true),
  ('01N409AE000000000000000004', 'sms_payment_reminder', 'sms', 'started', 'unpaid', 96, NULL, 1, 'sms_payment_reminder', false),
  ('01N409AE000000000000000005', 'sms_document_reminder', 'sms', 'started', 'no_documents', 96, NULL, 1, 'sms_document_reminder', false)
ON CONFLICT (name) DO NOTHING;
