-- Milestone 0, issue #2 — core schema (database-design.md).
-- ULID PKs (text domain), timestamptz UTC, money as integer cents.
-- Partitioning of valuation_events is deferred to M7 (#31).

CREATE DOMAIN ulid AS text CHECK (VALUE ~ '^[0-9A-HJKMNP-TV-Z]{26}$');

-- ── Enums ────────────────────────────────────────────────────────────────────
CREATE TYPE valuation_kind AS ENUM
  ('409a','fmv','718','820','gifts','qsbs','csop','emi','ifrs2','ppa','goodwill','esop','ip');

CREATE TYPE valuation_state AS ENUM
  ('pending','started','onboarding_completed','user_finished','completed',
   'review','reviewed','drafted','draft_accepted','draft_changes','published',
   'timeout','cancelled','ignored');

CREATE TYPE valuation_source AS ENUM ('partner','referral','ads','repeat');
CREATE TYPE paid_status      AS ENUM ('unpaid','paid','paid_by_partner');
CREATE TYPE actor_type       AS ENUM ('human','ai','engine','system');
CREATE TYPE sso_provider     AS ENUM ('google');
CREATE TYPE revenue_status   AS ENUM ('pre_revenue','post_revenue');
CREATE TYPE dlom_method      AS ENUM ('chaffee','finnerty','qualitative');
CREATE TYPE market_method    AS ENUM ('revenue','ebitda');
CREATE TYPE market_horizon   AS ENUM ('ltm','ntm');
CREATE TYPE asset_method     AS ENUM ('cost_to_replicate','nav');

-- ── Identity & partners ──────────────────────────────────────────────────────
CREATE TABLE partners (
  id         ulid PRIMARY KEY,
  name       text NOT NULL,
  key        text NOT NULL UNIQUE,
  config     jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id              ulid PRIMARY KEY,
  first_name      text,
  last_name       text,
  email           text NOT NULL,
  phone           text,
  verified        boolean NOT NULL DEFAULT false,
  sso_provider    sso_provider,
  password_digest text,
  gclid           text,
  partner_id      ulid REFERENCES partners(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT users_auth_method CHECK (password_digest IS NOT NULL OR sso_provider IS NOT NULL)
);
CREATE UNIQUE INDEX users_email_key ON users (lower(email));
CREATE INDEX users_partner_idx ON users (partner_id);

CREATE TABLE roles (
  id  smallserial PRIMARY KEY,
  key text NOT NULL UNIQUE
);

CREATE TABLE user_roles (
  user_id ulid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_id smallint NOT NULL REFERENCES roles(id),
  PRIMARY KEY (user_id, role_id)
);

-- ── Valuations (aggregate root) ──────────────────────────────────────────────
CREATE SEQUENCE valuation_number_seq START 1;

CREATE TABLE valuations (
  id                   ulid PRIMARY KEY,
  number               bigint NOT NULL UNIQUE DEFAULT nextval('valuation_number_seq'),
  workflow_id          text,
  kind                 valuation_kind NOT NULL,
  template_version     text,
  engine_version       text,
  state                valuation_state NOT NULL DEFAULT 'pending',
  waiting_on_client    boolean NOT NULL DEFAULT false,
  company_name         text NOT NULL,
  service_name         text,
  user_id              ulid NOT NULL REFERENCES users(id),
  partner_id           ulid REFERENCES partners(id),
  source               valuation_source,
  gclid                text,
  qsbs_attestation     boolean,
  currency             char(3) NOT NULL DEFAULT 'USD',
  service_countries    text[] NOT NULL DEFAULT '{}',
  paid_status          paid_status NOT NULL DEFAULT 'unpaid',
  amount_cents         integer,
  custom_amount_cents  integer,
  paid_at              timestamptz,
  delivery_days        integer,
  amount_raised_cents  bigint,
  assigned_reviewer_id ulid REFERENCES users(id),
  created_at           timestamptz NOT NULL DEFAULT now(),
  started_at           timestamptz,
  user_finished_at     timestamptz,
  due_date             timestamptz,
  completed_at         timestamptz,
  drafted_at           timestamptz,
  draft_accepted_at    timestamptz,
  published_at         timestamptz,
  admin_read_at        timestamptz,
  user_read_at         timestamptz,
  last_comment_at      timestamptz
);
CREATE INDEX valuations_state_idx    ON valuations (state);
CREATE INDEX valuations_partner_idx  ON valuations (partner_id);
CREATE INDEX valuations_kind_idx     ON valuations (kind);
CREATE INDEX valuations_due_date_idx ON valuations (due_date);
CREATE INDEX valuations_reviewer_idx ON valuations (assigned_reviewer_id);
CREATE INDEX valuations_user_idx     ON valuations (user_id);
CREATE INDEX valuations_company_idx  ON valuations (company_name text_pattern_ops);

-- ── Valuation params (1:1 methodology inputs) ────────────────────────────────
CREATE TABLE valuation_params (
  valuation_id           ulid PRIMARY KEY REFERENCES valuations(id) ON DELETE CASCADE,
  rolling_forward        boolean NOT NULL DEFAULT false,
  inception_date         date,
  fiscal_year_end        date,
  exit_timeline          date,
  business_overview      text,
  revenue_status         revenue_status,
  last_round_date        date,
  last_year_revenue_cents bigint,
  ytd_revenue_cents      bigint,
  runway_months          integer,
  weight_asset           numeric,
  weight_opm             numeric,
  weight_income          numeric,
  weight_market          numeric,
  dloc                   numeric,
  dlom                   numeric,
  dlom_method            dlom_method,
  dlom_qualitative       numeric,
  market_method          market_method,
  market_horizon         market_horizon,
  market_custom_ranges   jsonb,
  asset_method           asset_method,
  updated_at             timestamptz NOT NULL DEFAULT now(),
  -- weights must sum to 1 once all four are set (requirements FR-14)
  CONSTRAINT weights_sum_to_one CHECK (
    (weight_asset IS NULL AND weight_opm IS NULL AND weight_income IS NULL AND weight_market IS NULL)
    OR (weight_asset + weight_opm + weight_income + weight_market = 1)
  )
);

-- ── Append-only audit spine (architecture §1: everything is an event) ────────
CREATE TABLE valuation_events (
  id           ulid NOT NULL PRIMARY KEY,
  valuation_id ulid NOT NULL REFERENCES valuations(id),
  seq          bigint GENERATED BY DEFAULT AS IDENTITY,
  type         text NOT NULL,
  actor_type   actor_type NOT NULL,
  actor_id     text,
  source       text,
  payload      jsonb NOT NULL DEFAULT '{}',
  occurred_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (valuation_id, seq)
);
CREATE INDEX valuation_events_valuation_idx ON valuation_events (valuation_id, occurred_at);
CREATE INDEX valuation_events_type_idx      ON valuation_events (type);

-- Immutability: no UPDATE or DELETE, ever (compliance/audit foundation).
CREATE FUNCTION forbid_event_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'valuation_events is append-only (% blocked)', TG_OP
    USING ERRCODE = 'raise_exception';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER valuation_events_immutable
  BEFORE UPDATE OR DELETE ON valuation_events
  FOR EACH ROW EXECUTE FUNCTION forbid_event_mutation();

CREATE TRIGGER valuation_events_no_truncate
  BEFORE TRUNCATE ON valuation_events
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_event_mutation();
