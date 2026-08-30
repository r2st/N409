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

/**
 * Every entry under each class-name key, in the order the table lists them.
 *
 * A `Map` built with `new Map(entries.map((e) => [key(e), e]))` keeps the
 * *last* entry under a repeated key and drops the rest, and a repeated key is
 * not a hypothetical here: `validateCapTable` raises `duplicate_class` as a
 * **warning**, so a table with "Series A" on two rows is valid, is stored, and
 * arrives at this diff intact. Providers produce the same shape by
 * construction — Pulley returns a flat `securities` list, one entry per
 * certificate, so a class held by two funds is two rows with one name.
 *
 * What the collapse cost is the whole point of this function. With
 * `Series A (100,000)` and `Series A (50,000)` on file and one `Series A
 * (100,000)` in the pull, the diff compared the pull against the *second* row
 * only and reported "shares 50,000 → 100,000" — while applying it deletes a
 * row holding 50,000 shares that nothing in the review ever mentioned. The
 * scheduled sync runs with `apply: true` and no person in the loop at all, and
 * `has_conflicts` was false outright whenever the pull happened to match the
 * last of the duplicates.
 */
function groupByKey(entries: readonly CapTableEntry[]): Map<string, CapTableEntry[]> {
  const groups = new Map<string, CapTableEntry[]>();
  for (const e of entries) {
    const k = key(e);
    const group = groups.get(k);
    if (group) group.push(e);
    else groups.set(k, [e]);
  }
  return groups;
}

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
 *
 * Rows sharing a class name are matched off against each other in the order
 * the two tables list them — the first "Series A" on file against the first
 * "Series A" in the pull, the second against the second — and whichever side
 * has more of them contributes the remainder as `added` or `removed`. The
 * pairing within a repeated name is arbitrary, because nothing in either table
 * says which certificate is which; what is not arbitrary is the count, and the
 * count is what decides whether applying the pull drops a holding. A duplicate
 * therefore shows up as a row of the review rather than as silence, which is
 * the outcome this cares about — the scheduled sync applies without anyone
 * reading the diff at all.
 *
 * `conflicts` may consequently name one class more than once. It always could,
 * for a pull that repeats a name, so any reader keying rows by class name was
 * already collapsing them.
 */
export function diffCapTables(existing: CapTableEntry[], incoming: CapTableEntry[]): CapTableDiff {
  const existingByKey = groupByKey(existing);
  const incomingByKey = groupByKey(incoming);
  const conflicts: ClassConflict[] = [];

  /** Which occurrence of a repeated name this is, as each side is walked. */
  const seenIncoming = new Map<string, number>();
  for (const inc of incoming) {
    const k = key(inc);
    const nth = seenIncoming.get(k) ?? 0;
    seenIncoming.set(k, nth + 1);
    const cur = existingByKey.get(k)?.[nth];
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

  const seenExisting = new Map<string, number>();
  for (const cur of existing) {
    const k = key(cur);
    const nth = seenExisting.get(k) ?? 0;
    seenExisting.set(k, nth + 1);
    if (incomingByKey.get(k)?.[nth] === undefined) {
      conflicts.push({ security_class: cur.security_class, status: 'removed', changes: [] });
    }
  }

  const added = conflicts.filter((c) => c.status === 'added').length;
  const removed = conflicts.filter((c) => c.status === 'removed').length;
  const changed = conflicts.filter((c) => c.status === 'changed').length;
  return { conflicts, has_conflicts: conflicts.length > 0, added, removed, changed };
}
