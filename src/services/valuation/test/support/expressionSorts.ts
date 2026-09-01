import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { sourceFiles } from './sourceFiles.js';

/**
 * Every `ORDER BY` in the service whose leading term is an expression, and the
 * roster that keeps `expressionSortPlans` pointed at all of them.
 *
 * A btree indexes values. `ORDER BY (revoked_at IS NULL) DESC` sorts by a
 * boolean no index on `revoked_at` holds, so unless somebody built an index
 * over that exact expression the planner has nothing to seek on: it reads the
 * whole table and top-N sorts it to hand back a page. Migration 0181 fixed two
 * lists of that shape, 0192 and 0193 fixed two more, and the interesting part
 * is why the two searches that found the first pair could not find the second.
 *
 *   * 0178's search asked which *columns* a sort key names. These name none.
 *   * R202's guard asks exactly the right question, of a roster somebody typed.
 *     `listScimTokens` is `listAllApiTokens` character for character on a
 *     second ledger and was simply not in it — the same failure R250 found in
 *     the N+1 population guard, and the failure mode of every hand-kept roster
 *     in this repo: a missing entry is not asked, and not being asked reads in
 *     a test run exactly like passing.
 *
 * So the roster moves here, beside a scan of the source, and
 * `expressionSortCoverage.test.ts` — a unit test, no database — requires every
 * expression-led sort the service issues to be either measured or named as
 * deliberately unmeasured with a mechanism. A *unit* test on purpose: the plan
 * guard skips itself where there is no Postgres, so its roster's only check
 * used to disappear on the machines least likely to notice.
 *
 * It cannot say whether a statement is *correctly* measured — only that it is
 * accounted for. Whether the index is reached is the plan guard's job; keeping
 * it pointed at everything is this one's.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
export const SRC_DIR = path.resolve(here, '../../src');

export interface ExpressionSort {
  /** Path relative to `src`, e.g. `repos/apiTokens.ts`. */
  readonly file: string;
  readonly line: number;
  /** The first sort term, whitespace-collapsed. */
  readonly lead: string;
  /** The whole clause, for the failure message. */
  readonly clause: string;
}

/**
 * A sort term a plain btree on a column can serve: an optional alias, a column,
 * an optional direction, an optional NULLS placement. Everything else is an
 * expression, and an expression needs an index built over that expression —
 * or a reason it does not.
 */
const PLAIN_TERM = /^[a-z_][a-z_0-9]*(\.[a-z_][a-z_0-9]*)?(\s+(ASC|DESC))?(\s+NULLS\s+(FIRST|LAST))?$/i;

/** Where an `ORDER BY` clause ends, other than at a closing paren. */
const CLAUSE_END = /^\s(LIMIT|OFFSET|FOR\s+UPDATE|FETCH\s+FIRST)\b/i;

/**
 * Blanks comments while keeping every other byte in place, so the line numbers
 * this reports stay the file's own. Prose about `ORDER BY ... DESC` is
 * plentiful in this repo and reads to a scanner exactly like SQL.
 */
function withoutComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, keep: string) => keep + ' '.repeat(m.length - keep.length));
}

/**
 * Blanks SQL line comments inside a query, keeping every byte's position.
 *
 * `withoutComments` above strips the TypeScript kinds; a query written as a
 * template literal carries its own, and this repo writes long ones. R306's
 * outbox sweep explains its index in `--` prose that contains the words "the
 * ORDER BY below was a sort above it", and the scanner read that sentence as a
 * clause and reported `repos/emailOutbox.ts` as an unaccounted expression sort
 * — a roster failing over a comment describing a statement rather than over the
 * statement, which is the same thing R311's path harvest had to be taught.
 *
 * Length-preserving so `at.index` still names the byte it found and the line
 * numbers stay the file's own. A `--` inside a quoted SQL string would be
 * blanked too; that can only lose a detection, never invent one, and the
 * vacuity guard in the test above is what would notice a scanner going quiet.
 */
function withoutSqlComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, (m) => ' '.repeat(m.length));
}

/** Splits on commas outside parentheses — `count(*) FILTER (…), x` is two terms. */
function topLevelTerms(clause: string): string[] {
  const terms: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of clause) {
    if (ch === '(') depth += 1;
    else if (ch === ')') depth -= 1;
    if (ch === ',' && depth === 0) {
      terms.push(current);
      current = '';
    } else current += ch;
  }
  terms.push(current);
  return terms;
}

