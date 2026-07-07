-- P1/P2 remaining features (docs/remaining-gaps.md §3 #4/#6/#8 + §6 P1 #8):
-- DB-backed AI prompt registry with per-pipeline model binding, structured
-- company profiles, and in-app support messages (Intercom-style widget).
-- Same conventions as 0001: ULID PKs, timestamptz UTC.

-- ── AI prompt registry (Bot Prompts management) ──────────────────────────────
-- One editable row per pipeline. `system_prompt` overrides the built-in
-- system prompt shipped with the AI service; `model` pins an OpenRouter model
-- (NULL = the service's default fallback chain). The user-message half of each
-- prompt stays code-defined because it interpolates the document corpus.
CREATE TABLE ai_prompts (
  id            ulid PRIMARY KEY,
  pipeline      ai_pipeline NOT NULL UNIQUE,
  label         text NOT NULL,
  description   text,
  system_prompt text NOT NULL,
  model         text,
  updated_by    ulid REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- Seed with the prompts previously hard-coded in the AI service so behaviour
-- is unchanged until an admin edits them.
INSERT INTO ai_prompts (id, pipeline, label, description, system_prompt) VALUES
  (
    '01N409PR0MPT000000000000MD',
    'missing_data',
    'Missing data check',
    'Reviews uploads and params, lists what is still needed for a defensible valuation.',
    'You are a 409A valuation analyst assistant. You review what a client has uploaded and identify what is still missing to complete a defensible valuation. Respond ONLY with JSON.'
  ),
  (
    '01N409PR0MPT000000000000EX',
    'extract',
    'Data extraction',
    'Pulls share counts, preferences, cash/debt and revenue out of the uploaded documents.',
    'You are a financial data extraction engine for 409A valuations. Extract ONLY values explicitly present in the documents. Never invent numbers. All monetary amounts in plain units (dollars, not thousands). Respond ONLY with JSON.'
  ),
  (
    '01N409PR0MPT000000000000CM',
    'comparables',
    'Public comparables',
    'Suggests guideline public companies with revenue/EBITDA multiples for the market approach.',
    'You are a valuation analyst finding guideline public companies (market approach / GPC method). Suggest liquid, well-known public companies in the same or adjacent business. Multiples are EV/Revenue and EV/EBITDA estimates typical for the sector — mark them as estimates. Respond ONLY with JSON.'
  )
ON CONFLICT (pipeline) DO NOTHING;

-- ── Company profile (features.md "modal_ui_data") ────────────────────────────
-- Structured, editable company details per valuation; the engagement itself
-- keeps carrying only company_name.
CREATE TABLE company_profiles (
  valuation_id      ulid PRIMARY KEY REFERENCES valuations(id) ON DELETE CASCADE,
  legal_name        text,
  website           text,
  address_line1     text,
  address_line2     text,
  city              text,
  region            text,
  postal_code       text,
  country           text,
  industry          text,
  founded_on        date,
  employee_count    integer CHECK (employee_count >= 0),
  revenue_range     text,
  cap_table_summary text,
  updated_by        ulid REFERENCES users(id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

-- ── Support messages (help widget) ───────────────────────────────────────────
CREATE TYPE support_message_status AS ENUM ('open','resolved');

CREATE TABLE support_messages (
  id          ulid PRIMARY KEY,
  user_id     ulid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  subject     text NOT NULL,
  body        text NOT NULL,
  page_path   text,
  status      support_message_status NOT NULL DEFAULT 'open',
  resolved_by ulid REFERENCES users(id),
  resolved_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX support_messages_status_idx ON support_messages (status, created_at DESC);
CREATE INDEX support_messages_user_idx ON support_messages (user_id, created_at DESC);
