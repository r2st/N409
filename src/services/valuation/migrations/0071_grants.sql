-- Stock option grant management (feature 6): once the board adopts a 409A FMV,
-- the company can issue option grants struck at that fair market value. Each
-- grant carries its vesting schedule so vested/unvested tracking and the
-- exercise-scenario calculator run off structured data.
CREATE TYPE grant_status AS ENUM ('active', 'cancelled');

CREATE TABLE option_grants (
  id                 ulid PRIMARY KEY,
  valuation_id       ulid NOT NULL REFERENCES valuations(id) ON DELETE CASCADE,
  grantee_name       text NOT NULL,
  grantee_email      text,
  grant_date         date NOT NULL,
  options_count      integer NOT NULL CHECK (options_count > 0),
  -- Exercise price snapshotted from the 409A FMV the board adopted.
  exercise_price     numeric NOT NULL CHECK (exercise_price >= 0),
  currency           char(3) NOT NULL DEFAULT 'USD',
  vesting_template   text NOT NULL DEFAULT 'standard_4yr_1yr_cliff',
  vesting_start_date date NOT NULL,
  vesting_months     integer NOT NULL CHECK (vesting_months >= 0),
  cliff_months       integer NOT NULL DEFAULT 0 CHECK (cliff_months >= 0),
  frequency_months   integer NOT NULL DEFAULT 1 CHECK (frequency_months >= 1),
  status             grant_status NOT NULL DEFAULT 'active',
  notes              text,
  created_by         ulid NOT NULL REFERENCES users(id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX option_grants_valuation_idx ON option_grants (valuation_id, grant_date DESC);
