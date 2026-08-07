-- A board member's signing token never expired.
--
-- Every other bearer credential this platform emails is bounded: an auditor
-- link is capped at 180 days (0081), a client intake link at 90 (0092), a
-- password reset in minutes. A board sign-off token was not. It is mailed to a
-- personal address, it authenticates on its own, and what it grants is the
-- concluded fair market value, the resolution text adopting it, and the ability
-- to record that member's signature on a 409A a company will rely on for a year
-- — for as long as the row exists.
--
-- The exposure is the ordinary life of an email account: a forwarded thread, an
-- archive restored from backup, a departing director's mailbox delegated to
-- someone else, a laptop sold. None of that is exotic, and none of it is
-- addressed by the rate limit on the public routes, which bounds guessing and
-- nothing else. Deleting the member is the only revocation there was, and it
-- deletes the signature with it — which is not a thing you do to an approved
-- resolution.
--
-- So the token gets the same shape as its siblings: minted with a deadline,
-- refused after it, and re-mintable by ops with the button that already exists
-- (Send re-mints, so a member who lets one lapse gets a fresh link and the
-- stale one dies at the same moment — which is the behaviour Send already had).
--
-- Backfilled to 30 days from this migration rather than from each row's
-- creation: these tokens were issued under a promise of no expiry, and a
-- deploy is not a fair moment to invalidate a link a director may be about to
-- open. Everyone gets a full window from here, and from the next mint onwards
-- the deadline is the token's own.
ALTER TABLE board_signoffs
  ADD COLUMN token_expires_at timestamptz;

UPDATE board_signoffs SET token_expires_at = now() + interval '30 days'
 WHERE token_expires_at IS NULL;

ALTER TABLE board_signoffs
  ALTER COLUMN token_expires_at SET NOT NULL;

COMMENT ON COLUMN board_signoffs.token_expires_at IS
  'Deadline on the emailed signing token. Re-minted (and pushed out) by Send.';
