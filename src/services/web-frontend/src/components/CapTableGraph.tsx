import { useMemo, useState } from 'react';

/**
 * The cap table drawn as a dependency graph (409.ai's visNetwork explorer).
 *
 * Hand-rolled SVG rather than a graph library. The layout is not a
 * force-directed problem — the server already decided the one thing that
 * matters, which is each node's rank, and a physics simulation would take that
 * ordering and shuffle it into whatever looked balanced. Ranks map to columns
 * and that is the whole layout; the rest is a few hundred bytes of geometry
 * against a dependency that would be two orders of magnitude larger.
 *
 * Left to right is payment order: the most senior class first, then down the
 * stack, then common and the securities that convert into it.
 */

export interface GraphNode {
  id: string;
  kind: 'company' | 'share_class' | 'option_pool' | 'warrant' | 'funding_round';
  label: string;
  rank: number;
  shares: number;
  /** The holding on the basis `ownership` is struck on; null on non-class nodes. */
  as_converted_shares: number | null;
  ownership: number | null;
  class_type: string | null;
  seniority: number | null;
  liquidation_preference: number | null;
  price_per_share: number | null;
  invested_amount: number | null;
  conversion_ratio: number | null;
}

/**
 * Whether this node's two share figures actually differ.
 *
 * `ownership` is struck on the as-converted count, `shares` is the outstanding
 * one, and for everything that converts 1:1 — which is every common class,
 * every option pool, and most preferred — they are the same number and saying
 * so twice is noise. It is only the class converting at other than 1:1 that
 * needs both, and then it needs both: outstanding alone cannot be reconciled
 * to the percentage printed beside it.
 *
 * Read off the server's own figures rather than off `conversion_ratio`, so the
 * rule for which kinds convert stays in one place — `capTable.ts`'s
 * `asConvertedShares`, which the engine's denominator also comes from.
 *
 * `!= null` rather than `!== null`, and it is load-bearing. The field arrived
 * with the fix that added it; a payload serialised before that one — a cached
 * response, a partner client pinned to an older contract — has no key there at
 * all. `undefined !== null` is true, so the strict form called a node
 * *converting* precisely when it had no as-converted figure to draw, and the
 * non-null assertion below then handed `undefined` to `toLocaleString`. That
 * throws during render, which React does not contain: the exception unwinds
 * past the tab and the whole Cap table page renders as an empty div. A
 * component whose contract says `number | null` should treat an absent value
 * as the absence it is, and draw the outstanding count — which is the same
 * thing it draws for every class that converts 1:1.
 */
function converts(node: GraphNode): boolean {
  return node.as_converted_shares != null && node.as_converted_shares !== node.shares;
}

export interface GraphEdge {
  from: string;
  to: string;
  kind: 'issued' | 'converts_to' | 'senior_to' | 'funded';
  label: string;
}

export interface CapTableGraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
  issues: Array<{ severity: 'error' | 'warning'; code: string; message: string }>;
}

const NODE_W = 168;
const NODE_H = 62;
const COL_GAP = 92;
const ROW_GAP = 22;
const PAD = 24;

const NODE_FILL: Record<GraphNode['kind'], string> = {
  company: 'var(--color-ink-900, #1b1d21)',
  share_class: 'var(--color-surface, #fff)',
  option_pool: 'var(--color-surface, #fff)',
  warrant: 'var(--color-surface, #fff)',
  funding_round: 'var(--color-paper-200, #eee9e1)',
};

const NODE_STROKE: Record<GraphNode['kind'], string> = {
  company: 'var(--color-ink-900, #1b1d21)',
  share_class: 'var(--color-bond-500, #3d6cb9)',
  option_pool: 'var(--color-brass-500, #a5762c)',
  warrant: 'var(--color-brass-500, #a5762c)',
  funding_round: 'var(--color-ink-300, #b9b3a8)',
};

