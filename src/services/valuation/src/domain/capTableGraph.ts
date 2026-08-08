import { type CapTableEntry, type CapTableClassType } from './capTable.js';

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
 * Higher `seniority` pays first — that is the convention the waterfall engine
 * uses, and reversing it here would draw a picture that contradicts the
 * numbers underneath it. Classes with no stated seniority are pari passu and
 * sort together, after everything that stated one, by descending investment:
 * an unstated seniority is far more often "nobody filled this column in" than
 * "this class is genuinely last", and ordering the unknown ones by money at
 * least puts the largest cheque where an analyst will look at it.
 */
function stackOrder(entries: readonly CapTableEntry[]): CapTableEntry[] {
  return [...entries].sort((a, b) => {
    const as = a.seniority;
    const bs = b.seniority;
    if (as !== null && bs !== null && as !== bs) return bs - as;
    if (as !== null && bs === null) return -1;
    if (as === null && bs !== null) return 1;
    return (b.invested_amount ?? 0) - (a.invested_amount ?? 0);
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

  const fullyDiluted = input.entries.reduce((sum, e) => sum + (e.shares > 0 ? e.shares : 0), 0);
  const share = (n: number) => (fullyDiluted > 0 ? n / fullyDiluted : null);

  const companyId = nodeId('company', input.companyName, taken);
  nodes.push({
    id: companyId,
    kind: 'company',
    label: input.companyName,
    rank: 0,
    shares: fullyDiluted,
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
      ownership: share(entry.shares),
      class_type: entry.class_type,
      seniority: entry.seniority,
      liquidation_preference:
        entry.liquidation_multiple !== null && entry.invested_amount !== null
          ? entry.liquidation_multiple * entry.invested_amount
          : null,
      price_per_share: entry.price_per_share,
      invested_amount: entry.invested_amount,
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
      ownership: share(entry.shares),
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
