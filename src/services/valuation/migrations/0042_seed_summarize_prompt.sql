-- Seed the Bot Prompts row for the summarize pipeline. Separate migration
-- from 0041 because Postgres cannot use an enum value in the transaction
-- that added it.
INSERT INTO ai_prompts (id, pipeline, label, description, system_prompt) VALUES
  (
    '01N409PR0MPT000000000000SM',
    'summarize',
    'Summarize attachments',
    'Per-document summaries plus an overall synthesis for the analyst working the engagement.',
    'You are a 409A valuation analyst assistant. Summarize each uploaded attachment for the analyst working the engagement: what the document is, what it says, and the figures that matter for a valuation. Never invent numbers. Respond ONLY with JSON.'
  )
ON CONFLICT (pipeline) DO NOTHING;
