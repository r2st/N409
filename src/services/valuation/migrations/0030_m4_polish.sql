-- Milestone 4 — Polish (feature-gap-analysis P1 items 19–24 + P2 27/30/32).
-- Report templates, funding rounds & transactions, in-app notifications, and
-- the auto-email outbox. Same conventions as 0001: ULID PKs, timestamptz UTC,
-- money as integer cents. Numbered 0030 to leave 0003–0029 free for M1–M3
-- (built in parallel).

-- ── Report template management (P1 #20) ─────────────────────────────────────
-- Versioned like "409a.v53": (name, version) is the identity, `label` is the
-- rendered handle. Only one active version per name at a time.
CREATE TYPE report_template_status AS ENUM ('draft','active','archived');

CREATE TABLE report_templates (
  id         ulid PRIMARY KEY,
  name       text NOT NULL,
  version    integer NOT NULL CHECK (version > 0),
  kind       valuation_kind NOT NULL,
  status     report_template_status NOT NULL DEFAULT 'draft',
  body       text NOT NULL DEFAULT '',
  notes      text,
  created_by ulid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (name, version)
);
CREATE UNIQUE INDEX report_templates_one_active_per_name
  ON report_templates (name) WHERE status = 'active';
CREATE INDEX report_templates_kind_idx ON report_templates (kind);

-- ── Transaction & funding-round history (P1 #24) ────────────────────────────
CREATE TABLE funding_rounds (
  id                  ulid PRIMARY KEY,
  valuation_id        ulid NOT NULL REFERENCES valuations(id) ON DELETE CASCADE,
  name                text NOT NULL,
  security_type       text,
  closed_on           date,
  amount_raised_cents bigint CHECK (amount_raised_cents >= 0),
  pre_money_cents     bigint CHECK (pre_money_cents >= 0),
  post_money_cents    bigint CHECK (post_money_cents >= 0),
  shares_issued       bigint CHECK (shares_issued >= 0),
  notes               text,
  created_by          ulid REFERENCES users(id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX funding_rounds_valuation_idx ON funding_rounds (valuation_id, closed_on);

CREATE TYPE valuation_transaction_kind AS ENUM
  ('issuance','secondary_sale','repurchase','conversion','transfer','other');

CREATE TABLE valuation_transactions (
  id                    ulid PRIMARY KEY,
  valuation_id          ulid NOT NULL REFERENCES valuations(id) ON DELETE CASCADE,
  kind                  valuation_transaction_kind NOT NULL,
  occurred_on           date NOT NULL,
  shares                bigint CHECK (shares >= 0),
  price_per_share_cents bigint CHECK (price_per_share_cents >= 0),
  counterparty          text,
  notes                 text,
  created_by            ulid REFERENCES users(id),
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX valuation_transactions_valuation_idx
  ON valuation_transactions (valuation_id, occurred_on);

-- ── In-app notifications (P2 #27) ────────────────────────────────────────────
CREATE TABLE notifications (
  id           ulid PRIMARY KEY,
  user_id      ulid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  valuation_id ulid REFERENCES valuations(id) ON DELETE SET NULL,
  type         text NOT NULL,
  title        text NOT NULL,
  body         text,
  read_at      timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notifications_user_idx ON notifications (user_id, created_at DESC);
CREATE INDEX notifications_unread_idx ON notifications (user_id) WHERE read_at IS NULL;

-- ── Auto email workflows (P1 #21) — transactional outbox ─────────────────────
-- Emails are enqueued in the same transaction as the state change that caused
-- them, then handed to the (pluggable) transport; delivery status lives here.
CREATE TYPE email_status AS ENUM ('queued','sent','failed','skipped');

CREATE TABLE email_outbox (
  id           ulid PRIMARY KEY,
  valuation_id ulid REFERENCES valuations(id) ON DELETE SET NULL,
  to_user_id   ulid REFERENCES users(id) ON DELETE SET NULL,
  to_email     text NOT NULL,
  template_key text NOT NULL,
  subject      text NOT NULL,
  body         text NOT NULL,
  status       email_status NOT NULL DEFAULT 'queued',
  error        text,
  attempts     integer NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now(),
  sent_at      timestamptz
);
CREATE INDEX email_outbox_status_idx ON email_outbox (status, created_at);
CREATE INDEX email_outbox_valuation_idx ON email_outbox (valuation_id);
