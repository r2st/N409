-- Board approval workflow (feature 5): after a valuation is finalized the
-- appraiser generates a board resolution capturing the FMV conclusion,
-- methodology and appraiser qualifications, then collects e-signatures from
-- the board. The approval timestamp is the safe-harbor record — a board that
-- adopts the 409A in good faith establishes the rebuttable presumption of
-- reasonableness under IRC §409A.
CREATE TYPE board_resolution_status AS ENUM ('pending', 'approved', 'rejected');
CREATE TYPE board_signoff_status    AS ENUM ('pending', 'signed', 'rejected');

CREATE TABLE board_resolutions (
  id                       ulid PRIMARY KEY,
  -- One live resolution per valuation; regenerating replaces the body.
  valuation_id             ulid NOT NULL UNIQUE REFERENCES valuations(id) ON DELETE CASCADE,
  valuation_date           date NOT NULL,
  fmv_conclusion           numeric NOT NULL,
  currency                 char(3) NOT NULL DEFAULT 'USD',
  methodology_summary      text NOT NULL,
  appraiser_qualifications text NOT NULL,
  body_html                text NOT NULL,
  status                   board_resolution_status NOT NULL DEFAULT 'pending',
  -- Safe-harbor: the moment the board's adoption completed.
  approved_at              timestamptz,
  created_by               ulid NOT NULL REFERENCES users(id),
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE board_signoffs (
  id            ulid PRIMARY KEY,
  resolution_id ulid NOT NULL REFERENCES board_resolutions(id) ON DELETE CASCADE,
  valuation_id  ulid NOT NULL REFERENCES valuations(id) ON DELETE CASCADE,
  member_name   text NOT NULL,
  member_email  text NOT NULL,
  member_title  text,
  -- sha256 of the emailed signing token (never stored in the clear).
  token_sha256  text NOT NULL UNIQUE,
  status        board_signoff_status NOT NULL DEFAULT 'pending',
  comment       text,
  sent_at       timestamptz,
  signed_at     timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (resolution_id, member_email)
);

CREATE INDEX board_signoffs_resolution_idx ON board_signoffs (resolution_id, created_at);
