-- Client intake questionnaire (feature 7): a guided data-collection form the
-- client completes during onboarding (company info, financials, cap-table
-- summary, legal/governance). Answers are stored as jsonb keyed by field; the
-- field schema and completion rules live in domain/intake.ts.
CREATE TABLE intake_questionnaires (
  id           ulid PRIMARY KEY,
  valuation_id ulid NOT NULL UNIQUE REFERENCES valuations(id) ON DELETE CASCADE,
  answers      jsonb NOT NULL DEFAULT '{}',
  submitted_at timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
