import type { z } from 'zod';
import { calendarDate } from './calendarRange.js';

/**
 * The `from`/`to` half of a query string, checked for being a window at all.
 *
 * Both audit surfaces take an optional date pair and push it straight into SQL
 * as `occurred_at >= from AND occurred_at <= to`. A pair the caller inverted —
 * `?from=2026-06-30&to=2026-01-01`, which is what a date picker produces when
 * somebody fills the second field first, and what a hand-edited URL produces
 * constantly — matches no row and returns an empty page with a 200.
 *
 * On most list endpoints that would be a shrug. On these two it is the wrong
 * answer to the question actually being asked. `GET /audit-trail` and the admin
 * activity log exist to answer "what changed, and who changed it" — an auditor
 * narrowing to a period and receiving *nothing* reads that as "no changes were
 * made in this period", which is a finding, and files it. There is no visible
 * difference between that and a window typed backwards.
 *
 * So an inverted window is a 400 naming the field, on the same reasoning as
 * `pageParam`'s ceiling: a value that cannot mean what it says should not reach
 * SQL and come back wearing the costume of a real result. An *empty* window —
 * `from` equal to `to` — is left alone, because that is a legitimate
 * point-in-time query and the two bounds are inclusive.
 */
export function checkWindowOrder(
  value: { from?: Date | undefined; to?: Date | undefined },
  ctx: z.RefinementCtx,
): void {
  if (!value.from || !value.to) return;
  if (value.from.getTime() <= value.to.getTime()) return;
  ctx.addIssue({
    code: 'custom',
    // Reported against `to`, so a form that renders field-level errors puts it
    // on the second input — the one the caller most likely mistyped.
    path: ['to'],
    message: '`to` must not be earlier than `from`',
  });
}

/**
 * `from`/`to`, as both audit query schemas declare them.
 *
 * `calendarDate()` rather than `z.coerce.date()`: the ordering check above only
 * runs once both bounds parse, and a bound outside Postgres's timestamp range
 * parses fine and then 500s in the driver. See domain/calendarRange.ts.
 */
export const dateWindowFields = {
  from: calendarDate().optional(),
  to: calendarDate().optional(),
};