/** Every expression-led `ORDER BY` in a SQL string literal under `src`. */
export function scanExpressionSorts(dir: string = SRC_DIR): ExpressionSort[] {
  const found: ExpressionSort[] = [];
  for (const file of sourceFiles(dir)) {
    const text = withoutComments(readFileSync(file, 'utf8'));
    // String literals only. Every query in this service is written as one, and
    // scanning raw file text picks up identifiers and prose instead.
    for (const literal of text.matchAll(/`(?:[^`\\]|\\.)*`|'(?:[^'\\\n]|\\.)*'/g)) {
      const sql = withoutSqlComments(literal[0].slice(1, -1));
      for (const at of sql.matchAll(/\bORDER\s+BY\s+/gi)) {
        const from = at.index + at[0].length;
        let depth = 0;
        let end = sql.length;
        for (let i = from; i < sql.length; i += 1) {
          const ch = sql[i];
          if (ch === '(') depth += 1;
          else if (ch === ')') {
            if (depth === 0) {
              end = i;
              break;
            }
            depth -= 1;
          } else if (depth === 0 && CLAUSE_END.test(sql.slice(i, i + 13))) {
            end = i;
            break;
          }
        }
        const clause = sql.slice(from, end).replace(/\s+/g, ' ').trim().replace(/,$/, '');
        const lead = topLevelTerms(clause)[0]?.trim() ?? '';
        if (!lead || PLAIN_TERM.test(lead)) continue;
        found.push({
          file: path.relative(dir, file),
          line: text.slice(0, literal.index + at.index).split('\n').length,
          lead,
          clause,
        });
      }
    }
  }
  return found;
}

/** The roster key: the statement's home and its leading term, not its line. */
export const keyOf = (s: Pick<ExpressionSort, 'file' | 'lead'>): string => `${s.file} :: ${s.lead}`;

/**
 * The expression sorts `expressionSortPlans.test.ts` reads a plan for. Each is
 * a list whose leading term is a boolean over a column, indexed as that
 * expression by 0181 (the first two), 0192 and 0193.
 */
export const MEASURED: readonly string[] = [
  'repos/apiTokens.ts :: (t.revoked_at IS NULL) DESC',
  'repos/jobAlerts.ts :: resolved_at IS NOT NULL ASC',
  'repos/ssoConfig.ts :: (revoked_at IS NULL) DESC',
  "repos/tasks.ts :: (t.status IN ('done','cancelled'))",
];

/**
 * The rest, each with the mechanism that makes an expression index the wrong
 * answer — not "it is a small table", which is the reason a sort survives to
 * the day it is not. Three mechanisms cover all of them, and each is a
 * property of the statement rather than of today's row counts.
 */
export const UNMEASURED: Readonly<Record<string, string>> = {
  // --- The leading term reads a query parameter, so there is no expression to
  // index: CREATE INDEX takes an immutable expression, and `owner_id = $1`
  // takes a different value on every call.
  'repos/savedViews.ts :: (v.owner_id = $1) DESC':
    "The leading term compares a column to a bind parameter, so no immutable expression exists for an index to be built over — the sort is unservable by construction rather than by omission. What is bounded is the answer: SAVED_VIEW_PAGE_LIMIT caps the page and MAX_VIEWS_PER_USER caps the own half. The shared half is every ops user's views and is the open item R193 recorded; it needs a windowed query or a counter, not an index.",
  'repos/communications.ts :: array_position($3::text[], category)':
    'Orders by position within a category list passed as a bind parameter, so as above there is no immutable expression to index. The set is the communication-template catalogue, whose size is the number of templates the product ships rather than a function of platform history — it does not grow with tenants, engagements or time.',

  // --- The sort is above an aggregation. Its input is the GROUP BY output,
  // which no index on any base table orders.
  'repos/emailDelivery.ts :: count(*) DESC':
    'Sorts the output of a GROUP BY, not rows of a table: no index orders aggregate results, because the values being ordered do not exist until the grouping has run. The scan beneath it is already windowed by `created_at >= now() - $1 days`, which is the bound that matters here.',
  'repos/firmDashboard.ts :: max(created_at) DESC':
    "Sorts the output of a GROUP BY, as above — the ordering key is an aggregate computed by the query, so it cannot be precomputed by an index on any base table. The grouping is over one firm's book, bounded by the partner predicate beneath it.",
  'repos/firmDashboard.ts :: count(*) FILTER (WHERE v.state = ANY($2)) DESC':
    "Sorts the output of a GROUP BY by a filtered aggregate, which no index can hold for the same reason as above, and which additionally depends on a bind parameter. Grouping is over one firm's analysts.",
  "repos/dataRemediation.ts :: (v.state = 'published') DESC":
    'Sorts the result of a CTE joined to `valuations`, so the rows being ordered are already materialised and no index on a base table can deliver them in this order. This is a remediation sweep over the book by design; its cost is the scan beneath the sort, which this census does not claim to have measured.',

  // --- The set being sorted is already bounded to one engagement by an indexed
  // equality predicate, so the sort is over a handful of rows whatever the
  // table holds.
  // R306 removed the two that used to sit here — `findCurrentProjection` and
  // `findCurrentVolatilityEstimate`. Their exemption was true (the WHERE does
  // bound the sort to one engagement) and was not enough: what it bounds is the
  // table, and what these read is the engagement's run history, which R304
  // established is unbounded and is adopted from at any depth. Both are now
  // `applied_at DESC NULLS LAST, …`, which is the same ordering spelled in
  // columns — a btree DESC is stored NULLS FIRST — and 0200 indexes it. The
  // lesson for the next entry below: "bounded to one engagement" answers "does
  // this scan the table", not "is the work a function of history".
  "repos/valuationTags.ts :: array_position(ARRAY['accepted','suggested','rejected']::valuation_tag_status[], status)":
    "Bounded to one valuation by an indexed equality on `valuation_id`. The leading expression is over a literal array and so is indexable in principle, but the set it orders is one engagement's tags.",
  "events/record.ts :: payload->>'to'":
    'Bounded twice: to one valuation by an indexed equality, and then by DISTINCT ON over the target state, which the `ValuationState` enum caps at a dozen rows. The bound is stated by the schema rather than by a page size.',

  // --- Built elsewhere, guarded elsewhere.
  "repos/valuations.ts :: ${parts.join(', ')}":
    "Not a literal ordering: this is `orderBySql`, which composes the valuation list's sort from the terms the API accepts. Migration 0170 indexes all seventeen variants and `listSortPlans.test.ts` plans each one, including the pre-fix spellings as its own discriminators.",
};
