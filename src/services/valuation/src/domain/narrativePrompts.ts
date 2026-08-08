/**
 * Resolving the narrative prompt library (migration 0114) into the section
 * list one deliverable's narrative is drafted from. Pure — the repo owns the
 * rows, the AI route owns shipping the result, this owns which row wins.
 *
 * Two layers, and only two:
 *
 *   * base (`kind` NULL) — the sections any deliverable gets.
 *   * override (`kind` set) — replaces a base section with the same
 *     `section_key`, or adds one the base library does not have.
 *
 * A same-key override is a *replacement*, not a merge. Merging guidance
 * strings would produce a section that says both "the DLOM method chosen" and
 * "no marketability discount applies to this deliverable", which is how the
 * specialty reports came to read as a 409A with the title swapped.
 */

import type { ValuationKind } from './valuation.js';

/** The shape the repo returns; narrowed here to what resolution actually reads. */
export interface NarrativePromptLike {
  kind: ValuationKind | null;
  section_key: string;
  label: string;
  guidance: string;
  sort_order: number;
  enabled: boolean;
}

/** One drafted section, in the order the narrative presents it. */
export interface ResolvedSection {
  key: string;
  label: string;
  guidance: string;
  /** True when a kind-specific row displaced (or added to) the base library. */
  overridden: boolean;
}

/**
 * The sections `kind` is drafted with, in `sort_order` then `section_key`
 * order. Disabled rows are dropped — but a disabled *override* still suppresses
 * its base section, because "this deliverable has no DLOM discussion" is
 * exactly what turning the override off means. Falling back to the base row
 * there would make the toggle do nothing on the kinds that most need it.
 */
export function resolveNarrativeSections(
  rows: readonly NarrativePromptLike[],
  kind: ValuationKind,
): ResolvedSection[] {
  const base = new Map<string, NarrativePromptLike>();
  const overrides = new Map<string, NarrativePromptLike>();
  for (const row of rows) {
    if (row.kind === null) base.set(row.section_key, row);
    else if (row.kind === kind) overrides.set(row.section_key, row);
    // Rows belonging to some other kind are not this deliverable's business;
    // listNarrativePromptsForKind already filters them, but a caller passing
    // the whole library should get the same answer.
  }

  const winners: Array<{ row: NarrativePromptLike; overridden: boolean }> = [];
  for (const [key, row] of base) {
    const override = overrides.get(key);
    if (override) continue; // handled below, so an override keeps its own sort_order
    if (row.enabled) winners.push({ row, overridden: false });
  }
  for (const row of overrides.values()) {
    if (row.enabled) winners.push({ row, overridden: true });
  }

  winners.sort(
    (a, b) =>
      a.row.sort_order - b.row.sort_order || a.row.section_key.localeCompare(b.row.section_key),
  );
  return winners.map(({ row, overridden }) => ({
    key: row.section_key,
    label: row.label,
    guidance: row.guidance,
    overridden,
  }));
}

/**
 * The payload field the AI service reads. Null when the library resolves to
 * nothing — the agent then falls back to its built-in eight, which is the
 * right behaviour on a database that has not run 0114 rather than a report
 * with no prose in it.
 */
export function narrativeSectionsPayload(
  rows: readonly NarrativePromptLike[],
  kind: ValuationKind,
): Array<{ key: string; label: string; guidance: string }> | null {
  const sections = resolveNarrativeSections(rows, kind);
  if (sections.length === 0) return null;
  return sections.map(({ key, label, guidance }) => ({ key, label, guidance }));
}
