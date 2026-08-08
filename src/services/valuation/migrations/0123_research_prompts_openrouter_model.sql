-- Re-point the six research prompts from Perplexity Sonar tiers to OpenRouter
-- model ids.
--
-- 0117 seeded `ai_prompts.model` with 'sonar' / 'sonar-pro', because at the
-- time the research route *was* Perplexity: retrieval and synthesis behind one
-- billed endpoint, and the tier chose both. Perplexity is paid-only, so that
-- endpoint has been replaced by a search provider (keyless by default) plus
-- synthesis through the OpenRouter models this platform already uses.
--
-- The column now means only "which model writes the answer up from the
-- retrieved sources" — the search engine is an account-level setting
-- (RESEARCH_PROVIDER), not a per-prompt one. Left as-is, these rows would be
-- handed to OpenRouter as a preferred model id, rejected, and fall through to
-- the real chain: a wasted round trip on every research call rather than an
-- outage, which is exactly the kind of fault that survives for a year.
--
-- The tier split 0117 made is preserved rather than flattened. Its reasoning
-- still holds: the two questions whose answers carry a figure into a report
-- exhibit get the larger model, the other four get the cheaper default.
--
-- Only rows still holding a Sonar tier are touched, so an operator who has
-- already re-pointed a prompt by hand keeps their choice.

-- Matched on the stale model value rather than on a list of pipeline names.
-- The names would have to be spelled as `ai_pipeline` enum literals, and this
-- migration has no need to know which pipelines are research ones: holding a
-- Sonar tier is itself the complete definition of a row that needs fixing.
UPDATE ai_prompts
   SET model = 'google/gemma-4-31b-it:free',
       updated_at = now()
 WHERE model = 'sonar-pro';

UPDATE ai_prompts
   SET model = 'openai/gpt-oss-20b:free',
       updated_at = now()
 WHERE model LIKE 'sonar%';

-- The version history is rewritten alongside rather than left holding a dead
-- provider's ids. These rows are the untouched seed (version 1 as shipped by
-- 0117), not an operator's edit — a "restore this version" against them would
-- otherwise reintroduce the stale model the UPDATE above just removed.
UPDATE ai_prompt_versions v
   SET model = p.model
  FROM ai_prompts p
 WHERE v.prompt_id = p.id
   AND v.model LIKE 'sonar%';
