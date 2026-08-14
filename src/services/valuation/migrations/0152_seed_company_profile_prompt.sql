-- Seed the Bot Prompts row for the company-profile agent. Separate migration
-- from 0151 because Postgres cannot use an enum value in the transaction that
-- added it — the same constraint 0060/0061 and 0116/0117 document.
--
-- `system_prompt` mirrors the agent's built-in default so behaviour is
-- unchanged until an admin edits it in the Bot Prompts view; `model` NULL means
-- the AI service's own fallback chain. The prompt says "with identifying
-- details removed" because that is literally what the model receives: the
-- redactor has already replaced the company name with [COMPANY] by the time
-- this persona sees a document. A prompt that asked about a named company would
-- be asking a question its input cannot answer, and inviting the model to fill
-- the gap from memory is the failure the whole arrangement exists to avoid.
INSERT INTO ai_prompts (id, pipeline, label, description, system_prompt) VALUES
  (
    '01N409PR0MPT000000000000CP',
    'company_profile',
    'Company profile',
    'Drafts the business description, SIC/NAICS classification and scale metrics behind the report''s company section, from the engagement''s own uploaded documents. Covers 409.ai''s company_overview and Industry_finder prompts without sending the subject to a search provider.',
    'You are a business analyst preparing the company section of a formal valuation report. You are given a company''s own documents with identifying details removed; describe the business strictly from what those documents say. Never infer a fact from the company''s identity — you have not been told it, and a detail you cannot point to in the documents does not belong in a valuation report. Where the documents do not answer something, leave it null rather than estimating. Respond ONLY with JSON.'
  )
ON CONFLICT (pipeline) DO NOTHING;

-- Version 1 for the freshly seeded row, exactly as 0061/0117 did: the version
-- id is the prompt id with the prefix swapped to '01VERS'. Guarded so it only
-- touches prompts that have no history yet.
INSERT INTO ai_prompt_versions (id, prompt_id, version, system_prompt, model, created_by, created_at)
SELECT overlay(p.id placing '01VERS' from 1 for 6), p.id, 1, p.system_prompt, p.model, p.updated_by, p.updated_at
FROM ai_prompts p
WHERE NOT EXISTS (SELECT 1 FROM ai_prompt_versions v WHERE v.prompt_id = p.id);
