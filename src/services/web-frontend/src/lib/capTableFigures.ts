/**
 * What a cap-table class paid in, as every other reader of the same row
 * computes it.
 *
 * `invested_amount` is a column an administrator's export frequently does not
 * carry — a Carta sheet states a round price and leaves the amount blank — so
 * the platform has always derived it: a stated amount wins, and absent one it
 * is `price_per_share × shares`. Four server-side readers do this off the
 * shared `domain/capTable.investedAmount`: the waterfall inputs the engine is
 * fed, the preference stack `validateCapTable` totals, the cap-table graph, and
 * the Invested column of the auditor workbook.
 *
 * The Cap table *tab* did not. It rendered the raw column, so a preferred class
 * imported from such a sheet showed "—" while the workbook exported from the
 * very same table printed a figure, and while the Preference stack total on the
 * tab's own summary — computed from these entries, with the fallback — was a
 * number the visible rows did not add up to. The workbook's own comment says it
 * uses "the same fallback ... the Cap table tab uses", which is the shape of
 * this bug exactly: everyone believed the screen already agreed.
 *
 * A deliberate restatement, because the browser bundle cannot import the
 * valuation service. Held to `valuation/test/unit/capTableInvestedParity.test.ts`
 * through a fixture list both halves assert — the same arrangement as
 * [[csvColumns]] and for the same reason. If you add a case to one, add it to
 * the other.
 */

export interface InvestedEntry {
  class_type: string;
  shares: number;
  price_per_share: number | null;
  invested_amount: number | null;
}

function finiteOr(value: unknown, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/** `domain/capTable.ts`'s `investedAmount`, restated. Zero when neither column is usable. */
export function investedAmount(entry: InvestedEntry): number {
  const stated = Number(entry.invested_amount);
  if (entry.invested_amount !== null && Number.isFinite(stated)) return stated;
  const price = Number(entry.price_per_share);
  return entry.price_per_share !== null && Number.isFinite(price) ? price * finiteOr(entry.shares, 0) : 0;
}

/**
 * The figure the Invested column shows, per class.
 *
 * Preferred is where the two halves have to agree: it is the base of the
 * preference stack, it is what the workbook's Invested column prints, and it is
 * the only class the fallback applies to there — `export/valuationWorkbook.ts`'s
 * `preferredInvested`, on the stated reasoning that invested capital is a
 * preference-stack figure and founders' common issued at $0.0001 has not
 * "invested" its issue value.
 *
 * Every other class keeps showing whatever the file stated and nothing more.
 * The workbook blanks those by the rule above; this tab is the import preview,
 * where hiding a value the importer actually parsed would be its own bug — the
 * user is here to check what was read out of their file. So the screen is a
 * superset of the sheet rather than a different answer to the same cell: every
 * figure the sheet prints appears here identically.
 */
export function investedForDisplay(entry: InvestedEntry): number | null {
  if (entry.class_type === 'preferred') return investedAmount(entry) || null;
  return entry.invested_amount;
}
