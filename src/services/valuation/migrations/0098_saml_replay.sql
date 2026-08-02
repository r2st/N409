-- The SAML assertion consumer accepted the same assertion any number of times.
--
-- node-saml checks the XML signature, the audience and the Conditions window,
-- and every one of those checks passes just as well on the second POST as on
-- the first: they are properties of the document, and the document does not
-- change when it is replayed. Nothing in the service remembered that a given
-- assertion had already been turned into a session, so a captured SAMLResponse
-- stayed a working credential for the whole of its Conditions window — five
-- minutes with a typical IdP, an hour with a generous one.
--
-- Capture is the realistic part. The assertion travels through the *browser* as
-- a form POST, by design; it lands in proxy logs, in a referrer, in the history
-- of a shared machine, in any extension that can read the page. SAML core §
-- 6.1 puts the obligation on the SP for exactly this reason: it requires the SP
-- to detect a replayed assertion and refuse it, which needs state the protocol
-- itself cannot carry.
--
-- One row per assertion consumed, so the second attempt collides.
CREATE TABLE saml_assertions_seen (
  -- The IdP's entity id, taken from the signed assertion. Assertion IDs are
  -- only unique per issuer, so the issuer belongs in the key: with a second IdP
  -- configured later, an ID alone could collide across them and one IdP's login
  -- would lock out another's. Empty string when the assertion names no issuer.
  issuer       text        NOT NULL,
  -- The assertion's own ID attribute. SAML requires it to be unique-per-issuer
  -- and unguessable, which is precisely what makes it the right replay key.
  assertion_id text        NOT NULL,
  -- When this row stops being able to refuse anything, because the assertion it
  -- describes has itself expired and the signature checks would now reject it
  -- on their own. Taken from the assertion's Conditions/@NotOnOrAfter so the
  -- record outlives the credential it guards by construction rather than by a
  -- guessed retention.
  expires_at   timestamptz NOT NULL,
  consumed_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (issuer, assertion_id)
);

-- The consuming statement prunes expired rows in the same round trip, so the
-- table stays sized by the assertions currently in flight rather than by the
-- number of logins ever performed. That sweep is the only query that reads this
-- column, and it wants the expired rows first.
CREATE INDEX saml_assertions_seen_expires_at_idx ON saml_assertions_seen (expires_at);

COMMENT ON TABLE saml_assertions_seen IS
  'SAML core §6.1 replay guard: assertions already exchanged for a session.';
