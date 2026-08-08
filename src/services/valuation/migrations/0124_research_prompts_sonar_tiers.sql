-- Put the six research prompts back on their Perplexity Sonar tiers.
--
-- This reverses 0123, and the reversal is the point rather than an admission
-- that 0123 was wrong on its own terms. 0123 was written when Perplexity had
-- been removed outright, so `ai_prompts.model` could only mean "the OpenRouter
-- model that writes the answer up". Perplexity is now the *primary* provider
-- again, with the keyless search path behind it as an automatic fallback, and
-- the column reverts to meaning what 0117 made it mean: the Sonar tier to ask
-- for. That is the value that will be correct the day a Perplexity key is
-- added, which is the state this deployment is being held ready for.
--
-- 0117's split is restored with it, for its original reason: the two questions
-- whose answers carry a figure into a report exhibit get the reasoning tier,
-- the other four get the cheap one.
--
-- The fallback is unharmed by this. `research.synthesis_model` drops a model
-- that starts with `sonar` rather than forwarding it, so when the search path
-- answers it uses the default OpenRouter chain (or RESEARCH_SYNTHESIS_MODEL)
-- instead of putting a guaranteed 404 at the head of it. A prompt row
-- therefore no longer has to be right for both providers at once — it names
-- the primary's tier, and the fallback ignores it.
--
-- Matched on the OpenRouter ids 0123 wrote, so an operator who has since
-- re-pointed a prompt by hand keeps their choice.

UPDATE ai_prompts
   SET model = 'sonar-pro',
       updated_at = now()
 WHERE model = 'google/gemma-4-31b-it:free'
   AND pipeline::text IN (
         'market_research', 'industry_overview', 'industry_outlook',
         'competitor_analysis', 'company_overview', 'industry_finder'
       );

UPDATE ai_prompts
   SET model = 'sonar',
       updated_at = now()
 WHERE model = 'openai/gpt-oss-20b:free'
   AND pipeline::text IN (
         'market_research', 'industry_overview', 'industry_outlook',
         'competitor_analysis', 'company_overview', 'industry_finder'
       );

-- The version history follows the row, same as in 0123 and for the same
-- reason: these are the untouched 0117 seed, not an operator's edit, and a
-- "restore this version" against them must not reintroduce the id the UPDATEs
-- above just removed.
UPDATE ai_prompt_versions v
   SET model = p.model
  FROM ai_prompts p
 WHERE v.prompt_id = p.id
   AND v.model IN ('google/gemma-4-31b-it:free', 'openai/gpt-oss-20b:free')
   AND p.model LIKE 'sonar%';
