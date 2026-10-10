/**
 * Which DDL a forward-only migration set is allowed to contain.
 *
 * The runner in `migrate.ts` is forward-only and checksummed, and those two
 * properties together are stronger than they look: an applied migration can
 * never be edited (drift is refused at boot) and there is no down-step to run.
 * So the schema only ever moves in one direction, and the *only* way back from
 * a bad migration is a hand-written repair applied to every environment.
 *
 * That is a deliberate design, and it is a good one — down-migrations are
 * written far more often than they are run, and a down-migration that has never
 * been executed is a guess. But it has a precondition nothing was enforcing:
 * every migration has to be additive.
 *
 * Two things depend on that precondition, and both are invisible until they
 * break:
 *
 *  1. **The rolling restart.** `deploy.sh` restarts valuation first and waits
 *     for it, then restarts the other four. valuation runs the migrations on
 *     boot, so for the length of that wait — and for as long as any in-flight
 *     request on another unit is still running — the *new* schema is being read
 *     by the *previous* release's code. A dropped or retyped column is a
 *     production error inside that window, on a deploy that reports success.
 *
 *  2. **Rolling the code back.** `infra/deploy.sh --rollback` redeploys the
 *     previous commit, and it deliberately does not touch the schema, because
 *     there is nothing to touch it with. That is only safe while the new schema
 *     is a superset of the old one — which is exactly what "additive" means. A
 *     migration that drops a column turns the rollback path, the one procedure
 *     reached for when production is already broken, into a second outage.
 *
 * So the rule is not "no DROP". Dropping a CHECK constraint to widen it is the
 * single most common shape in this directory (25 of them) and is additive in
 * the sense that matters: old code keeps working, because a constraint it never
 * violated is now looser. What is refused is the destruction of *data* and the
 * change of a column's shape out from under a reader.
 *
 * Findings are returned rather than thrown, matching `systemdResources.ts` and
 * `systemdShutdown.ts`: the caller sweeps the whole directory and should report
 * every migration at fault, not the first.
 */

/**
 * Strips SQL comments and string literals before scanning.
 *
 * Load-bearing, not hygiene. Two migrations in this directory discuss renaming
 * in prose — 0122 explains that a slug "must not change because an account was
 * renamed", and 0145 names a test about a renamed chapter. A scanner that reads
 * its own commentary as DDL reports both as destructive, and the fix a reader
 * would reach for is to delete the explanation. The rule has to be about what
 * Postgres executes.
 *
 * String literals go for the same reason one step removed: a seeded prompt or a
 * help article can quite legitimately contain the words "drop column".
 */
export function strippedSql(sql: string): string {
  return (
    sql
      // Block comments first: a `--` inside one is not a line comment.
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/--[^\n]*/g, ' ')
      // Dollar-quoted bodies ($$ ... $$ and $tag$ ... $tag$) — function bodies
      // and long seeded text, which is where prose most often lives.
      .replace(/\$([A-Za-z_]\w*)?\$[\s\S]*?\$\1?\$/g, " '' ")
      .replace(/'(?:[^']|'')*'/g, " '' ")
  );
}

export interface MigrationFinding {
  /** A short, stable key for the rule that fired. */
  rule: string;
  /** What was found, and why the forward-only runner makes it unrecoverable. */
  message: string;
  /** The matched DDL, normalised to one line, for the failure output. */
  excerpt: string;
}

interface Rule {
  key: string;
  pattern: RegExp;
  explain: (excerpt: string) => string;
}

const RULES: Rule[] = [
  {
    key: 'drop-table',
    // `DROP TABLE` only — not DROP INDEX/CONSTRAINT/TRIGGER/POLICY/FUNCTION,
    // each of which is re-creatable from this repository and holds no rows.
    pattern: /\bDROP\s+TABLE\b/gi,
    explain: () =>
      'drops a table, destroying its rows. The runner is forward-only, so there is no down-step to ' +
      'restore them and no backup taken at this point in the deploy — the data is gone on every ' +
      'environment the file reaches. Retire the table in code first and remove it in a later release, ' +
      'once nothing reads it.',
  },
  {
    key: 'drop-column',
    // `DROP NOT NULL` and `DROP DEFAULT` are ALTER COLUMN sub-actions and are
    // both relaxations; only the column itself is refused here.
    pattern: /\bDROP\s+COLUMN\b/gi,
    explain: () =>
      'drops a column, destroying its values and breaking every reader that still selects it — ' +
      'including the previous release, which is still serving on the other four units while valuation ' +
      'migrates, and which is what `deploy.sh --rollback` puts back. Stop writing the column, ship ' +
      'that, and drop it in a later release.',
  },
  {
    key: 'change-column-type',
    pattern: /\bALTER\s+(?:COLUMN\s+)?"?\w+"?\s+(?:SET\s+DATA\s+)?TYPE\b/gi,
    explain: () =>
      "changes a column's type in place. Postgres rewrites the table under an ACCESS EXCLUSIVE lock, " +
      'and any value that does not cast fails the migration mid-deploy; the previous release then ' +
      'reads a column whose shape it does not expect. Add a new column, backfill it, and switch ' +
      'readers over across two releases.',
  },
  {
    key: 'rename',
    pattern: /\bRENAME\s+(?:COLUMN\s+|CONSTRAINT\s+|TO\b)/gi,
    explain: () =>
      'renames a column or table. Nothing is destroyed, but the old name disappears atomically, so ' +
      'the previous release — still serving during the rolling restart, and restored by ' +
      '`deploy.sh --rollback` — queries a name that no longer exists. Add the new name alongside the ' +
      'old one and retire the old one in a later release.',
  },
  {
    key: 'not-null-without-default',
    // Two separate risks in one shape: on a non-empty table the statement fails
    // outright, and on a large one it holds a lock for the length of a rewrite.
    pattern: /\bADD\s+COLUMN\b(?:\s+IF\s+NOT\s+EXISTS)?\s+[^;,()]*?\bNOT\s+NULL\b(?![^;,]*\bDEFAULT\b)/gi,
    explain: () =>
      'adds a NOT NULL column with no DEFAULT. On any table that already has rows the statement fails ' +
      'and the migration aborts — but only on environments whose table is non-empty, so it passes in ' +
      'CI against an empty database and fails in production. Give it a DEFAULT, or add it nullable, ' +
      'backfill, and set NOT NULL in a later release. All 31 such columns here already carry one.',
  },
];

/** Every rule the given migration breaks. */
export function destructiveFindings(sql: string): MigrationFinding[] {
  const scannable = strippedSql(sql);
  const findings: MigrationFinding[] = [];
  for (const rule of RULES) {
    // Fresh lastIndex per call: these are module-level /g regexes and would
    // otherwise resume mid-string on the second file scanned, silently skipping
    // matches in a way that gets *more* wrong the more migrations exist.
    rule.pattern.lastIndex = 0;
    for (const match of scannable.matchAll(rule.pattern)) {
      const start = Math.max(0, match.index - 60);
      const excerpt = scannable
        .slice(start, match.index + match[0].length + 60)
        .replace(/\s+/g, ' ')
        .trim();
      findings.push({ rule: rule.key, message: rule.explain(excerpt), excerpt });
    }
  }
  return findings;
}

/** The rule keys, for a test that wants to assert the set is complete. */
export const MIGRATION_SAFETY_RULES = RULES.map((r) => r.key);
