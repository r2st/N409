-- listComments sorts by (pinned DESC, created_at DESC) filtered by valuation_id.
-- The existing (valuation_id, created_at) index cannot serve the pinned-first
-- sort, forcing a sort step after the index scan.
CREATE INDEX CONCURRENTLY IF NOT EXISTS valuation_comments_pinned_sort_idx
    ON valuation_comments (valuation_id, pinned DESC, created_at DESC);
