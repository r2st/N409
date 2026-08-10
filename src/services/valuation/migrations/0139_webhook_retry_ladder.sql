-- Webhook delivery: raise the attempt ceiling so the longer backoff ladder is
-- actually reachable.
--
-- 0103 set max_attempts to 4 — the initial attempt plus the three steps that
-- existed then (1 min, 5 min, 30 min), giving the ladder a 36-minute reach.
-- domain/partnerWebhooks.ts now carries five steps (+2 h, +6 h), because a
-- 36-minute reach dropped a partner's events permanently for every incident
-- longer than half an hour: the ordinary kind, where the page fires overnight
-- and the fix lands two hours later, with the receiver merely down the whole
-- time. That is the one outcome the retry mechanism exists to prevent.
--
-- The column default is what new deliveries inherit, so raising it here is what
-- makes the two new steps run at all: WEBHOOK_MAX_ATTEMPTS is only the value
-- the *code* would pick, and `retryDelayMinutes` stops at the row's own
-- max_attempts. The CHECK from 0103 already permits up to 10.

ALTER TABLE partner_webhook_deliveries
  ALTER COLUMN max_attempts SET DEFAULT 6;

-- Rows still owed an attempt get the longer ladder too. This is the useful
-- half of the change for anyone currently inside an outage: a delivery that has
-- used three of its four attempts is one failure away from terminal, and after
-- this it has three more spread over eight hours.
--
-- Deliberately only 'pending'. A settled row — 'delivered', or 'failed' after
-- exhausting the old ceiling — stays settled: resurrecting a terminal delivery
-- would re-POST a transition whose payload may be many deploys old, which is
-- the same reasoning 0103 used when it retired the pre-retry backlog rather
-- than replaying it. A partner who wants one of those back has the explicit
-- replay endpoint, where it is their decision.
UPDATE partner_webhook_deliveries
   SET max_attempts = 6
 WHERE status = 'pending'
   AND max_attempts = 4;
