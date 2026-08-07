-- Partner API webhooks + idempotency (partner API enhancements).
--
-- Partners submitting valuations programmatically had exactly one way to learn
-- anything: poll GET /valuations/{id}. A drafted report, a published opinion, a
-- state change — all invisible until the next poll. Webhooks push those
-- transitions to a partner-registered URL, HMAC-signed with a per-endpoint
-- secret so the receiver can authenticate the sender.
--
-- Deliveries are recorded BEFORE the attempt (the email outbox's rule): a
-- crashed process leaves a 'pending' row that says what should have gone out,
-- never a silent gap. One attempt per event for now; the row carries the
-- status either way, and GET /webhooks/{id}/deliveries is the partner's audit
-- trail.
--
-- Idempotency: a partner client that retries a timed-out POST re-creates the
-- valuation — same company, two engagements, one invoice dispute. An
-- Idempotency-Key header makes the retry safe: the first response is stored
-- against (partner, key) and replayed for any repeat, and a repeat whose body
-- differs from the original is refused rather than guessed at.

CREATE TABLE partner_webhooks (
  id           ulid PRIMARY KEY,
  partner_id   ulid NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
  url          text NOT NULL,
  -- The HMAC signing key. Stored as written because every delivery signs with
  -- it; it authenticates us to the partner, not the partner to us.
  secret       text NOT NULL,
  -- Event whitelist; empty means every event.
  events       text[] NOT NULL DEFAULT '{}',
  enabled      boolean NOT NULL DEFAULT true,
  created_by   ulid REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX partner_webhooks_partner_idx ON partner_webhooks (partner_id);

CREATE TABLE partner_webhook_deliveries (
  id            ulid PRIMARY KEY,
  webhook_id    ulid NOT NULL REFERENCES partner_webhooks(id) ON DELETE CASCADE,
  event_type    text NOT NULL,
  valuation_id  ulid REFERENCES valuations(id) ON DELETE SET NULL,
  payload       jsonb NOT NULL,
  status        text NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'delivered', 'failed')),
  attempts      integer NOT NULL DEFAULT 0,
  last_error    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  delivered_at  timestamptz
);

CREATE INDEX partner_webhook_deliveries_webhook_idx
  ON partner_webhook_deliveries (webhook_id, created_at DESC);

CREATE TABLE partner_api_idempotency (
  partner_id       ulid NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
  idempotency_key  text NOT NULL,
  -- sha256 of the original request body: a replay must be the SAME request.
  request_hash     text NOT NULL,
  response_status  integer NOT NULL,
  response_body    jsonb NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (partner_id, idempotency_key)
);
