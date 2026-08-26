/**
 * How a sheet's header row becomes the keys of its data rows.
 *
 * One rule, in one place, because there are two readers of the same file
 * format family and they were not obeying it together. `parseCsvSheet`
 * (domain/capTable.ts) grew this handling; `gridToRows` (domain/xlsxRead.ts)
 * kept the naive `headers[i]` mapping, so the identical sheet imported as CSV
 * and as `.xlsx` produced different columns — and `.xlsx` is the default export
 * of every provider the importer exists to read.
 *
 * Two things real exports do that the naive mapping gets wrong:
 *
 *  - **Blank headers.** A trailing comma, or a spacer column between two
 *    blocks, produces an unnamed column. Keying them all on `''` meant the
 *    last such column silently overwrote the others, and `''` then appeared in
 *    the mapping UI as a selectable source. They are dropped instead.
 *  - **Duplicate headers.** Carta exports both a granted and an outstanding
 *    "Shares" column; a fund administrator's sheet repeats "Price". Last-wins
 *    meant the mapping silently read a column the operator did not pick, and
 *    the preview gave no hint which — the dropdown offered the name twice and
 *    both entries resolved to the same cells. Suffixing keeps every column
 *    reachable and visibly distinct.
 *
 * `null` marks a dropped column so the caller can keep header positions
 * aligned with row cells.
 */
export function nameColumns(cells: readonly string[]): Array<string | null> {
  const seen = new Map<string, number>();
  return cells.map((cell) => {
    const name = cell.trim();
    if (name === '') return null;
    const priorUses = seen.get(name) ?? 0;
    seen.set(name, priorUses + 1);
    return priorUses === 0 ? name : `${name} (${priorUses + 1})`;
  });
}

/** The named columns of a header row, in source order, blanks dropped. */
export function headerNames(cells: readonly string[]): string[] {
  return nameColumns(cells).filter((c): c is string => c !== null);
}

/** One data row keyed by the names `nameColumns` gave the header row. */
export function rowByColumn(
  columns: readonly (string | null)[],
  cells: readonly string[],
): Record<string, string> {
  const obj: Record<string, string> = {};
  columns.forEach((name, i) => {
    if (name !== null) obj[name] = (cells[i] ?? '').trim();
  });
  return obj;
}
