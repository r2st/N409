-- The full auto email/SMS sequence set (409.ai §15.6).
--
-- 0051 built the drip machinery and seeded five campaigns — two payment
-- reminders, a document nudge and two SMS variants — because those were the
-- ones with an obvious trigger. What that left is a lifecycle where a client
-- hears from us at signup, at the draft, and at publication, and hears nothing
-- at all through the four states in between where the work actually waits on
-- them. Every unanswered "where is my valuation?" support ticket is one of
-- those silences.
--
-- This seeds the remaining twenty-two, for twenty-seven in total: an
-- acknowledgement on entering each client-visible state, escalating nudges for
-- each thing we are actually blocked on (intake, cap table, financials,
-- payment), reviewer-side reminders, and the post-publication sequence
-- (feedback, six-month material-event check-in, annual renewal) that turns a
-- one-off 409A into the recurring engagement it has to be.
--
-- Nothing here fires on its own: `delay_hours` is measured from entry into the
-- trigger state, every campaign is subject to its condition, and the
-- notification-preference matrix is still the client's kill switch.

-- ── New conditions ────────────────────────────────────────────────────────────
-- Each of these names something we are blocked on and can see in the schema.
-- "no_documents" was too coarse to nudge with: a client who uploaded a pitch
-- deck and nothing else is not someone to leave alone, but they no longer match
-- it. The SQL for each lives in repos/communications.ts alongside the existing
-- four; this constraint is the vocabulary.
ALTER TABLE auto_emails DROP CONSTRAINT auto_emails_condition_check;
ALTER TABLE auto_emails ADD CONSTRAINT auto_emails_condition_check
  CHECK (condition IN (
    'always',
    'unpaid',
    'no_documents',
    'waiting_on_client',
    -- Paid, so the message is about the work rather than the invoice.
    'paid',
    -- Questionnaire never submitted (or never started).
    'intake_incomplete',
    -- The one document the engine cannot proceed without.
    'no_captable',
    -- No income statement, balance sheet or projections of any vintage.
    'no_financials',
    -- Sitting in a review state with nobody assigned to it.
    'unassigned_reviewer',
    -- Published without the analyst signature block completed.
    'unsigned'
  ));

-- ── Templates ─────────────────────────────────────────────────────────────────