/**
 * Edge styling carries the semantics: a solid arrow is a structural fact
 * (this class exists, issued by the company), a dashed one is a conditional
 * (it converts, if converting beats taking the preference), and the seniority
 * chain is drawn thin because it is an ordering rather than a flow.
 */
const EDGE_STYLE: Record<GraphEdge['kind'], { stroke: string; dash?: string; width: number }> = {
  issued: { stroke: 'var(--color-ink-300, #b9b3a8)', width: 1.25 },
  converts_to: { stroke: 'var(--color-bond-500, #3d6cb9)', dash: '5 4', width: 1.5 },
  senior_to: { stroke: 'var(--color-brass-500, #a5762c)', width: 1 },
  funded: { stroke: 'var(--color-ink-300, #b9b3a8)', dash: '2 3', width: 1 },
};

const pct = (v: number | null) => (v === null ? '—' : `${(v * 100).toFixed(1)}%`);
const num = (v: number) => v.toLocaleString('en-US');

interface Placed extends GraphNode {
  x: number;
  y: number;
}

/** Ranks become columns; nodes sharing a rank stack down the column. */
function layout(nodes: GraphNode[]): { placed: Placed[]; width: number; height: number } {
  const byRank = new Map<number, GraphNode[]>();
  for (const node of nodes) {
    const list = byRank.get(node.rank) ?? [];
    list.push(node);
    byRank.set(node.rank, list);
  }
  const ranks = [...byRank.keys()].sort((a, b) => a - b);
  const tallest = Math.max(...ranks.map((r) => byRank.get(r)!.length), 1);
  const height = PAD * 2 + tallest * NODE_H + (tallest - 1) * ROW_GAP;

  const placed: Placed[] = [];
  ranks.forEach((rank, column) => {
    const inColumn = byRank.get(rank)!;
    const columnHeight = inColumn.length * NODE_H + (inColumn.length - 1) * ROW_GAP;
    // Centred vertically in its column, so a one-node column reads as the
    // spine of the drawing rather than pinned to the top.
    const top = (height - columnHeight) / 2;
    inColumn.forEach((node, i) => {
      placed.push({
        ...node,
        x: PAD + column * (NODE_W + COL_GAP),
        y: top + i * (NODE_H + ROW_GAP),
      });
    });
  });

  return {
    placed,
    width: PAD * 2 + ranks.length * NODE_W + Math.max(ranks.length - 1, 0) * COL_GAP,
    height,
  };
}

/**
 * An edge leaves the right of its source and enters the left of its target —
 * except within a column, where both are the same x and a straight line would
 * pass through the node between them. Those route around the outside.
 */
function edgePath(from: Placed, to: Placed): string {
  const x1 = from.x + NODE_W;
  const y1 = from.y + NODE_H / 2;
  const x2 = to.x;
  const y2 = to.y + NODE_H / 2;
  if (from.x === to.x) {
    const side = from.x + NODE_W + 18;
    return `M ${x1} ${y1} C ${side} ${y1}, ${side} ${y2}, ${x1} ${y2}`;
  }
  if (x2 < x1) {
    // Backwards edge (a round feeding the company): under the row.
    const dip = Math.max(y1, y2) + NODE_H;
    return `M ${from.x} ${y1} C ${from.x - 40} ${dip}, ${x2 + NODE_W + 40} ${dip}, ${x2 + NODE_W} ${y2}`;
  }
  const mid = (x1 + x2) / 2;
  return `M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}`;
}

