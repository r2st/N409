import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Every interpolation that lands in SQL *text* must be reviewed.
 *
 * The estate's SQL is parameterised throughout — an audit of all 426 query
 * templates found no injectable path. But nothing held that property in place.
 * Values reach Postgres through `$1`-style placeholders, while identifiers,
 * predicates and fragments are assembled in TypeScript and interpolated into
 * the query text; the two look identical in a template literal, and only the
 * second is dangerous. A new `WHERE name = '${req.query.name}'` would read like
 * every safe line around it and no test would notice.
 *
 * So this sweep enumerates the interpolations, classifies the ones that are
 * safe *by shape*, and requires everything else to be named in the registry
 * below. Adding a query that interpolates a new expression fails here until
 * somebody writes it down, which is the point: the failure is a request for
 * review, not an accusation.
 *
 * The registry is keyed by file and expression text rather than by line, so it
 * does not expire when somebody edits above it — the failure mode that made an
 * earlier exemption list useless (R61).
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../../../..');
const SCAN_ROOTS = ['src/services', 'src/packages'];

/**
 * A template literal is treated as SQL when it contains a SQL keyword. Loose on
 * purpose: a false positive costs a registry line, a false negative costs the
 * whole guarantee. `src/services/valuation/src/email/smtp.ts` is one such false
 * positive — it builds an SMTP envelope containing the word FROM — and is
 * registered rather than special-cased, because the next one will not be smtp.
 */
const SQL_KEYWORD =
  /\b(SELECT|INSERT INTO|UPDATE|DELETE FROM|WITH RECURSIVE|ORDER BY|WHERE|VALUES|RETURNING|SET|JOIN|FROM)\b/;

export interface SqlInterpolation {
  file: string;
  line: number;
  expr: string;
}

/**
 * Template literal bodies in a TypeScript source, with `${…}` left intact.
 *
 * Hand-rolled rather than regexed because the interesting inputs are exactly
 * the ones a regex gets wrong: a backtick inside a string or a comment, a
 * nested template inside an interpolation, an escaped backtick. Getting any of
 * those wrong silently drops queries from the scan, and a sweep that scans
 * nothing passes.
 */
export function templateLiterals(src: string): { index: number; body: string }[] {
  const out: { index: number; body: string }[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (c === '\\') {
      i += 2;
      continue;
    }
    if (c === '"' || c === "'") {
      i += 1;
      while (i < src.length && src[i] !== c) i += src[i] === '\\' ? 2 : 1;
      i += 1;
      continue;
    }
    if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i += 1;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i);
      i = end === -1 ? src.length : end + 2;
      continue;
    }
    if (c === '`') {
      const start = i;
      let j = i + 1;
      const body: string[] = [];
      while (j < src.length) {
        if (src[j] === '\\') {
          body.push(src.slice(j, j + 2));
          j += 2;
          continue;
        }
        if (src[j] === '$' && src[j + 1] === '{') {
          let depth = 1;
          body.push('${');
          j += 2;
          while (j < src.length && depth > 0) {
            if (src[j] === '{') depth += 1;
            else if (src[j] === '}') depth -= 1;
            if (depth > 0) body.push(src[j]!);
            j += 1;
          }
          body.push('}');
          continue;
        }
        if (src[j] === '`') break;
        body.push(src[j]!);
        j += 1;
      }
      out.push({ index: start, body: body.join('') });
      i = j + 1;
      continue;
    }
    i += 1;
  }
  return out;
}

/**
 * Interpolations in a template body, excluding placeholder indices.
 *
 * `$${params.length}` — an interpolation immediately preceded by a literal `$`
 * — produces `$7`, a placeholder *number*. That is the parameterised path and
 * is safe whatever the expression evaluates to, because the value never touches
 * the query text. Everything else becomes SQL text and is returned.
 */
export function rawTextInterpolations(body: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < body.length) {
    if (body[i] === '$' && body[i + 1] === '{') {
      let depth = 1;
      let j = i + 2;
      const buf: string[] = [];
      while (j < body.length && depth > 0) {
        if (body[j] === '{') depth += 1;
        else if (body[j] === '}') depth -= 1;
        if (depth > 0) buf.push(body[j]!);
        j += 1;
      }
      if (body[i - 1] !== '$') out.push(buf.join('').trim());
      i = j;
      continue;
    }
    i += 1;
  }
  return out;
}

