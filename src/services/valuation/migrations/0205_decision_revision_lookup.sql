-- "Has this decision already been revised", as an index rather than a scan.
--
-- `methodology_decisions.supersedes` is the decision log's only edge, and until
-- R372 nothing asked the question in the other direction — the list route reads
-- a whole page and builds the struck-through set in JavaScript, which needs no
-- index because it is already reading every row it is about to render.
--
-- The guard R372 adds does ask it, once per revision, and it is the read that
-- decides whether a write is allowed: a second revision of one decision forks
-- the log into two live, contradictory entries. Without an index that is a
-- sequential scan of every decision the platform has ever recorded, taken while
-- holding a row lock on the decision being revised — the shape that turns a
-- cheap guard into the thing two operators queue behind.
--
-- Partial, because `supersedes` is NULL on every decision that revises nothing,
-- which is most of them: only the revisions are ever looked up this way.
CREATE INDEX IF NOT EXISTS methodology_decisions_supersedes_idx
  ON methodology_decisions (supersedes)
  WHERE supersedes IS NOT NULL;
