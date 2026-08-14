-- The AI company-profile agent, and the three profile columns it fills.
--
-- `company_profiles` (0040) is the structured company detail behind the
-- workbook, the HMRC forms and the package view, and every field in it has
-- always been hand-typed. The platform's own narrative agent then drafts a
-- "Company Overview and Industry Analysis" section (0114) with nothing
-- structured to draft it from, and the comparable screen
-- (POST /comparables/screen) refuses to run until somebody types a SIC code on
-- the Overwrites tab. This is gap #3 in the 409.ai comparison, in the shape the
-- rest of the platform is built in.
--
-- Three columns rather than a free-text blob:
--
--   business_description — what the company does, drafted from the engagement's
--     own uploaded documents. Read by the narrative agent's company_overview
--     section and by the report body.
--   sic_code / naics_code — the classification an analyst types today. The
--     screen ranks on SIC; NAICS is stored because the two are not
--     interconvertible and a report that cites one is asked for the other.
--
-- Kept on `company_profiles` rather than a new table because they answer the
-- same question every other column there does — "what is this company" — and a
-- second table would mean two places to look and two update paths for one
-- answer.
ALTER TABLE company_profiles
  ADD COLUMN IF NOT EXISTS business_description text,
  ADD COLUMN IF NOT EXISTS sic_code             text,
  ADD COLUMN IF NOT EXISTS naics_code           text;

-- The agent is `company_profile`, deliberately not `company_overview`: that
-- name is already an `ai_pipeline` value, held since 0116 by the web-grounded
-- research prompt for *guideline* companies. The two must not collide, because
-- they sit on opposite sides of the trust boundary — the research topic sends a
-- public company's name out to a search provider and refuses the engagement's
-- own (domain/research.ts `assertSubjectNotClient`), while this agent reads the
-- engagement's confidential documents and never leaves the redactor.
--
-- Seeding the ai_prompts row is 0152, not this file: Postgres forbids using a
-- new enum value in the transaction that adds it, the same constraint
-- 0060/0061, 0107 and 0116/0117 already document.
ALTER TYPE ai_pipeline ADD VALUE IF NOT EXISTS 'company_profile';
