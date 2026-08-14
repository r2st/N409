import {
  asConvertedShares,
  investedAmount,
  liquidationPreference,
  type CapTableEntry,
  type CapTableClassType,
} from './capTable.js';

/**
 * The cap table as a graph — what converts into what, and what sits in front
 * of what in a liquidation (409.ai's visNetwork explorer).
 *
 * A cap table is presented everywhere as a table, and a table is the wrong
 * shape for the two questions that actually decide an allocation:
 *
 *   * conversion — a preferred class does not receive its own proceeds, it
 *     receives the better of its preference and what it converts into, and
 *     the conversion ratio deciding that is one column among eight; and
 *   * seniority — the preference stack pays in order, and a table sorted by
 *     name shows an operator "Series A, Series B, Series Seed" while the money
 *     goes B, A, Seed.
 *
 * Both are relationships between rows, which is the one thing a table renders
 * badly. Drawn as ranked columns they are the picture: proceeds flow left to
 * right through the stack and everything converts down into common.
 *
 * Pure: takes the stored entries and history rows, returns nodes and edges
 * with a rank per node. Layout coordinates are the frontend's business — this
 * decides what is connected to what and in what order, which is domain
 * knowledge, and leaves pixels to whatever is drawing them.
 */

export type CapTableNodeKind = 'company' | 'share_class' | 'option_pool' | 'warrant' | 'funding_round';

export interface CapTableGraphNode {
  id: string;
  kind: CapTableNodeKind;
  label: string;
  /**
   * Column the node is drawn in. 0 is the company; the preference stack
   * occupies 1..n in payment order; common and the derivative securities that
   * convert into it are last. Nodes sharing a rank are drawn side by side.
   */
  rank: number;
  shares: number;
  /**
   * The same holding on the basis `ownership` is struck on — `shares` for
   * everything that is already in common-equivalent units, and
   * `shares x conversion_ratio` for a preferred class that is not.
   *
   * Carried rather than left to the reader to multiply out, because `shares`
   * and `ownership` are quoted on different bases the moment a class converts
   * at other than 1:1, and a node showing "4,000,000 sh" beside "44.4%" gives
   * a reader no way to tell that the percentage was struck on 8,000,000. The
   * ratio alone is not enough: it says the two *can* differ, not which of them
   * the denominator used, and re-deriving the rule frontend-side is how the
   * ownership figure came to disagree with the engine in the first place.
   *
   * Null on the company node and on a funding round, which hold no class.
   */
  as_converted_shares: number | null;
  /** Fully-diluted share of the company, 0–1. Null when nothing is outstanding. */
  ownership: number | null;
  class_type: CapTableClassType | null;
  /** Where this class sits in the stack; null for common and for the pool. */
  seniority: number | null;
  liquidation_preference: number | null;
  price_per_share: number | null;
  invested_amount: number | null;
  conversion_ratio: number | null;
}

export type CapTableEdgeKind = 'issued' | 'converts_to' | 'senior_to' | 'funded';

export interface CapTableGraphEdge {
  from: string;
  to: string;
  kind: CapTableEdgeKind;
  label: string;
}

export interface CapTableGraph {
  nodes: CapTableGraphNode[];
  edges: CapTableGraphEdge[];
  /** Problems the drawing itself reveals — see `graphIssues`. */
  issues: Array<{ severity: 'error' | 'warning'; code: string; message: string }>;
}

/** Slugged, prefixed and deduplicated: class names are user text. */
function nodeId(prefix: string, name: string, taken: Set<string>): string {
  const base = `${prefix}:${
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'x'
  }`;
  let id = base;
  let n = 2;
  while (taken.has(id)) id = `${base}-${n++}`;
  taken.add(id);
  return id;
}

function kindOf(entry: CapTableEntry): CapTableNodeKind {
  if (entry.class_type === 'option') return 'option_pool';
  if (entry.class_type === 'warrant') return 'warrant';
  return 'share_class';
}

/**
 * Sort the preference stack into payment order.
 *
 * Seniority 1 is the most senior and pays first. That is the engine's rule —
 * `waterfall.py` walks `sorted({c["seniority"] …})` ascending under the comment
 * "1 = most senior" — and it is what the importer tells the operator in the
 * `bad_seniority` message and what Exhibit A prints under the column.
 *
 * This sorted descending, so the explorer drew the stack backwards: with Seed
 * at 1, A at 2 and B at 3, the picture put Series B in the first column and
 * Series Seed in the last, while the money goes Seed, A, B. Reading the stack
 * off the diagram gave exactly the reverse of what a liquidation would do, on
 * the one screen built to make payment order legible — and the docstring
 * asserting the opposite convention is presumably how it survived review.
 *
 * Classes with no stated seniority are pari passu and sort together, after
 * everything that stated one, by descending investment: an unstated seniority
 * is far more often "nobody filled this column in" than "this class is
 * genuinely last", and ordering the unknown ones by money at least puts the
 * largest cheque where an analyst will look at it. `graphIssues` raises
 * `partial_seniority` when a table mixes the two, because that guess is one the
 * reader should know is being made.
 */
