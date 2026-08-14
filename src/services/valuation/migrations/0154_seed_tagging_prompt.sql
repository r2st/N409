-- Seed the Bot Prompts row for the tagging agent. Separate migration from 0153
-- because Postgres cannot use an enum value in the transaction that added it —
-- the same constraint 0060/0061, 0116/0117 and 0151/0152 document.
--
-- `system_prompt` mirrors the agent's built-in default so behaviour is
-- unchanged until an admin edits it in the Bot Prompts view; `model` NULL means
-- the AI service's own fallback chain.
--
-- The prompt's whole substance is the closed vocabulary. 409.ai's
-- `AI:FindRelevantTags` runs on perplexity-PRO and returns free text, which is
-- the arrangement that makes a tag list unqueryable: `saas`, `SaaS` and `B2B
-- SaaS` are one fact and three tags. Here the catalogue is supplied in the user
-- message with each tag's definition, the model picks from it, and anything
-- else it returns is dropped by `mapAgentTags` rather than normalised — see
-- domain/valuationTags.ts for why normalising is the trap and not the fix.
INSERT INTO ai_prompts (id, pipeline, label, description, system_prompt) VALUES
  (
    '01N409PR0MPT000000000000TG',
    'tagging',
    'Engagement tagging',
    'Classifies an engagement against the platform''s fixed tag vocabulary — stage, revenue, business model, capital structure, valuation context and risk — from its own documents and parameters. Covers 409.ai''s AI:FindRelevantTags prompt, with a closed vocabulary so the tags can actually be filtered and compared across a book of work.',
    'You are a valuation analyst classifying an engagement for a firm''s own records. You are given a company''s documents with identifying details removed, its stored valuation parameters, and a fixed list of tags with their definitions. Choose only tags from that list, and only where the material you were given supports them — a tag you cannot point to evidence for is worse than a missing tag, because someone will filter on it. Never invent a tag that is not in the list. Give each tag a short rationale and name the document or field it came from. Respond ONLY with JSON.'
  )
ON CONFLICT (pipeline) DO NOTHING;

-- Version 1 for the freshly seeded row, exactly as 0061/0117/0152 did: the
-- version id is the prompt id with the prefix swapped to '01VERS'. Guarded so
-- it only touches prompts that have no history yet.
INSERT INTO ai_prompt_versions (id, prompt_id, version, system_prompt, model, created_by, created_at)
SELECT overlay(p.id placing '01VERS' from 1 for 6), p.id, 1, p.system_prompt, p.model, p.updated_by, p.updated_at
FROM ai_prompts p
WHERE NOT EXISTS (SELECT 1 FROM ai_prompt_versions v WHERE v.prompt_id = p.id);
