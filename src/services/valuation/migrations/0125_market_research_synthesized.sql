-- Tell "the record had nothing" apart from "we could not write up what it had".
--
-- Until now `market_research` recorded one signal about whether a row could be
-- quoted, and it was implicit: a non-empty `citations` array. Both the sources
-- exhibit (domain/researchExhibit.ts) and the narrative thread
-- (domain/research.ts) filtered on exactly that, and the 0116 comment on the
-- column states the rule — "an answer with an empty list is ungrounded and must
-- not be quoted in a report".
--
-- That was sound while citations could only arrive attached to an answer. They
-- can now arrive without one. The AI service retrieves and synthesises in two
-- steps, and on a free-tier OpenRouter account the second step fails routinely
-- once the daily allowance is spent — with the search already done and its
-- pages in hand. Discarding those and returning a 503 wasted a completed
-- search; the service now returns the sources with a note standing where the
-- answer would be.
--
-- Such a row has citations and no answer, which is precisely the combination
-- the implicit rule reads as "quotable". Without this column the note — "sources
-- were retrieved but could not be summarised" — would be threaded into a
-- drafted 409A as though it were the market discussion, under an exhibit
-- advertising the sources it was supposedly drawn from.
--
-- DEFAULT true is correct for the backfill rather than merely convenient: every
-- row written before this migration came from a path that had no way to store
-- an unsynthesised result, so each one is an answer somebody's model actually
-- wrote. NOT NULL because a third state here would be a third case for two
-- report gates to get wrong.
ALTER TABLE market_research
  ADD COLUMN IF NOT EXISTS synthesized boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN market_research.synthesized IS
  'False when retrieval succeeded but the synthesis model did not answer: the citations are real, `answer` is a placeholder note, and the row must not be quoted in a report or threaded into a narrative.';

COMMENT ON COLUMN market_research.citations IS
  '[{url, title, date}] as ranked by the provider. Necessary but no longer sufficient for quoting: a row must also have synthesized = true.';
