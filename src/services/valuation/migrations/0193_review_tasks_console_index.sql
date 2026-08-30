-- The ops task console's default page, which sorted the whole queue to draw it.
--
-- `listTasks` builds its WHERE from four optional filters, and `GET
-- /api/v1/tasks` with no query string supplies none of them. So the default
-- view of the console — the one an operator lands on — is an unfiltered read of
-- `review_tasks` ordered by:
--
--     (t.status IN ('done','cancelled')), t.due_at ASC NULLS LAST,
--     t.created_at DESC, t.id DESC
--
-- Live tasks first, then soonest due, then newest: correct, and unservable by
-- any index this schema had. The leading key is a boolean expression (0181's
-- shape — a btree on `status` orders the enum, not the predicate over it) and
-- the remaining three run in mixed directions (0170's shape — no single btree
-- produces a mixed ordering forwards or backwards). The two together meant a
-- sequential scan and a top-N sort of every review task ever raised, to hand
-- back fifty rows.
--
-- `review_tasks` only grows. A task is settled by moving `status` to `done` or
-- `cancelled`, never by deletion — that is what the leading sort term is *for*
-- — and several are raised per engagement, so the sort has been getting more
-- expensive in proportion to the platform's history while the page it produces
-- stayed fifty rows.
--
-- Both halves are fixable at once, because CREATE INDEX takes a direction and a
-- NULLS placement per column. The index below is the ORDER BY, term for term.
--
-- Measured at 20k tasks, warm, best of seven (EXPLAIN ANALYZE, shared blocks):
--
--     listTasks, no filters   4.69 ms  339 blk  ->  0.01 ms  9 blk
--
-- The filtered shapes were checked too, and neither regresses: a
-- `valuation_id` filter still goes through `review_tasks_valuation_idx` and
-- sorts the couple of dozen rows it finds, and a `status` filter seeks this
-- index and filters above it.
--
-- What this does not fix, deliberately: `listTasks` also runs `count(*)` over
-- the same WHERE for the total, and paginates with OFFSET. The count is a
-- genuine full aggregate — no index answers "how many are there" — and a deep
-- OFFSET still walks the rows it skips. Both are bounded by the console's own
-- page numbers rather than by the table, and neither is what an operator opening
-- the page pays.
--
-- Not CONCURRENTLY: db/migrate.ts wraps each file in BEGIN/COMMIT. Tasks are
-- written by analysts one transition at a time, so the SHARE lock while this
-- builds is not in front of a queue.

CREATE INDEX IF NOT EXISTS review_tasks_console_idx
    ON review_tasks (((status IN ('done', 'cancelled'))) ASC,
                     due_at ASC NULLS LAST,
                     created_at DESC,
                     id DESC);
