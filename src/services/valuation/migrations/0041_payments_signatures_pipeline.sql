-- P0/P1 integrations (docs/remaining-gaps.md §3 #1/#3, §6 P1 #7/#9):
-- Stripe payments, signature gating before publish, the summarize pipeline,
-- and persisted engine inputs for extraction auto-apply. Same conventions as
-- 0001: ULID PKs, timestamptz UTC, money as integer cents.

-- New AI pipeline value (Summarize Attachments). NOT used elsewhere in this
-- migration — Postgres forbids using an enum value added in the same
-- transaction (the seed row lands in 0042).
ALTER TYPE ai_pipeline ADD VALUE IF NOT EXISTS 'summarize';

-- ── Extraction auto-apply (P1 #7 — "Set Valuation Parameters") ───────────────
-- AI-extracted engine inputs the analyst has applied; merged into every
-- calculation payload (analyst-blessed values outrank the raw extract job).
ALTER TABLE valuation_params
  ADD COLUMN engine_inputs jsonb NOT NULL DEFAULT '{}';

-- ── Stripe payments (P0 #2) ──────────────────────────────────────────────────
CREATE TYPE payment_status AS ENUM ('pending','succeeded','failed','expired');

CREATE TABLE payments (
  id                ulid PRIMARY KEY,
  valuation_id      ulid NOT NULL REFERENCES valuations(id) ON DELETE CASCADE,
  provider          text NOT NULL DEFAULT 'stripe',
  session_id        text NOT NULL UNIQUE,
  payment_intent_id text,
  amount_cents      bigint NOT NULL CHECK (amount_cents > 0),
  currency          char(3) NOT NULL DEFAULT 'USD',
  status            payment_status NOT NULL DEFAULT 'pending',
  checkout_url      text,
  created_by        ulid REFERENCES users(id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX payments_valuation_idx ON payments (valuation_id, created_at DESC);
CREATE INDEX payments_status_idx ON payments (status) WHERE status = 'pending';

-- ── Signature gating (P0-adjacent — remaining-gaps §3 #3) ────────────────────
-- 409.ai gates publish behind Signature (main) and Signature (second).
-- A 'main' signature is REQUIRED before a valuation can enter 'published';
-- 'second' is optional but recorded. Signatures are append-only rows tied to
-- the signer; re-signing after changes replaces the previous row.
CREATE TYPE signature_role AS ENUM ('main','second');

CREATE TABLE valuation_signatures (
  id             ulid PRIMARY KEY,
  valuation_id   ulid NOT NULL REFERENCES valuations(id) ON DELETE CASCADE,
  role           signature_role NOT NULL,
  signer_user_id ulid NOT NULL REFERENCES users(id),
  signer_name    text NOT NULL,
  signer_title   text,
  signature_text text NOT NULL,
  signed_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (valuation_id, role)
);
CREATE INDEX valuation_signatures_valuation_idx ON valuation_signatures (valuation_id);
