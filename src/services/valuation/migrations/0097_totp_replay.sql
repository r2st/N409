-- A TOTP code stayed usable for as long as it was inside the acceptance window
-- (RFC 6238 §5.2 says it must not be: "the verifier MUST NOT accept the second
-- attempt of the OTP after the successful validation has been issued for the
-- first OTP"). With a 30-second step and the ±1 step allowed for clock skew,
-- every code this service accepted could be replayed for up to 90 seconds.
--
-- That window is exactly what a real-time phishing proxy operates in: the site
-- collects password and code, and the code is still good when it is replayed at
-- the real login. It also covers a code read over a shoulder or scraped from a
-- screen share. Rate limiting does not help — replaying a code the user just
-- typed takes one attempt, not many.
--
-- The counter (unix time / 30) of the last code accepted for this user. A
-- submission is refused unless it is strictly greater, so each code works once
-- and going backwards inside the skew window is refused too. NULL means the
-- account has never completed a TOTP verification, which is where every
-- existing enrolled account starts: the column is advisory-empty rather than
-- backfilled, so the first code after this migration sets the floor instead of
-- locking anyone out.
ALTER TABLE users ADD COLUMN totp_last_counter bigint;

COMMENT ON COLUMN users.totp_last_counter IS
  'RFC 6238 §5.2 replay guard: the time-step counter of the last accepted TOTP code.';
