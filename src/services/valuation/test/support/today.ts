/**
 * Asserting that the server dated something "today", from a test that cannot
 * agree with itself about which day that is.
 *
 * Four integration tests built their expectation as `new Date().toISOString()
 * .slice(0, 10)` and compared it against a date the route had minted with
 * `todayLocal()`. Those two strings are the same only while the process's
 * offset from UTC is zero, so the tests were green on a UTC CI box and green
 * here until 20:00, and from 20:00 until midnight they failed — the UTC day
 * having rolled over while the local one had not.
 *
 * The direction matters and is the opposite of the bug this codebase has fixed
 * twice elsewhere. In `calendarDate.ts`'s two cases, production held the UTC
 * reading and was wrong. Here **production is right**: `routes/debt.ts`,
 * `routes/funds.ts`, `routes/asc718.ts` and `routes/reports.ts` all default to
 * `todayLocal()`, which is the day the server is actually on, and it is the
 * test that reached for UTC. So the fix belongs in the test, and pinning the
 * suite to `TZ=UTC` to make the red go away would delete the only local
 * coverage these four defaults have.
 *
 * ## Why this is not circular
 *
 * The expectation below calls the same `todayLocal` the route called, which
 * looks like asserting a function against itself. It is not, because what these
 * integration tests are for is *which* day-source the route reached for — that
 * it defaulted at all, and to the local day rather than the UTC one — and not
 * how that day is computed. The computation is pinned separately and hard, in
 * `test/unit/todayLocal.test.ts`, which forces `TZ` to `America/New_York` and
 * `Asia/Tokyo` and asserts `todayLocal` disagrees with `toISOString` in both
 * directions. A regression in the helper fails there, loudly, in every zone.
 * The alternative — re-deriving the local day inline in each test — would be a
 * second implementation of the same rule, and the two would drift.
 *
 * ## The rollover these assertions were also carrying
 *
 * Reading "today" once, at assertion time, is a flake with a real window: a
 * request issued at 23:59:59.9 and asserted at 00:00:00.1 was dated the day it
 * was made and compared against the day after. Small, but it is the kind that
 * fails once and is never reproduced, and the suite runs unattended.
 *
 * So the caller stamps the day *before* the request and passes it in, and the
 * expectation is that the server's date is one of the days that were current at
 * some point while the request was in flight. Almost always that is a
 * single-element set and the assertion is exact; across local midnight it is
 * two, which is the honest answer rather than a loosened one.
 */
import { expect } from 'vitest';
import { todayLocal } from '../../src/domain/calendarDate.js';

/**
 * The local calendar day, for a test that is about to make a request.
 *
 * Named for the call site rather than aliased to `todayLocal`, because what the
 * caller wants is the opening edge of a window and not a value to compare
 * against directly.
 */
export function beforeRequest(): string {
  return todayLocal();
}

/**
 * Every local day that was current between `startedAt` and now.
 *
 * One element unless the clock crossed local midnight mid-test, in which case
 * both days are legitimate answers because either could have been read by the
 * route. It cannot be more than two: no test in this suite spans a day.
 */
export function todayWindow(startedAt: string): string[] {
  const now = todayLocal();
  return startedAt === now ? [startedAt] : [startedAt, now];
}

/**
 * `actual` is a date column holding today.
 *
 * Sliced to ten characters so it takes both shapes these routes return — the
 * `YYYY-MM-DD` a repo has normalised through `calendarDateRow`, and the raw
 * driver Date that reaches JSON as a full instant. The original assertions used
 * `toContain` on the stringified value for the same reason; slicing says what
 * is meant, and would catch a value whose day is right but which arrived in a
 * shape the contract does not allow.
 */
export function expectDatedToday(actual: unknown, startedAt: string): void {
  expect(todayWindow(startedAt)).toContain(String(actual).slice(0, 10));
}

/**
 * `haystack` mentions today somewhere inside it.
 *
 * For the rendered cases — a report's introduction paragraph, where the date is
 * embedded in prose and there is no field to read.
 */
export function expectMentionsToday(haystack: string, startedAt: string): void {
  const days = todayWindow(startedAt);
  expect(days.some((day) => haystack.includes(day))).toBe(true);
}
