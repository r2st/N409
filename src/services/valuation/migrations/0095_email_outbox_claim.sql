-- The failed-outbox retry sweep selected its candidate rows and then sent them,
-- with nothing in between marking a row as taken. Two sweepers that overlapped
-- therefore delivered the same backlog twice, and there are three ways to get
-- two sweepers: the interval in index.ts and the ops-facing
-- POST /admin/outbox/retry are the same function, an ops double-click fires it
-- twice, and a deployment can run more than one instance against this database.
-- Sending a firm's clients the same valuation notice twice is not a failure the
-- outbox can take back.
--
-- claimed_at is the lease. A sweeper claims a batch by stamping it, and no
-- other sweeper considers a row whose stamp is still inside the lease window.
-- A lease rather than a 'sending' status because a sweeper that dies mid-send
-- would leave a status stuck forever, needing its own reaper; an expired lease
-- simply becomes claimable again on the next pass.
ALTER TABLE email_outbox ADD COLUMN claimed_at timestamptz;

-- The claim reads the oldest unclaimed failures. email_outbox_status_idx
-- (status, created_at) already orders within a status; this keeps the
-- lease predicate off the heap for the same scan.
CREATE INDEX email_outbox_claim_idx ON email_outbox (status, created_at, claimed_at);
