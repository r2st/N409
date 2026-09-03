import { readFileSync } from 'node:fs';
import path from 'node:path';
import { sourceFiles } from './sourceFiles.js';

/**
 * The tables this service deletes rows from, mapped to where it does it.
 *
 * Almost nothing here is hard-deleted — engagements are archived, users are
 * anonymised, the ledgers are append-only — and several guarantees rest on
 * that without saying so. `foreignKeyIndexCensus` needs it to justify leaving
 * 85 foreign keys unindexed; `orphanPrevention` needs it to justify the
 * polymorphic reference columns that no constraint can cover. Both are asking
 * the same question, so both ask it of the same scan.
 *
 * Literal `DELETE FROM <table>` finds every caller but one.
 * `runHousekeepingSweep` interpolates `${target.table}` from
 * `HOUSEKEEPING_TARGETS`, so those five names are read from that list instead —
 * a census blind to them would report five fewer deleted tables than there are
 * and pass by not looking, which is the failure shape these sweeps exist to
 * avoid.
 *
 * COMMENTS ARE STRIPPED FIRST (round 395, methodology M3). The scan matched the
 * whole file, and this codebase's prose is full of sentences about statements
 * it deliberately does not issue. R366's note on `retiredEngagement.ts` — "there
 * is no endpoint that removes one, and `DELETE FROM valuations` is refused" —
 * therefore registered `valuations` as a hard-deleted table, and
 * `foreignKeyIndexCensus` has failed on eight invented crossings ever since:
 * a census red for a reason that is not about the schema is one nobody can read
 * a real crossing out of. A comment saying a table is never deleted from is the
 * exact opposite of the evidence this function is looking for.
 */

/**
 * The file with its comments removed, so prose about a statement is not read as
 * the statement.
 *
 * Block comments and whole-line `//` comments; a trailing `//` is left alone
 * unless it is the first thing on the line, because the only `//` that appears
 * mid-line in this tree is the one in a URL.
 */
function code(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .filter((line) => !/^\s*\/\//.test(line))
    .join('\n');
}

export function hardDeletedTables(srcRoot: string): Map<string, Set<string>> {
  const found = new Map<string, Set<string>>();
  const note = (table: string, where: string): void => {
    const at = found.get(table) ?? new Set<string>();
    at.add(where);
    found.set(table, at);
  };

  for (const file of sourceFiles(srcRoot)) {
    const rel = path.relative(srcRoot, file);
    for (const m of code(readFileSync(file, 'utf8')).matchAll(/DELETE\s+FROM\s+([a-z_][a-z0-9_]*)/gi)) {
      note(m[1]!.toLowerCase(), rel);
    }
  }

  const housekeeping = readFileSync(path.join(srcRoot, 'domain/housekeeping.ts'), 'utf8');
  const targets = housekeeping.slice(housekeeping.indexOf('HOUSEKEEPING_TARGETS'));
  for (const m of targets.matchAll(/table:\s*'([a-z_]+)'/g)) {
    note(m[1]!, 'domain/housekeeping.ts (sweep)');
  }
  return found;
}