INSERT INTO communication_templates (id, key, channel, description, subject, body) VALUES
  (
    '01N409CT000000000000000010',
    'welcome',
    'email',
    'Sent immediately when a valuation is opened — sets expectations before anything is asked for.',
    'Welcome to your {{kind_label}} valuation',
    'Thanks for starting a {{kind_label}} valuation for {{company_name}}.

Here is what happens next: you tell us about the company, upload your cap table and financials, and our analysts build the model. Most engagements are delivered within five business days of the last document arriving.

You can check progress at any time from your dashboard.'
  ),
  (
    '01N409CT000000000000000011',
    'intake_reminder',
    'email',
    'Drip: the intake questionnaire has not been submitted.',
    'Finish the questionnaire for {{company_name}}',
    'Your {{kind_label}} valuation for {{company_name}} is waiting on the intake questionnaire.

It takes about ten minutes and it is what the analysts build the model from — nothing moves until it is in. Sign in and pick up where you left off.'
  ),
  (
    '01N409CT000000000000000012',
    'captable_reminder',
    'email',
    'Drip: no cap table uploaded.',
    'We still need a cap table for {{company_name}}',
    'The {{kind_label}} valuation for {{company_name}} cannot be modelled without a current cap table.

Upload it from your dashboard — a spreadsheet export from Carta, Pulley or your own workbook is fine, as long as it shows every class, its liquidation preference and the option pool.'
  ),
  (
    '01N409CT000000000000000013',
    'financials_reminder',
    'email',
    'Drip: no income statement, balance sheet or projections uploaded.',
    'Financials needed for {{company_name}}',
    'We have started on the {{kind_label}} valuation for {{company_name}} but have no financial statements on file.

Please upload the latest income statement and balance sheet, plus projections if you have them. Monthly and annual are both useful; upload whatever you keep.'
  ),
  (
    '01N409CT000000000000000014',
    'payment_final_notice',
    'email',
    'Drip: last payment notice before the engagement goes dormant.',
    'Final notice: payment outstanding for {{company_name}}',
    'The {{kind_label}} valuation for {{company_name}} has been on hold awaiting payment for two weeks.

If we do not hear from you we will pause the engagement and release the analyst slot. Reply to this email if the invoice needs to go somewhere else — we would rather fix it than close the file.'
  ),
  (
    '01N409CT000000000000000015',
    'onboarding_complete',
    'email',
    'Sent when onboarding is complete and the data-gathering phase opens.',
    'Onboarding complete for {{company_name}}',
    'Onboarding for your {{kind_label}} valuation of {{company_name}} is complete.

We have what we need to begin. If anything else is required we will ask for it specifically rather than send you a checklist.'
  ),
  (
    '01N409CT000000000000000016',
    'intake_complete',
    'email',
    'Sent when the client finishes their side of the data collection.',
    'Thanks — we have everything for {{company_name}}',
    'Everything we asked for on your {{kind_label}} valuation of {{company_name}} has arrived.

It is with the analysts now. You do not need to do anything until we send the draft.'
  ),
  (
    '01N409CT000000000000000017',
    'analysis_started',
    'email',
    'Sent when the engagement moves into analysis.',
    'Analysis has begun on {{company_name}}',
    'An analyst has picked up your {{kind_label}} valuation for {{company_name}}.

They may come back with questions about the cap table or the projections; answering those quickly is the single biggest thing that moves the delivery date.'
  ),
  (
    '01N409CT000000000000000018',
    'waiting_on_client',
    'email',
    'Drip: the engagement is explicitly blocked on a client answer.',
    'We are waiting on you for {{company_name}}',
    'Your {{kind_label}} valuation for {{company_name}} is paused pending an answer from your side.

Open the valuation and check the comments — the analyst has left the question there. The clock on your delivery date is stopped until it is answered.'
  ),
  (
    '01N409CT000000000000000019',
    'review_reminder',
    'email',
    'Drip (internal): a valuation has sat in review without a decision.',
    'Still awaiting review: {{company_name}}',
    'The {{kind_label}} valuation for {{company_name}} has been waiting on review. Please approve it or send it back with changes.'
  ),
  (
    '01N409CT000000000000000020',
    'reviewer_unassigned',
    'email',
    'Drip (internal): a valuation reached review with no reviewer assigned.',
    'Unassigned in review: {{company_name}}',
    'The {{kind_label}} valuation for {{company_name}} is in review with nobody assigned to it. Assign a reviewer from the worklist.'
  ),
  (
    '01N409CT000000000000000021',
    'draft_reminder',
    'email',
    'Drip: a shared draft has not been accepted or sent back.',
    'Your draft for {{company_name}} is still waiting',
    'The draft {{kind_label}} valuation for {{company_name}} is ready and has not been looked at yet.

Accept it and we will issue the final report, or request changes and it goes back to the analyst. Either is one click from your dashboard.'
  ),
  (
    '01N409CT000000000000000022',
    'changes_acknowledged',
    'email',
    'Sent when a client requests changes on a draft.',
    'We have your change requests for {{company_name}}',
    'Your change requests on the {{kind_label}} valuation for {{company_name}} are with the analyst.

We will send a revised draft once they are addressed. If any of them affect the conclusion of value we will say so explicitly rather than quietly restate it.'
  ),
  (
    '01N409CT000000000000000023',
    'draft_accepted',
    'email',
    'Sent when a client accepts the draft and the report goes to issue.',
    'Draft accepted for {{company_name}} — issuing the report',
    'Thanks for accepting the draft {{kind_label}} valuation for {{company_name}}.

The report is being finalised for issue. You will get the signed PDF and the supporting exhibits as soon as it is published.'
  ),
  (
    '01N409CT000000000000000024',
    'unsigned_report',
    'email',
    'Drip (internal): a published report has no analyst signature on file.',
    'Unsigned published report: {{company_name}}',
    'The {{kind_label}} valuation for {{company_name}} is published but carries no analyst signature. Complete the signature block.'
  ),
  (
    '01N409CT000000000000000025',
    'report_feedback',
    'email',
    'Sent a week after publication asking how the report landed.',
    'How was your {{kind_label}} valuation?',
    'Your {{kind_label}} valuation for {{company_name}} was issued last week.

If your board or auditor raised anything about it, tell us — we would rather answer it now than at your next audit. And if it went smoothly, we would appreciate hearing that too.'
  ),
  (
    '01N409CT000000000000000026',
    'material_event_check_in',
    'email',
    'Sent about six months after publication: material events invalidate a 409A early.',
    'Has anything changed at {{company_name}}?',
    'It has been about six months since your {{kind_label}} valuation for {{company_name}}.

A safe-harbour valuation stops being safe when something material happens — a priced round, a term sheet, an acquisition approach, a large customer won or lost, or a change in your forecast big enough that you would describe the business differently.

If any of those apply, you likely need a fresh valuation before your next grant. Reply and we will tell you either way.'
  ),
  (
    '01N409CT000000000000000027',
    'renewal_reminder',
    'email',
    'Sent about eleven months after publication: 409A safe harbour lapses at twelve.',
    'Your 409A for {{company_name}} expires soon',
    'Your {{kind_label}} valuation for {{company_name}} reaches twelve months shortly, at which point the safe harbour lapses and new option grants are no longer covered.

Reply and we will roll it forward. A renewal reuses the cap table and methodology we already hold, so it is materially faster than the first one.'
  ),
  (
    '01N409CT000000000000000028',
    'timeout_reengagement',
    'email',
    'Sent when an engagement times out for inactivity.',
    'Your {{kind_label}} valuation for {{company_name}} has gone quiet',
    'We have not been able to move your {{kind_label}} valuation for {{company_name}} forward, so it has been paused.

Nothing has been deleted. Sign in and it picks up exactly where it stopped — or reply and tell us what got in the way.'
  ),
  (
    '01N409CT000000000000000029',
    'cancelled_followup',
    'email',
    'Sent a week after a cancellation.',
    'About your cancelled {{kind_label}} valuation',
    'Your {{kind_label}} valuation for {{company_name}} was cancelled last week.

If that was a mistake, or the timing was simply wrong, reply and we will reopen it. If we got something wrong, we would genuinely like to know which part.'
  ),
  (
    '01N409CT000000000000000030',
    'ignored_reengagement',
    'email',
    'Sent to an engagement that was opened and then never touched.',
    'Still thinking about a valuation for {{company_name}}?',
    'You opened a {{kind_label}} valuation for {{company_name}} a while ago and did not take it any further.

If you are still weighing it up, the two questions we get most are what it costs and how long it takes — reply and we will answer both for your situation specifically. If the timing is wrong, ignore this and we will not chase again.'
  ),
  (
    '01N409CT000000000000000031',
    'sms_intake_reminder',
    'sms',
    'Drip (SMS): intake questionnaire reminder text.',
    '',
    '{{company_name}}: your {{kind_label}} valuation is waiting on the intake questionnaire. About ten minutes, from your dashboard.'
  )