function stackOrder(entries: readonly CapTableEntry[]): CapTableEntry[] {
  return [...entries].sort((a, b) => {
    const as = a.seniority;
    const bs = b.seniority;
    if (as !== null && bs !== null && as !== bs) return as - bs;
    if (as !== null && bs === null) return -1;
    if (as === null && bs !== null) return 1;
    // The cheque as the engine reads it, price fallback included — the raw
    // column is blank on the export that most often omits a seniority too, so
    // ordering on it put every priced-only class last regardless of size.
    return investedAmount(b) - investedAmount(a);
  });
}

export interface GraphInput {
  companyName: string;
  entries: readonly CapTableEntry[];
  rounds?: ReadonlyArray<{
    id: string;
    name: string;
    /**
     * A `date` column, which the pg driver hands back as a Date however the
     * row type declares it — see the same note on FundMarkRow. Accepting both
     * here rather than at the call site, because every caller reads it from
     * the driver.
     */
    closed_on: string | Date | null;
    shares_issued: string | number | null;
  }>;
}

/** ISO day from whatever the driver produced, or '' when there is no date. */
function isoDay(value: string | Date | null | undefined): string {
  if (!value) return '';
  return value instanceof Date ? value.toISOString().slice(0, 10) : value.slice(0, 10);
}

export function buildCapTableGraph(input: GraphInput): CapTableGraph {
  const taken = new Set<string>();
  const nodes: CapTableGraphNode[] = [];
  const edges: CapTableGraphEdge[] = [];

  /*
   * As-converted, like every other fully-diluted figure on the platform.
   *
   * This was the raw share sum, which put the graph at odds with itself: the
   * conversion edges below are labelled from the same `conversion_ratio` — a
   * class converting 2:1 is drawn saying so — while the ownership percentage on
   * the node it points at was computed as though it converted 1:1. Whichever of
   * the two a reader believed, the picture disagreed with the workbook and with
   * the engine's denominator.
   *
   * Non-positive share counts stay out of the total, as before: they are refused
   * upstream (`bad_shares`), and a negative in a denominator is not a smaller
   * company.
   */
  const converted = (e: CapTableEntry) => Math.max(0, asConvertedShares(e));
  const fullyDiluted = input.entries.reduce((sum, e) => sum + converted(e), 0);
  const share = (n: number) => (fullyDiluted > 0 ? n / fullyDiluted : null);

  const companyId = nodeId('company', input.companyName, taken);
  nodes.push({
    id: companyId,
    kind: 'company',
    label: input.companyName,
    rank: 0,
    shares: fullyDiluted,
    // Already the as-converted total — it is the denominator `share` divides by.
    as_converted_shares: null,
    ownership: fullyDiluted > 0 ? 1 : null,
    class_type: null,
    seniority: null,
    liquidation_preference: null,
    price_per_share: null,
    invested_amount: null,
    conversion_ratio: null,
  });

  const preferred = stackOrder(input.entries.filter((e) => e.class_type === 'preferred'));
  const others = input.entries.filter((e) => e.class_type !== 'preferred');

  // The stack occupies ranks 1..n in payment order; everything junior to it
  // shares the last rank.
  const commonRank = preferred.length + 1;
  const idFor = new Map<CapTableEntry, string>();

  preferred.forEach((entry, i) => {
    const id = nodeId('class', entry.security_class, taken);
    idFor.set(entry, id);
    nodes.push({
      id,
      kind: 'share_class',
      label: entry.security_class,
      rank: i + 1,
      shares: entry.shares,
      as_converted_shares: converted(entry),
      ownership: share(converted(entry)),
      class_type: entry.class_type,
      seniority: entry.seniority,
      /*
       * The figure the engine will actually pay this class ahead of common,
       * defaults included — not the product of two raw columns.
       *
       * Requiring both to be stated drew nothing on the ordinary case. A Carta
       * export carries the round price and leaves "Amount Invested" blank, and
       * a sheet that states a 1× preference usually states it by omission; the
       * engine fills both gaps (`toWaterfallInputs`), so the waterfall paid a
       * class the picture of the preference stack drew as holding no
       * preference at all.
       *
       * Null still means null — a class with neither an amount nor a price has
       * no preference to draw, which is the `no_investment` warning's case and
       * is worth showing as absent rather than as zero.
       */
      liquidation_preference: liquidationPreference(entry) || null,
      price_per_share: entry.price_per_share,
      // The same fallback, so the node's two money figures cannot disagree
      // about whether this class put anything in.
      invested_amount: investedAmount(entry) || null,
      conversion_ratio: entry.conversion_ratio,
    });
    edges.push({ from: companyId, to: id, kind: 'issued', label: 'issued' });
  });

  // Seniority edges chain consecutive ranks rather than joining every pair:
  // n² arrows between eight classes is a picture nobody can read, and the
  // chain carries the same ordering.
  for (let i = 0; i + 1 < preferred.length; i++) {
    const from = idFor.get(preferred[i]!)!;
    const to = idFor.get(preferred[i + 1]!)!;
    edges.push({ from, to, kind: 'senior_to', label: 'senior to' });
  }

  const commonEntries = others.filter((e) => e.class_type === 'common');
  const commonIds: string[] = [];
  for (const entry of others) {
    const id = nodeId('class', entry.security_class, taken);
    idFor.set(entry, id);
    nodes.push({
      id,
      kind: kindOf(entry),
      label: entry.security_class,
      rank: commonRank,
      shares: entry.shares,
      as_converted_shares: converted(entry),
      ownership: share(converted(entry)),
      class_type: entry.class_type,
      seniority: entry.seniority,
      liquidation_preference: null,
      price_per_share: entry.price_per_share,
      invested_amount: entry.invested_amount,
      conversion_ratio: entry.conversion_ratio,
    });
    edges.push({ from: companyId, to: id, kind: 'issued', label: 'issued' });
    if (entry.class_type === 'common') commonIds.push(id);
  }

  // Conversion: every preferred class, and every option and warrant, becomes
  // common. Drawn to the first common class when there is exactly one —
  // multiple common classes (founder vs. restricted, or a dual-class charter)
  // make the target genuinely ambiguous, and an arrow drawn to a guess is
  // worse than no arrow, so those are reported as an issue instead.
  const commonTarget = commonIds.length === 1 ? commonIds[0]! : null;
  if (commonTarget) {
    for (const entry of [...preferred, ...others]) {
      if (entry.class_type === 'common') continue;
      const from = idFor.get(entry)!;
      const ratio = entry.conversion_ratio;
      edges.push({
        from,
        to: commonTarget,
        kind: 'converts_to',
        label:
          entry.class_type === 'preferred'
            ? `converts ${ratio !== null && ratio !== 1 ? `${ratio}:1` : '1:1'}`
            : 'exercises into',
      });
    }
  }

  // Rounds are history, not structure: they hang off the company at rank 0
  // and connect to nothing else, because the stored rounds carry no link to
  // the class they bought. Inferring one from a name match ("Series A" the
  // round, "Series A Preferred" the class) is a guess, and a guess drawn as a
  // solid arrow reads as a fact.
  for (const round of input.rounds ?? []) {
    const id = nodeId('round', round.name, taken);
    const closed = isoDay(round.closed_on);
    nodes.push({
      id,
      kind: 'funding_round',
      label: closed ? `${round.name} (${closed})` : round.name,
      rank: 0,
      shares: Number(round.shares_issued ?? 0) || 0,
      as_converted_shares: null,
      ownership: null,
      class_type: null,
      seniority: null,
      liquidation_preference: null,
      price_per_share: null,
      invested_amount: null,
      conversion_ratio: null,
    });
    edges.push({ from: id, to: companyId, kind: 'funded', label: 'funded' });
  }

  return { nodes, edges, issues: graphIssues(input.entries, commonEntries.length) };
}

