-- Document upload categories (409.ai's six intake buckets).
--
-- `documents.kind` is the machine's classification: it decides which extractor
-- runs and which engine input a file feeds. It is not what a client is being
-- asked for. "Upload your monthly P&Ls" and "upload your audited annuals" are
-- two different requests that produce the same `income_statement` kind, and the
-- intake checklist could not tell whether it had been answered — a company that
-- sent twelve monthly statements looked, to the checklist, exactly like one that
-- sent a single annual.
--
-- So category is a separate axis: six buckets that mirror what the client is
-- actually asked to provide. Kind stays exactly as it is; the mapping between
-- them lives in domain/documentCategories.ts and is many-to-one everywhere
-- except income statements, which is the whole reason this exists.

CREATE TYPE document_category AS ENUM (
  'captable_documents',
  'monthly_income_statements',
  'annual_income_statements',
  'balance_sheets',
  'projections',
  -- The catch-all: pitch decks, articles, term sheets, prior valuations, and
  -- anything a client sends that we did not ask for by name.
  'uploads'
);

ALTER TABLE documents ADD COLUMN category document_category;

-- Backfill from kind. `income_statement` resolves to annual rather than
-- monthly: an existing row carries no period information at all, and calling an
-- unknown-period statement "annual" is the reading that leaves the monthly
-- bucket honestly empty rather than falsely satisfied.
UPDATE documents SET category = CASE kind
  -- The cap-table evidence set, matching categoryForKind: grants are the pool
  -- detail, and the charter and term sheets are where the share classes and
  -- their preferences are defined.
  WHEN 'cap_table'                 THEN 'captable_documents'
  WHEN 'option_grants'             THEN 'captable_documents'
  WHEN 'term_sheet'                THEN 'captable_documents'
  WHEN 'articles_of_incorporation' THEN 'captable_documents'
  WHEN 'income_statement'          THEN 'annual_income_statements'
  WHEN 'balance_sheet'             THEN 'balance_sheets'
  WHEN 'projections'               THEN 'projections'
  WHEN 'cash_flow'                 THEN 'projections'
  ELSE 'uploads'
END::document_category;

ALTER TABLE documents
  ALTER COLUMN category SET DEFAULT 'uploads',
  ALTER COLUMN category SET NOT NULL;

-- The intake checklist asks "which buckets does this valuation have something
-- in?" on every workspace load.
CREATE INDEX documents_category_idx
  ON documents (valuation_id, category) WHERE deleted_at IS NULL;
