/**
 * Cap-table sync reconciliation (feature 4): compares the cap table currently
 * on file (a manual entry or a prior sync) against a fresh provider pull and
 * reports the differences, so an analyst can review before the API data
 * overwrites hand-entered figures. Pure functions — the route decides whether
 * to apply.
 */

import type { CapTableEntry } from './capTable.js';

/** A per-field difference on a matched security class. */
export interface FieldChange {
  field: keyof CapTableEntry;
  from: number | string | null;
  to: number | string | null;
}

export interface ClassConflict {
  security_class: string;
  status: 'changed' | 'added' | 'removed';
  changes: FieldChange[];
}

export interface CapTableDiff {
  /** Classes whose fields differ, plus classes only in one side. */
  conflicts: ClassConflict[];
  has_conflicts: boolean;
  added: number;
  removed: number;
  changed: number;
}

const NUMERIC_FIELDS: Array<keyof CapTableEntry> = [
  'shares',
  'price_per_share',
  'invested_amount',
  'liquidation_multiple',
  'seniority',
  'conversion_ratio',
];

const key = (e: CapTableEntry) => e.security_class.trim().toLowerCase();

/** True when two numeric (or null) values differ beyond rounding. */
function numDiffers(a: number | null, b: number | null): boolean {
  if (a === null && b === null) return false;
  if (a === null || b === null) return true;
  return Math.abs(a - b) > 1e-6;
}

/**
 * Diff the on-file cap table (`existing`) against an incoming provider pull.
 * A class present in both with differing fields is a `changed` conflict; a
 * class only in the pull is `added`; a class only on file is `removed`.
 */
export function diffCapTables(existing: CapTableEntry[], incoming: CapTableEntry[]): CapTableDiff {
  const existingByKey = new Map(existing.map((e) => [key(e), e]));
  const incomingByKey = new Map(incoming.map((e) => [key(e), e]));
  const conflicts: ClassConflict[] = [];

  for (const inc of incoming) {
    const cur = existingByKey.get(key(inc));
    if (!cur) {
      conflicts.push({ security_class: inc.security_class, status: 'added', changes: [] });
      continue;
    }
    const changes: FieldChange[] = [];
    if (cur.class_type !== inc.class_type) {
      changes.push({ field: 'class_type', from: cur.class_type, to: inc.class_type });
    }
    for (const f of NUMERIC_FIELDS) {
      if (numDiffers(cur[f] as number | null, inc[f] as number | null)) {
        changes.push({ field: f, from: cur[f] as number | null, to: inc[f] as number | null });
      }
    }
    if (changes.length > 0) {
      conflicts.push({ security_class: inc.security_class, status: 'changed', changes });
    }
  }

  for (const cur of existing) {
    if (!incomingByKey.has(key(cur))) {
      conflicts.push({ security_class: cur.security_class, status: 'removed', changes: [] });
    }
  }

  const added = conflicts.filter((c) => c.status === 'added').length;
  const removed = conflicts.filter((c) => c.status === 'removed').length;
  const changed = conflicts.filter((c) => c.status === 'changed').length;
  return { conflicts, has_conflicts: conflicts.length > 0, added, removed, changed };
}