/**
 * The problems only the graph can see.
 *
 * `validateCapTable` already checks each row in isolation — negative shares, a
 * preference with no investment. What it cannot check is the shape of the
 * whole: a preference stack where half the classes state a seniority and half
 * do not is not an invalid row anywhere, and it is the single most common
 * reason a waterfall pays out in an order the analyst did not intend.
 */
export function graphIssues(
  entries: readonly CapTableEntry[],
  commonClassCount: number,
): CapTableGraph['issues'] {
  const issues: CapTableGraph['issues'] = [];
  const preferred = entries.filter((e) => e.class_type === 'preferred');

  if (preferred.length > 1) {
    const stated = preferred.filter((e) => e.seniority !== null).length;
    if (stated > 0 && stated < preferred.length) {
      issues.push({
        severity: 'warning',
        code: 'partial_seniority',
        message:
          `${stated} of ${preferred.length} preferred classes state a seniority. The rest are treated ` +
          'as pari passu behind them, which may not be what the charter says.',
      });
    }
    const seniorities = preferred.map((e) => e.seniority).filter((s): s is number => s !== null);
    if (new Set(seniorities).size < seniorities.length) {
      issues.push({
        severity: 'warning',
        code: 'duplicate_seniority',
        message:
          'Two or more preferred classes share a seniority rank. They will be paid pari passu — ' +
          'correct for a pari passu stack, and a data error otherwise.',
      });
    }
  }

  if (commonClassCount === 0 && entries.length > 0) {
    issues.push({
      severity: 'error',
      code: 'no_common',
      message:
        'No common class. Nothing has anywhere to convert into, and there is no security for the ' +
        'opinion to be about.',
    });
  }
  if (commonClassCount > 1) {
    issues.push({
      severity: 'warning',
      code: 'multiple_common',
      message:
        `${commonClassCount} common classes. Conversion targets are ambiguous, so no conversion ` +
        'arrows are drawn — confirm which class the preferred converts into.',
    });
  }

  for (const entry of preferred) {
    if (entry.conversion_ratio !== null && entry.conversion_ratio <= 0) {
      issues.push({
        severity: 'error',
        code: 'bad_conversion_ratio',
        message: `${entry.security_class} has a conversion ratio of ${entry.conversion_ratio}, which converts into nothing.`,
      });
    }
  }

  return issues;
}
