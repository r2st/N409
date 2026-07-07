/**
 * Multi-column sort state for list pages (M4). Serialized in the URL and the
 * API query as "column:asc,column:desc" — mirrors the valuation service's
 * whitelist in repos/valuations.ts.
 */

export const SORTABLE_COLUMNS = [
  'number',
  'company_name',
  'kind',
  'state',
  'paid_status',
  'created_at',
  'due_date',
  'published_at',
] as const;
export type SortableColumn = (typeof SORTABLE_COLUMNS)[number];

export interface SortSpec {
  column: SortableColumn;
  dir: 'asc' | 'desc';
}

export function parseSortParam(raw: string | null): SortSpec[] {
  if (!raw) return [];
  const specs: SortSpec[] = [];
  for (const part of raw.split(',')) {
    const [column, dir = 'asc'] = part.split(':');
    if (!(SORTABLE_COLUMNS as readonly string[]).includes(column ?? '')) continue;
    specs.push({ column: column as SortableColumn, dir: dir === 'desc' ? 'desc' : 'asc' });
  }
  return specs;
}

export function serializeSort(specs: SortSpec[]): string {
  return specs.map((s) => `${s.column}:${s.dir}`).join(',');
}

/**
 * Header-click behavior: first click sorts asc and makes the column primary,
 * second click flips to desc, third removes it. Other columns keep their
 * position as secondary sorts.
 */
export function toggleSort(specs: SortSpec[], column: SortableColumn): SortSpec[] {
  const existing = specs.find((s) => s.column === column);
  const rest = specs.filter((s) => s.column !== column);
  if (!existing) return [{ column, dir: 'asc' }, ...rest];
  if (existing.dir === 'asc') return [{ column, dir: 'desc' }, ...rest];
  return rest;
}

/** "↑2" style indicator data for a column, or null when unsorted. */
export function sortIndicator(
  specs: SortSpec[],
  column: SortableColumn,
): { dir: 'asc' | 'desc'; position: number } | null {
  const idx = specs.findIndex((s) => s.column === column);
  if (idx === -1) return null;
  return { dir: specs[idx]!.dir, position: idx + 1 };
}
