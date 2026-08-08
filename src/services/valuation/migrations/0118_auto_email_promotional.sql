-- The transactional/promotional line on auto email campaigns.
--
-- This is a compliance control, not a feature. CAN-SPAM, GDPR and PECR all
-- turn on the same distinction: a transactional message about a service the
-- recipient asked for may be sent without marketing consent and carries no
-- opt-out obligation, and a promotional message may not and does.
--
-- Without the column, 0104's twenty-seven campaigns are all one thing, and
-- both readings are wrong. If they are treated as transactional then the
-- renewal, feedback and re-engagement campaigns are marketing sent under a
-- transactional exemption they do not have. If they are treated as marketing
-- then one opt-out silences the status notifications a client needs to know
-- their valuation is waiting on them.
--
-- The default is `false` because the two mistakes are not symmetric and the
-- safe direction is the one that keeps the service working: a marketing
-- message wrongly marked transactional is a regulator problem, and a
-- transactional message wrongly marked marketing is a client who never hears
-- that their report is ready. So nothing becomes promotional implicitly — the
-- UPDATE below names the six, and any future campaign is transactional until
-- an operator says otherwise.

ALTER TABLE auto_emails
  ADD COLUMN IF NOT EXISTS promotional boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN auto_emails.promotional IS
  'Marketing rather than transactional: gated on marketing consent and sent with an unsubscribe footer.';

-- The marketing-side campaigns from 0104. Everything else — the state
-- acknowledgements, the blocked-on-client nudges, the payment notices, the
-- reviewer reminders — is transactional and stays so.
--
--   report_feedback          asks for a review of a delivered report
--   material_event_check_in  six-month prompt to start a new engagement
--   renewal_reminder         twelve-month prompt to start a new engagement
--   timeout_reengagement     win-back on an abandoned engagement
--   cancelled_followup       win-back after a cancellation
--   ignored_reengagement     win-back on an ignored engagement
--
-- The last three are the clearest cases: an engagement the client walked away
-- from is not one they are waiting on us for, so a message chasing it is
-- marketing by any reading.
UPDATE auto_emails SET promotional = true
 WHERE template_key IN (
   'renewal_reminder',
   'report_feedback',
   'material_event_check_in',
   'ignored_reengagement',
   'timeout_reengagement',
   'cancelled_followup'
 );