ON CONFLICT (key) DO NOTHING;

-- ── Campaigns ─────────────────────────────────────────────────────────────────
-- Twenty-two new, on top of 0051's five, for the full twenty-seven.
--
-- The three post-publication campaigns are deliberately far out (168h / ~6mo /
-- ~11mo) and one-shot. `repeat_hours` is set only where a nudge is about
-- something the client can act on today; nothing about a delivered report
-- repeats.
--
-- The four internal ones (review_reminder, reviewer_unassigned, unsigned_report
-- and the escalating payment notices) go to the same recipient resolution as
-- every other campaign — the requester on the valuation — which for an internal
-- engagement is the analyst who opened it.

INSERT INTO auto_emails (id, name, channel, trigger_state, condition, delay_hours, repeat_hours, max_sends, template_key, enabled) VALUES
  -- Opening
  ('01N409AE000000000000000006', 'welcome_email',            'email', 'pending',              'always',              0,   NULL, 1, 'welcome',                 true),
  ('01N409AE000000000000000007', 'ignored_reengagement',     'email', 'ignored',              'always',              336, NULL, 1, 'ignored_reengagement',    true),
  -- Blocked on the client during data collection
  -- One campaign with a repeat rather than two staggered one-shots: the second
  -- would have to re-test the same condition anyway, and `max_sends` is the
  -- honest place to say "three nudges and then we stop".
  ('01N409AE000000000000000008', 'intake_reminder',          'email', 'started',              'intake_incomplete',   24,  72,   3, 'intake_reminder',         true),
  ('01N409AE000000000000000010', 'captable_reminder',        'email', 'started',              'no_captable',         72,  120,  2, 'captable_reminder',       true),
  ('01N409AE000000000000000011', 'financials_reminder',      'email', 'started',              'no_financials',       72,  120,  2, 'financials_reminder',     true),
  ('01N409AE000000000000000012', 'payment_final_notice',     'email', 'started',              'unpaid',              336, NULL, 1, 'payment_final_notice',    true),
  -- Progress acknowledgements
  ('01N409AE000000000000000013', 'onboarding_complete_ack',  'email', 'onboarding_completed', 'always',              0,   NULL, 1, 'onboarding_complete',     true),
  ('01N409AE000000000000000014', 'intake_complete_ack',      'email', 'user_finished',        'always',              0,   NULL, 1, 'intake_complete',         true),
  ('01N409AE000000000000000015', 'analysis_started',         'email', 'completed',            'paid',                0,   NULL, 1, 'analysis_started',        true),
  ('01N409AE000000000000000016', 'waiting_on_client_nudge',  'email', 'completed',            'waiting_on_client',   48,  72,   3, 'waiting_on_client',       true),
  -- Internal: review is where an engagement stalls invisibly
  ('01N409AE000000000000000017', 'review_reminder',          'email', 'review',               'always',              48,  48,   3, 'review_reminder',         true),
  ('01N409AE000000000000000018', 'reviewer_unassigned',      'email', 'review',               'unassigned_reviewer', 24,  NULL, 1, 'reviewer_unassigned',     true),
  -- The draft round trip
  ('01N409AE000000000000000019', 'draft_reminder',           'email', 'drafted',              'always',              72,  72,   2, 'draft_reminder',          true),
  ('01N409AE000000000000000020', 'changes_acknowledged',     'email', 'draft_changes',        'always',              0,   NULL, 1, 'changes_acknowledged',    true),
  ('01N409AE000000000000000021', 'draft_accepted_ack',       'email', 'draft_accepted',       'always',              0,   NULL, 1, 'draft_accepted',          true),
  -- After publication
  ('01N409AE000000000000000022', 'unsigned_report_alert',    'email', 'published',            'unsigned',            24,  NULL, 1, 'unsigned_report',         true),
  ('01N409AE000000000000000023', 'report_feedback',          'email', 'published',            'always',              168, NULL, 1, 'report_feedback',         true),
  ('01N409AE000000000000000024', 'material_event_check_in',  'email', 'published',            'always',              4380, NULL, 1, 'material_event_check_in', true),
  ('01N409AE000000000000000025', 'renewal_reminder',         'email', 'published',            'always',              8016, NULL, 1, 'renewal_reminder',        true),
  -- Recovery
  ('01N409AE000000000000000026', 'timeout_reengagement',     'email', 'timeout',              'always',              24,  NULL, 1, 'timeout_reengagement',    true),
  ('01N409AE000000000000000027', 'cancelled_followup',       'email', 'cancelled',            'always',              168, NULL, 1, 'cancelled_followup',      true)
ON CONFLICT (name) DO NOTHING;

-- SMS stays opt-in: 0051's two SMS campaigns ship disabled and so do these, so
-- no deployment starts texting clients because a migration ran.
INSERT INTO auto_emails (id, name, channel, trigger_state, condition, delay_hours, repeat_hours, max_sends, template_key, enabled) VALUES
  ('01N409AE000000000000000028', 'sms_intake_reminder', 'sms', 'started', 'intake_incomplete', 120, NULL, 1, 'sms_intake_reminder', false)
ON CONFLICT (name) DO NOTHING;