/**
 * Shapes that need no registry entry, because the expression cannot carry
 * request data into the query text:
 *
 *  - `UPPER_SNAKE` / `UPPER_SNAKE(...)` — a module-scope SQL constant or a
 *    builder over one, fixed at load.
 *  - `xs.join(', ')` — a fragment array. Every such array in this codebase is
 *    built from an allow-list of column names with `$n` placeholders for the
 *    values; the join itself contributes no data.
 *  - a ternary whose branches are both string literals — two fixed spellings.
 */
const SAFE_SHAPES: RegExp[] = [
  /^[A-Z][A-Z0-9_]*$/,
  /^[A-Z][A-Z0-9_]*\(/,
  /^[A-Za-z_$][\w.$]*\.join\(/,
  /^[^?]+\?\s*(`[^`]*`|'[^']*')\s*:\s*(`[^`]*`|'[^']*')$/,
];

/**
 * Reviewed interpolations, file → expressions. Each was read at the point of
 * interpolation and traced to its source; the notes record what makes it safe.
 * Adding to this list means doing the same.
 */
const REVIEWED: Record<string, string[]> = {
  /*
   * `publicPartnerNameSql(alias)` (R250) builds the white-label CASE that
   * decides whether a row shows a firm's brand name or its ops-side name. Its
   * only interpolation is the *table alias* the caller is joining under, and
   * every call site passes a literal — 'p', 'partners'. Nothing about a request
   * reaches it: the alias is chosen when the query is written, and the column
   * values it compares are `$n`-free because they are columns, not values.
   *
   * Four entries rather than one because the registry is keyed by file, which is
   * what makes a stale entry findable when a call site goes away.
   */
  'src/services/valuation/src/routes/branding.ts': ["publicPartnerNameSql('partners')"],
  'src/services/valuation/src/routes/communications.ts': ["publicPartnerNameSql('p')"],

  // Not SQL at all — an SMTP envelope whose header names trip the keyword test.
  'src/services/valuation/src/email/smtp.ts': ['bareAddress(opts.from)'],

  // The migration session's two bounds (R192), interpolated into `SET LOCAL`.
  // Unavoidable rather than convenient: SET takes no bind parameter, so `$n`
  // is not available for these at all. Both reach the statement only through
  // `resolveMigrationTimeouts`, which admits a value solely when
  // `Number.isInteger(n) && n >= 0` and otherwise returns the module default —
  // so a non-integer never arrives, and there is no request path to either one
  // regardless: they come from env at boot, read once per migrate() call.
  // `test/unit/migrationTimeouts.test.ts` asserts the rejection directly,
  // including on a value spelled as a trailing SET fragment.
  'src/services/valuation/src/db/migrate.ts': ['timeouts.ddlLockTimeoutMs', 'timeouts.statementTimeoutMs'],

  // `whereSql` / `where` / `filter` / `search` / `scope` / `cursorSql` / `from`
  // / `union` / `values`: predicate and column-list fragments assembled in the
  // same function from string literals, with every value pushed onto `params`
  // and referenced as `$n`. No branch of any of them embeds a value.
  // `sql` is one branch's WHERE, `limitParam` is the `$n` naming the merge
  // window (R167) — a placeholder number, never a value.
  'src/services/valuation/src/repos/activityLog.ts': ['limitParam', 'sql', 'whereSql'],
  'src/services/valuation/src/repos/adminUsers.ts': ['search', 'whereSql'],
  'src/services/valuation/src/repos/contactSubmissions.ts': ['where'],
  'src/services/valuation/src/repos/engagements.ts': ['cursorSql'],
  'src/services/valuation/src/repos/firmDashboard.ts': ['filter'],
  'src/services/valuation/src/repos/inbox.ts': ['from', 'readerParam', 'scope', 'unreadExpr'],
  'src/services/valuation/src/repos/monitors.ts': ['cursorSql'],
  'src/services/valuation/src/repos/onboarding.ts': ['whereSql'],
  'src/services/valuation/src/repos/payments.ts': ['where'],
  'src/services/valuation/src/repos/reportTemplates.ts': ['whereSql'],
  'src/services/valuation/src/repos/reviews.ts': ['whereSql'],
  'src/services/valuation/src/repos/support.ts': ['whereSql'],
  'src/services/valuation/src/repos/systemSettings.ts': ['values'],
  'src/services/valuation/src/repos/tasks.ts': ['whereSql'],

  // `eligible` / `frozen`: the outbox purge's two predicate fragments, declared
  // as template literals a few lines above the statements that embed them and
  // holding no interpolation of their own — every value is `$1` (retention
  // days), `$2` (max attempts) or `$3` (the batch limit), and both statements
  // number them the same way on purpose. The reason they are fragments at all
  // is that the count and the delete must ask the same question: two spellings
  // of "eligible" is how an operator's "how much is your hold holding" stops
  // describing the rows the delete actually skipped.
  'src/services/valuation/src/repos/retention.ts': ['eligible', 'frozen'],

  // Two fixed spellings chosen by a boolean.
  'src/services/valuation/src/repos/boardApprovals.ts': ['approvedAt'],

  // `conditionSql[...]`: map lookup on `auto_emails.condition`, which carries a
  // CHECK constraint in migration 0104 and a `z.enum` at the route. `?? 'false'`
  // covers the miss. `cursorSql` is the drip scan's keyset page — `AND v.id >
  // $n` in one fixed spelling, with the cursor pushed onto `params`, as in the
  // `engagements.ts` and `monitors.ts` entries above.
  'src/services/valuation/src/repos/communications.ts': [
    "conditionSql[campaign.condition] ?? 'false'",
    'cursorSql',
    "publicPartnerNameSql('p')",
  ],

  // The retry ladder's schedule (migration 0159), built in SQL so it lands in
  // the same statement that records the failure. Every argument is a string
  // literal at the call site: two are placeholder *names* (`'$2'` the status,
  // `'$4'`/`'$5'` the attempt ceiling and the ladder array, all bound), and the
  // third is a fixed column expression naming which attempt count to index by —
  // `attempts + 1` where the statement increments, `attempts` where the claim
  // already did. The builder's own text interpolates nothing but those and two
  // module-scope numbers (EMAIL_JITTER_FLOOR). No caller passes anything else,
  // and none of it is reachable from a request.
  //
  // `emailWithheldSql` is the same shape one level up (R228): the four
  // conditions that hold a row back without scheduling it, built once so the
  // retry claim and the queue monitor cannot disagree about what claimable
  // means. `alias` is the table name the predicate is written against and
  // `exemptTemplates` is the suppression exemption list — bound as `$5` by the
  // claim, and inlined by the monitor, which has no parameters, through
  // `suppressionExemptSql`. That builder refuses any key that is not a bare
  // identifier, and both arguments are string literals at their two call sites;
  // nothing here is reachable from a request.
  'src/services/valuation/src/repos/emailOutbox.ts': [
    "retryScheduleSql('$2', 'email_outbox.attempts + 1', '$4', '$5')",
    "retryScheduleSql('$2', 'email_outbox.attempts', '$4', '$5')",
    'alias',
    'exemptTemplates',
    "emailWithheldSql('email_outbox', '$5::text[]')",
    // R272's `retireStrandedEmails`, which is the same predicate against the
    // same table, with its exemption list bound at a different index.
    "emailWithheldSql('email_outbox', '$4::text[]')",
  ],

  // `column` indexes NOTIFIED_COLUMN with a two-member union type.
  'src/services/valuation/src/repos/jobAlerts.ts': ['column'],

  // `from` is a JOB_SOURCES entry; the helpers take literal arguments —
  // including `emailWithheldSql`, the monitor's half of the shared claim
  // predicate (R228), whose exemption list is built by `suppressionExemptSql`
  // and refuses any key that is not a bare identifier.
  'src/services/valuation/src/repos/jobs.ts': [
    "emailWithheldSql('e', suppressionExemptSql())",
    'from',
    "statusCase('ai_job', 'j.status')",
    "statusCase('calculation', 'c.status')",
    "statusCase('email', 'e.status')",
    "statusCase('pipeline_run', 'p.status')",
    "statusCase('webhook_delivery', 'd.status')",
    'unionSql(JOB_SOURCES)',
    'unionSql(sources)',
    'whereSql',
  ],

  // Both are string-literal union types, and both callers pass literals.
  'src/services/valuation/src/repos/organizations.ts': ['parentColumn', 'table'],

  // Takes the placeholder *name* `'$1'`; the search text is a bound parameter.
  'src/services/valuation/src/repos/search.ts': ["userSearchSql('$1')"],

  // `alias` / `idRef` / `ownerRef` / `readCol` / `column` / `like` / `unreadSql`
  // / `scopeClause` are literals or literal-derived; `orderBySql` builds ORDER
  // BY only from SORTABLE_COLUMNS terms that `parseSort` has validated, and
  // rejects the whole request otherwise. Pinned behaviourally below.
  //
  // The keyset four are the cursor page (`domain/pagination.ts`), and the thing
  // to check about them is that the *cursor* never reaches the query text —
  // only its shape does. `cursorSelect` is `cursorAtSql('created_at')`, a fixed
  // column name and a fixed to_char format. `predicate` is
  // `keysetAfterSql(...)` over two literal column names and two placeholder
  // *names* built from `listParams.length`, a number; `cursor.at` and
  // `cursor.id` are pushed onto `listParams` and referenced as `$n`, never
  // spliced. `listWhere` is `whereSql` (already reviewed above) with that
  // predicate appended. `limitSql` is one of two fixed spellings over the same
  // `$n` indices. So the only request-derived values here — the two halves of a
  // client-supplied cursor — are bound parameters, and `decodeCursor` has
  // already refused anything that is not a timestamp and a ULID before they get
  // this far.
  'src/services/valuation/src/repos/valuations.ts': [
    'alias',
    "publicPartnerNameSql('p')",
    // R167. `limitParam` is the `$n` naming the dashboard feed's per-branch
    // window; `userFullNameSql('users')` is the same column expression the
    // full-name trigram index is built on, with no argument of its own.
    'limitParam',
    "userFullNameSql('users')",
    'column',
    'cursorSelect',
    'idRef',
    'like',
    'limitSql',
    'listWhere',
    'orderBySql(filters.sort)',
    "orderBySql(filters.sort, 'v.')",
    'ownerRef',
    'predicate',
    // The dashboard feed's two visibility fragments. `visibleTypes` is a
    // literal `e.type = ANY($n)` whose only variable part is the placeholder
    // number, and the array itself is bound onto `args`; `adminBranch` is a
    // constant SQL string chosen by a boolean, interpolating only `whereSql`,
    // which is reviewed on its own line above.
    'adminBranch',
    'visibleTypes',
    'readCol',
    'scopeClause',
    'unreadSql',
    "userFullNameSql('su')",
    'where',
    'whereSql',
  ],

  // The delivery log's keyset page, same two builders as the `valuations.ts`
  // keyset entries above and safe for the same reason: both take literal column
  // names and literal placeholder names (`'$2'`, `'$3'`), and the cursor's two
  // fields are bound onto `params`. Called inline rather than via a local, so
  // the sweep sees the call expressions themselves.
  'src/services/valuation/src/repos/partnerWebhooks.ts': [
    "cursorAtSql('created_at')",
    "keysetAfterSql('created_at', 'id', '$2', '$3')",
  ],

  // `target.table` / `target.where`: the housekeeping sweep's target list is a
  // frozen array of object literals in `domain/housekeeping.ts` — five table
  // names and five predicates, all written in that file and none reachable from
  // a request. `runHousekeepingSweep` iterates that array and nothing else; it
  // takes no table or predicate from its caller. The two values it *is* given —
  // the retention interval and the batch size — are bound as `$1` and `$2`
  // rather than interpolated, which is the line worth watching if a future
  // caller ever wants to sweep a table it names.
  'src/services/valuation/src/hooks/housekeeping.ts': ['target.table', 'target.where'],

  // The visibility clause for the caller's role — a fixed string per scope kind.
  'src/services/valuation/src/routes/analytics.ts': ['scope.clause'],
  'src/services/valuation/src/routes/bridge.ts': ['scope.clause'],
  'src/services/valuation/src/routes/reports.ts': ['scope.clause'],
};

function sourceFiles(dir: string): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const entry of entries) {
    if (['node_modules', 'dist', 'coverage', '.venv'].includes(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts') && !entry.name.includes('.test.'))
      out.push(full);
  }
  return out;
}

interface SweepResult {
  templates: number;
  interpolations: SqlInterpolation[];
}

function sweep(): SweepResult {
  let templates = 0;
  const interpolations: SqlInterpolation[] = [];
  for (const root of SCAN_ROOTS) {
    for (const file of sourceFiles(path.join(repoRoot, root))) {
      const src = readFileSync(file, 'utf8');
      const rel = path.relative(repoRoot, file).split(path.sep).join('/');
      for (const { index, body } of templateLiterals(src)) {
        if (!SQL_KEYWORD.test(body)) continue;
        templates += 1;
        const line = src.slice(0, index).split('\n').length;
        for (const expr of rawTextInterpolations(body)) interpolations.push({ file: rel, line, expr });
      }
    }
  }
  return { templates, interpolations };
}

const result = sweep();

describe('SQL interpolation sweep', () => {
  /**
   * The sweep's own smoke test. Everything below is an assertion that a scan
   * found nothing wrong, which is also what a scan that found nothing at all
   * reports — a broken glob, a renamed directory, or a parser that silently
   * gave up would all turn this file green. These numbers are what separates
   * "clean" from "blind"; they are floors, not pins, so ordinary growth does
   * not touch them.
   */
  it('actually scanned the estate', () => {
    expect(result.templates).toBeGreaterThan(300);
    expect(result.interpolations.length).toBeGreaterThan(120);
    expect(new Set(result.interpolations.map((i) => i.file)).size).toBeGreaterThan(30);
  });

  it('classifies a value interpolated into query text as unreviewed', () => {
    const body = "SELECT * FROM users WHERE email = '${req.query.email}'";
    expect(rawTextInterpolations(body)).toEqual(['req.query.email']);
    expect(SAFE_SHAPES.some((s) => s.test('req.query.email'))).toBe(false);
  });

  it('treats a placeholder index as parameterised, not as query text', () => {
    expect(rawTextInterpolations('SELECT * FROM users WHERE id = $${params.length}')).toEqual([]);
  });

  it('finds SQL inside a template that also holds a nested template', () => {
    const src = 'pool.query(`SELECT * FROM t ${cond ? `AND x = ${y}` : ``}`)';
    const bodies = templateLiterals(src).filter((t) => SQL_KEYWORD.test(t.body));
    expect(bodies).toHaveLength(1);
    expect(rawTextInterpolations(bodies[0]!.body)).toEqual(['cond ? `AND x = ${y}` : ``']);
  });

  it('is not fooled by a backtick inside a comment or a string', () => {
    const src = [
      '// a ` backtick in a comment',
      `const s = "a \` backtick in a string";`,
      'const q = `SELECT 1`;',
    ].join('\n');
    expect(templateLiterals(src).map((t) => t.body)).toEqual(['SELECT 1']);
  });

  /** The sweep proper. */
  it('interpolates nothing into SQL text that has not been reviewed', () => {
    const unreviewed = result.interpolations.filter(
      (i) => !SAFE_SHAPES.some((shape) => shape.test(i.expr)) && !(REVIEWED[i.file] ?? []).includes(i.expr),
    );
    expect(
      unreviewed.map((i) => `${i.file}:${i.line}  ${i.expr}`),
      'New SQL text interpolation. Confirm the expression cannot carry request data ' +
        '— values belong in $n placeholders — then add it to REVIEWED with a note.',
    ).toEqual([]);
  });

  /**
   * Kept honest in the other direction: a registry entry that no longer matches
   * anything is a claim nobody is checking, and it is how a list like this
   * drifts into fiction.
   */
  it('carries no stale registry entries', () => {
    // `\u0000` as the key separator, written as an escape and not as the byte
    // itself: a literal NUL in the source makes the whole file *binary* to
    // grep, which silently prints nothing rather than failing. In a repo whose
    // guarantees rest on source scans, a file no scan can read is the worst
    // possible one to hide, and this is the file that defines the scan.
    const live = new Set(result.interpolations.map((i) => `${i.file}\u0000${i.expr}`));
    const stale: string[] = [];
    for (const [file, exprs] of Object.entries(REVIEWED))
      for (const expr of exprs) if (!live.has(`${file}\u0000${expr}`)) stale.push(`${file}  ${expr}`);
    expect(stale).toEqual([]);
  });
});