export function CapTableGraph({ graph }: { graph: CapTableGraphData }) {
  const [selected, setSelected] = useState<string | null>(null);
  const { placed, width, height } = useMemo(() => layout(graph.nodes), [graph.nodes]);
  const byId = useMemo(() => new Map(placed.map((n) => [n.id, n])), [placed]);
  const detail = selected ? byId.get(selected) : null;

  // Selecting a node dims everything it does not touch — the point of the
  // picture is one class's relationships, and eight classes of arrows at full
  // strength is the table's problem again in a different shape.
  const connected = useMemo(() => {
    if (!selected) return null;
    const ids = new Set<string>([selected]);
    for (const e of graph.edges) {
      if (e.from === selected) ids.add(e.to);
      if (e.to === selected) ids.add(e.from);
    }
    return ids;
  }, [selected, graph.edges]);

  return (
    <div>
      {graph.issues.length > 0 && (
        <ul className="mb-4 space-y-2">
          {graph.issues.map((issue) => (
            <li
              key={issue.code}
              className={`rounded-md border px-4 py-2.5 text-sm ${
                issue.severity === 'error'
                  ? 'border-red-200 bg-red-50 text-red-800'
                  : 'border-amber-200 bg-amber-50 text-amber-800'
              }`}
            >
              {issue.message}
            </li>
          ))}
        </ul>
      )}

      <div className="overflow-x-auto rounded-lg border border-paper-300 bg-surface p-2 shadow-card">
        <svg
          viewBox={`0 0 ${width} ${height}`}
          width={width}
          height={height}
          // Not `role="img"`. Every node below is a `role="button"` with a
          // `tabIndex` of 0, and ARIA makes an `img` a leaf: its descendants
          // are presentational, so the whole diagram collapsed to its one
          // label and the nodes became silent tab stops — focusable, named,
          // and pruned out of the tree before anything could read the name.
          // `group` is a container, so the buttons survive to be announced.
          role="group"
          aria-label="Cap table structure: share classes in liquidation order, with conversion paths"
          className="max-w-none"
        >
          <defs>
            {(Object.keys(EDGE_STYLE) as GraphEdge['kind'][]).map((kind) => (
              <marker
                key={kind}
                id={`arrow-${kind}`}
                viewBox="0 0 10 10"
                refX="9"
                refY="5"
                markerWidth="6"
                markerHeight="6"
                orient="auto-start-reverse"
              >
                <path d="M 0 0 L 10 5 L 0 10 z" fill={EDGE_STYLE[kind].stroke} />
              </marker>
            ))}
          </defs>

          {graph.edges.map((edge, i) => {
            const from = byId.get(edge.from);
            const to = byId.get(edge.to);
            if (!from || !to) return null;
            const style = EDGE_STYLE[edge.kind];
            const dimmed = connected && !(connected.has(edge.from) && connected.has(edge.to));
            return (
              <path
                key={`${edge.from}-${edge.to}-${edge.kind}-${i}`}
                d={edgePath(from, to)}
                fill="none"
                stroke={style.stroke}
                strokeWidth={style.width}
                strokeDasharray={style.dash}
                markerEnd={`url(#arrow-${edge.kind})`}
                opacity={dimmed ? 0.15 : 0.9}
              />
            );
          })}

          {placed.map((node) => {
            const dimmed = connected && !connected.has(node.id);
            const isCompany = node.kind === 'company';
            return (
              <g
                key={node.id}
                transform={`translate(${node.x} ${node.y})`}
                opacity={dimmed ? 0.3 : 1}
                className="cursor-pointer"
                onClick={() => setSelected((s) => (s === node.id ? null : node.id))}
                role="button"
                tabIndex={0}
                // The node is a toggle — it opens and closes the detail panel
                // below the diagram — and the panel is not where focus is, so
                // pressed state is the only feedback its activation has.
                aria-pressed={selected === node.id}
                aria-label={`${node.label}, ${pct(node.ownership)} fully diluted`}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    setSelected((s) => (s === node.id ? null : node.id));
                  }
                }}
              >
                <rect
                  width={NODE_W}
                  height={NODE_H}
                  rx="8"
                  fill={NODE_FILL[node.kind]}
                  stroke={selected === node.id ? 'var(--color-ink-900, #1b1d21)' : NODE_STROKE[node.kind]}
                  strokeWidth={selected === node.id ? 2.5 : 1.5}
                />
                <text
                  x="12"
                  y="24"
                  fontSize="13"
                  fontWeight="600"
                  fill={isCompany ? 'var(--color-paper-50, #fff)' : 'var(--color-ink-900, #1b1d21)'}
                >
                  {node.label.length > 20 ? `${node.label.slice(0, 19)}…` : node.label}
                </text>
                <text
                  x="12"
                  y="43"
                  fontSize="11"
                  fill={isCompany ? 'var(--color-paper-300, #ccc)' : 'var(--color-ink-400, #6f6a62)'}
                >
                  {node.kind === 'funding_round'
                    ? 'Round'
                    : converts(node)
                      ? `${num(node.as_converted_shares!)} sh a/c`
                      : `${num(node.shares)} sh`}
                </text>
                {node.ownership !== null && !isCompany && (
                  <text
                    x={NODE_W - 12}
                    y="43"
                    fontSize="11"
                    textAnchor="end"
                    fill="var(--color-ink-400, #6f6a62)"
                  >
                    {pct(node.ownership)}
                  </text>
                )}
                {node.seniority !== null && (
                  <text
                    x={NODE_W - 12}
                    y="24"
                    fontSize="10"
                    textAnchor="end"
                    fill="var(--color-brass-600, #8a6224)"
                    fontWeight="600"
                  >
                    sr {node.seniority}
                  </text>
                )}
              </g>
            );
          })}
        </svg>
      </div>

      <div className="mt-3 flex flex-wrap gap-x-6 gap-y-2 text-xs text-ink-500">
        <LegendItem kind="issued" label="Issued by the company" />
        <LegendItem kind="converts_to" label="Converts / exercises into" />
        <LegendItem kind="senior_to" label="Paid before" />
        <LegendItem kind="funded" label="Funding round" />
      </div>

      {detail && (
        <dl className="mt-4 grid gap-x-8 gap-y-2 rounded-lg border border-paper-300 bg-surface p-5 text-sm shadow-card sm:grid-cols-2 lg:grid-cols-3">
          <Row label="Class" value={detail.label} />
          <Row label="Type" value={detail.class_type ?? '—'} />
          <Row label={converts(detail) ? 'Shares (outstanding)' : 'Shares'} value={num(detail.shares)} />
          {converts(detail) && <Row label="Shares (as-converted)" value={num(detail.as_converted_shares!)} />}
          <Row label="Fully diluted" value={pct(detail.ownership)} />
          <Row
            label="Seniority"
            value={detail.seniority === null ? 'Not stated' : String(detail.seniority)}
          />
          <Row
            label="Liquidation preference"
            value={
              detail.liquidation_preference === null
                ? '—'
                : `$${num(Math.round(detail.liquidation_preference))}`
            }
          />
          <Row
            label="Issue price"
            value={detail.price_per_share === null ? '—' : `$${detail.price_per_share}`}
          />
          <Row
            label="Invested"
            value={detail.invested_amount === null ? '—' : `$${num(Math.round(detail.invested_amount))}`}
          />
          <Row
            label="Conversion ratio"
            value={detail.conversion_ratio === null ? '1:1 (assumed)' : `${detail.conversion_ratio}:1`}
          />
        </dl>
      )}
    </div>
  );
}

function LegendItem({ kind, label }: { kind: GraphEdge['kind']; label: string }) {
  const style = EDGE_STYLE[kind];
  return (
    <span className="flex items-center gap-2">
      <svg width="26" height="8" aria-hidden>
        <line
          x1="0"
          y1="4"
          x2="26"
          y2="4"
          stroke={style.stroke}
          strokeWidth={style.width + 0.5}
          strokeDasharray={style.dash}
        />
      </svg>
      {label}
    </span>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="overline text-ink-400">{label}</dt>
      <dd className="tnum mt-0.5 text-ink-800">{value}</dd>
    </div>
  );
}
