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
 */
export function hardDeletedTables(srcRoot: string): Map<string, Set<string>> {
  const found = new Map<string, Set<string>>();
  const note = (table: string, where: string): void => {
    const at = found.get(table) ?? new Set<string>();
    at.add(where);
    found.set(table, at);
  };

  for (const file of sourceFiles(srcRoot)) {
    const rel = path.relative(srcRoot, file);
    for (const m of readFileSync(file, 'utf8').matchAll(/DELETE\s+FROM\s+([a-z_][a-z0-9_]*)/gi)) {
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
