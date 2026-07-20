-- Analyst AI agents (cap-table structuring, comparable-company selection,
-- report narrative drafting, assumption recommendation, audit defense, and
-- roll-forward). Registered as first-class AI pipelines so they run through the
-- same job/prompt-registry machinery as the M1 pipelines.
--
-- Two migrations: enum values added here cannot be USED (seeded) in the same
-- transaction, so the prompt rows are seeded in 0061.
ALTER TYPE ai_pipeline ADD VALUE IF NOT EXISTS 'cap_table';
ALTER TYPE ai_pipeline ADD VALUE IF NOT EXISTS 'comp_selection';
ALTER TYPE ai_pipeline ADD VALUE IF NOT EXISTS 'report_narrative';
ALTER TYPE ai_pipeline ADD VALUE IF NOT EXISTS 'assumptions';
ALTER TYPE ai_pipeline ADD VALUE IF NOT EXISTS 'audit_defense';
ALTER TYPE ai_pipeline ADD VALUE IF NOT EXISTS 'roll_forward';

-- Per-agent on/off toggle (like the Landline agents): ops can disable an agent
-- without deleting its prompt. Existing pipelines default to enabled so nothing
-- changes for them. A disabled pipeline is rejected before any LLM call.
ALTER TABLE ai_prompts ADD COLUMN IF NOT EXISTS enabled boolean NOT NULL DEFAULT true;
