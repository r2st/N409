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
 * The suffix has to avoid the names already in the row as well as the ones it
 * has already minted, which counting uses of each name alone does not do. A
 * sheet carrying `Shares (2)`, `Shares`, `Shares` — the shape left behind when
 * somebody has already disambiguated one pair of columns by hand, or when a
 * previous export of this same file is re-exported — named its third column
 * `Shares (2)` as well, and `rowByColumn` then wrote one over the other. That is
 * the identical last-wins loss this suffixing exists to prevent, reintroduced by
 * the repair: the first column's numbers became unreachable, no error was
 * raised, and the mapping UI again listed one name for two columns.
 *
 * So a candidate that is already spoken for moves on to the next number, and
 * every name this returns is unique by construction.
 *
 * `null` marks a dropped column so the caller can keep header positions
 * aligned with row cells.
 */
export function nameColumns(cells: readonly string[]): Array<string | null> {
  const uses = new Map<string, number>();
  const taken = new Set<string>();
  return cells.map((cell) => {
    const name = cell.trim();
    if (name === '') return null;
    let n = (uses.get(name) ?? 0) + 1;
    let candidate = n === 1 ? name : `${name} (${n})`;
    while (taken.has(candidate)) candidate = `${name} (${++n})`;
    uses.set(name, n);
    taken.add(candidate);
    return candidate;
  });
}

/**
 * One data row keyed by the names `nameColumns` gave the header row.
 *
 * `defineProperty` rather than `obj[name] = …` because the names come out of
 * an uploaded file and one of them is not an ordinary key. `obj.__proto__ = 'x'`
 * does not create a property at all — it runs the accessor `Object.prototype`
 * puts on every object, which ignores a string — so a column headed
 * `__proto__` was silently dropped: no error, no key in the row, and the whole
 * column of numbers gone from an import that reported success. Worse, the row
 * then answered `'__proto__' in row` with `true`, so `readCell` handed
 * `Object.prototype` back as if it were a cell.
 *
 * The unlikeliness of that header is not the argument for leaving it: the cost
 * of getting it right is one call, and the cost of getting it wrong is an
 * import that loses a column without saying so.
 */
export function rowByColumn(
  columns: readonly (string | null)[],
  cells: readonly string[],
): Record<string, string> {
  const obj: Record<string, string> = {};
  columns.forEach((name, i) => {
    if (name === null) return;
    Object.defineProperty(obj, name, {
      value: (cells[i] ?? '').trim(),
      writable: true,
      enumerable: true,
      configurable: true,
    });
  });
  return obj;
}
