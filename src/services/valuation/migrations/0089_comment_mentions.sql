-- @mentions in comments (feature-improvements §5, ranked #11). Threads, SSE
-- presence and typed review tasks all already ship; the mention is the missing
-- verb that ties them together — "@ada can you check the cap table" should
-- notify Ada and, optionally, put a task on her queue.
--
-- Mentions are stored as rows rather than parsed back out of the body on read.
-- The body is free text a user can later edit; a materialised edge is what
-- lets "who was notified about this comment" stay answerable afterwards, and
-- it is the join the notification write keys off.
CREATE TABLE comment_mentions (
  comment_id              ulid NOT NULL REFERENCES valuation_comments(id) ON DELETE CASCADE,
  user_id                 ulid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- The task opened from this mention, if the author asked for one. Nulled
  -- rather than cascaded on task deletion: the mention still happened.
  task_id                 ulid REFERENCES review_tasks(id) ON DELETE SET NULL,
  created_at              timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (comment_id, user_id)
);

-- "What was I mentioned in?" — the query behind the notification list.
CREATE INDEX comment_mentions_user_idx ON comment_mentions (user_id, created_at DESC);
