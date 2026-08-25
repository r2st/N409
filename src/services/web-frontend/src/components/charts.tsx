import { useId } from 'react';

/** Dependency-free SVG donut chart for the dashboard analytics (M3). */

export interface PieSlice {
  label: string;
  value: number;
}

/** One heatmap cell: a formatted value + its signed delta vs. the base case. */
export interface HeatCell {
  value: number | null;
  delta: number | null;
  /**
   * Why this cell has no value. A blank cell is not self-explanatory — the
   * producer usually knows exactly why (the engine rejects a variation that
   * drives the discount rate below terminal growth, say) and that reason is
   * worth more to the reader than the em dash standing in for it.
   */
  note?: string;
}

export interface HeatmapProps {
  title: string;
  rowLabel: string;
  colLabel: string;
  rowValues: string[];
  colValues: string[];
  cells: HeatCell[][];
  /** Renders a cell's raw value (e.g. money formatter). */
  format: (v: number) => string;
}

/**
 * Two-way sensitivity heatmap: rows × columns of cells shaded by their
 * relative change from the base case — green above, red below, neutral at
 * the base. Pure SVG-free HTML table so it stays crisp and printable.
 */
export function Heatmap({ title, rowLabel, colLabel, rowValues, colValues, cells, format }: HeatmapProps) {
  const titleId = useId();
  const deltas = cells.flat().map((c) => (c.delta === null ? 0 : Math.abs(c.delta)));
  const maxAbs = Math.max(0.0001, ...deltas);

  const shade = (delta: number | null): { background: string; color: string } => {
    if (delta === null) return { background: 'var(--color-paper-200)', color: 'var(--color-ink-300)' };
    const intensity = Math.min(1, Math.abs(delta) / maxAbs);
    const alpha = 0.12 + intensity * 0.6;
    // bond green above base, brick red below.
    const rgb = delta >= 0 ? '47, 125, 91' : '160, 82, 82';
    return {
      background: `rgba(${rgb}, ${alpha})`,
      color: intensity > 0.6 ? '#fff' : 'var(--color-ink-900)',
    };
  };

  return (
    <div>
      <h2 id={titleId} className="mb-2 font-display text-lg font-semibold text-ink-900">
        {title}
      </h2>
      <div className="overflow-x-auto rounded-lg border border-paper-300 bg-surface shadow-card">
        <table className="w-full min-w-[560px] text-sm" role="table" aria-labelledby={titleId}>
          <thead>
            <tr className="border-b border-paper-300">
              <th className="overline px-4 py-3 text-left font-semibold text-ink-400">
                {rowLabel} \ {colLabel}
              </th>
              {colValues.map((c, j) => (
                <th key={j} className="tnum px-4 py-3 text-right font-semibold text-ink-700">
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {cells.map((row, i) => (
              <tr key={i} className="border-b border-paper-200 last:border-0">
                <td className="tnum px-4 py-2.5 font-semibold text-ink-700">{rowValues[i]}</td>
                {row.map((cell, j) => {
                  const style = shade(cell.delta);
                  // A reason only ever explains a *missing* value; where there
                  // is a number, the delta is the more useful hover.
                  const reason = cell.value === null ? cell.note : undefined;
                  return (
                    <td
                      key={j}
                      className="tnum px-4 py-2.5 text-right"
                      style={{ backgroundColor: style.background, color: style.color }}
                      title={reason ?? (cell.delta === null ? 'n/a' : `${(cell.delta * 100).toFixed(1)}%`)}
                    >
                      {cell.value === null ? '—' : format(cell.value)}
                      {/* `title` is hover-only and never reaches a screen reader,
                          which would otherwise be read an unexplained dash. */}
                      {reason && <span className="sr-only">{reason}</span>}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/**
 * The ledger series ramp — bond green, brass, then the muted tones.
 *
 * Every entry is a token reference rather than a hex literal, because a hex in
 * a TSX attribute is the one colour in the app that cannot follow the theme.
 * The values (and their lifted dark-mode counterparts) live in the `chart`
 * block of index.css; see the comment there for why the dark ramp is not the
 * light one. `CHART_COLORS` is exported so callers that want a *specific*
 * series — the analytics tab pairs a metric with a hue — name it the same way.
 */
export const CHART_COLORS = {
  green: 'var(--color-chart-1)',
  brass: 'var(--color-chart-2)',
  blue: 'var(--color-chart-3)',
  plum: 'var(--color-chart-4)',
  teal: 'var(--color-chart-5)',
  olive: 'var(--color-chart-6)',
  red: 'var(--color-chart-7)',
  slate: 'var(--color-chart-8)',
} as const;

const PALETTE = Object.values(CHART_COLORS);

/**
 * The numbers behind a chart, as a table only assistive technology reads.
 *
 * An `<svg role="img" aria-label="Published per week">` announces its label and
 * *nothing else*: `role="img"` makes the element a leaf, so the `<text>` labels
 * drawn inside it and the `<title>` on each data point are not exposed. A
 * screen-reader user was told a chart existed and given no way to learn a single
 * figure from it — which for the throughput trend on the operations dashboard is
 * the whole content of the panel (WCAG 1.1.1).
 *
 * A table rather than a prose summary: the data is tabular, tables are
 * navigable cell by cell, and it stays correct as the series grows. Visually
 * hidden rather than `aria-label`-stuffed, so it is also available to anyone
 * who finds the chart easier to read as numbers — including in the printed
 * board pack, where `sr-only` is simply invisible and the chart is the copy.
 */
export function ChartDataTable({
  caption,
  columns,
  rows,
}: {
  caption: string;
  columns: [string, string];
  rows: Array<{ label: string; value: string }>;
}) {
  return (
    <table className="sr-only">
      <caption>{caption}</caption>
      <thead>
        <tr>
          <th scope="col">{columns[0]}</th>
          <th scope="col">{columns[1]}</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row, i) => (
          <tr key={`${row.label}-${i}`}>
            <th scope="row">{row.label}</th>
            <td>{row.value}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export interface WaterfallStep {
  label: string;
  /** Signed contribution (an intermediate delta). */
  value: number;
}

/**
 * Floating-bar waterfall (feature 3 value bridge): a start total, a sequence of
 * signed contributions, and an end total. Green bars add value, red subtract;
 * the running total connects them. Dependency-free SVG to stay printable.
 */
export function WaterfallChart({
  title,
  start,
  steps,
  format,
}: {
  title: string;
  start: { label: string; value: number };
  steps: WaterfallStep[];
  format: (v: number) => string;
}) {
  const end = start.value + steps.reduce((a, s) => a + s.value, 0);
  // Running cumulative levels for each floating bar.
  const bars: Array<{
    label: string;
    from: number;
    to: number;
    value: number;
    kind: 'total' | 'up' | 'down';
  }> = [];
  bars.push({ label: start.label, from: 0, to: start.value, value: start.value, kind: 'total' });
  let cum = start.value;
  for (const s of steps) {
    bars.push({
      label: s.label,
      from: cum,
      to: cum + s.value,
      value: s.value,
      kind: s.value >= 0 ? 'up' : 'down',
    });
    cum += s.value;
  }
  bars.push({ label: end >= 0 ? 'New' : 'New', from: 0, to: end, value: end, kind: 'total' });

  const lo = Math.min(0, ...bars.map((b) => Math.min(b.from, b.to)));
  const hi = Math.max(0, ...bars.map((b) => Math.max(b.from, b.to)));
  const span = hi - lo || 1;
  const W = 100 / bars.length;
  const H = 100;
  const y = (v: number) => ((hi - v) / span) * H;
  const color = (kind: string) =>
    kind === 'total' ? CHART_COLORS.blue : kind === 'up' ? CHART_COLORS.green : CHART_COLORS.red;

  return (
    <div className="rounded-lg border border-paper-300 bg-surface p-5 shadow-card">
      <div className="overline text-ink-400">{title}</div>
      {/* The picture is decoration once the table below carries the numbers;
          leaving it as role="img" would announce the title twice. */}
      <svg viewBox="0 0 100 118" className="mt-4 w-full" aria-hidden="true" preserveAspectRatio="none">
        {/* zero baseline */}
        <line x1="0" x2="100" y1={y(0)} y2={y(0)} stroke="var(--color-paper-300)" strokeWidth="0.4" />
        {bars.map((b, i) => {
          const x = i * W + W * 0.15;
          const w = W * 0.7;
          const top = Math.min(y(b.from), y(b.to));
          const h = Math.max(0.6, Math.abs(y(b.to) - y(b.from)));
          return (
            <g key={i}>
              <rect x={x} y={top} width={w} height={h} fill={color(b.kind)} rx="0.6">
                <title>{`${b.label}: ${format(b.value)}`}</title>
              </rect>
              <text
                x={i * W + W / 2}
                y={110}
                textAnchor="middle"
                className="fill-ink-400"
                style={{ fontSize: '3.2px' }}
              >
                {b.label.length > 14 ? `${b.label.slice(0, 13)}…` : b.label}
              </text>
              <text
                x={i * W + W / 2}
                y={Math.max(4, top - 1.5)}
                textAnchor="middle"
                className="fill-ink-700 font-semibold"
                style={{ fontSize: '3px' }}
              >
                {b.kind === 'total' ? format(b.value) : `${b.value >= 0 ? '+' : ''}${format(b.value)}`}
              </text>
            </g>
          );
        })}
      </svg>
      <ChartDataTable
        caption={title}
        columns={['Step', 'Value']}
        rows={bars.map((b) => ({
          label: b.label,
          // The bridge's meaning is in the signs: a reader hearing "5,000,000"
          // three times cannot tell a contribution from a running total.
          value: b.kind === 'total' ? format(b.value) : `${b.value >= 0 ? '+' : ''}${format(b.value)}`,
        }))}
      />
    </div>
  );
}

export interface LinePoint {
  label: string;
  value: number | null;
}

/**
 * Single-series SVG line chart for a trend (feature 5 analytics). Null values
 * break the line. Dependency-free to match the rest of this file and stay
 * printable in reports.
 */
export function LineChart({
  title,
  points,
  format,
  color = CHART_COLORS.green,
}: {
  title: string;
  points: LinePoint[];
  format: (v: number) => string;
  color?: string;
}) {
  const vals = points.map((p) => p.value).filter((v): v is number => v !== null);
  const hasData = vals.length > 0;
  const lo = hasData ? Math.min(...vals) : 0;
  const hi = hasData ? Math.max(...vals) : 1;
  const span = hi - lo || Math.abs(hi) || 1;
  const W = 100;
  const H = 60;
  const n = points.length;
  const x = (i: number) => (n <= 1 ? W / 2 : (i / (n - 1)) * W);
  const y = (v: number) => H - ((v - lo) / span) * H * 0.9 - H * 0.05;

  // Build the polyline path, breaking on nulls.
  const segments: string[] = [];
  let current: string[] = [];
  points.forEach((p, i) => {
    if (p.value === null) {
      if (current.length) segments.push(current.join(' '));
      current = [];
    } else {
      current.push(`${x(i).toFixed(2)},${y(p.value).toFixed(2)}`);
    }
  });
  if (current.length) segments.push(current.join(' '));

  return (
    <div className="rounded-lg border border-paper-300 bg-surface p-5 shadow-card">
      <div className="flex items-baseline justify-between">
        <div className="overline text-ink-400">{title}</div>
        {hasData && (
          <div className="tnum text-sm font-semibold text-ink-900">{format(vals[vals.length - 1]!)}</div>
        )}
      </div>
      {!hasData ? (
        <p className="mt-4 text-sm text-ink-400">Not enough data yet.</p>
      ) : (
        <svg viewBox="0 0 100 66" className="mt-3 w-full" aria-hidden="true" preserveAspectRatio="none">
          <line x1="0" x2="100" y1={y(lo)} y2={y(lo)} stroke="var(--color-paper-300)" strokeWidth="0.3" />
          {segments.map((pts, i) => (
            <polyline
              key={i}
              points={pts}
              fill="none"
              stroke={color}
              strokeWidth="0.8"
              strokeLinejoin="round"
            />
          ))}
          {points.map((p, i) =>
            p.value === null ? null : (
              <circle key={i} cx={x(i)} cy={y(p.value)} r="0.9" fill={color}>
                <title>{`${p.label}: ${format(p.value)}`}</title>
              </circle>
            ),
          )}
        </svg>
      )}
      {hasData && (
        <ChartDataTable
          caption={title}
          columns={['Period', 'Value']}
          rows={points.map((p) => ({
            label: p.label,
            // A gap in the series is a real state — "no data" reads correctly
            // where a zero would be a claim nothing happened.
            value: p.value === null ? 'no data' : format(p.value),
          }))}
        />
      )}
    </div>
  );
}

export function DonutChart({ title, slices }: { title: string; slices: PieSlice[] }) {
  const total = slices.reduce((sum, s) => sum + s.value, 0);
  const shown = slices.filter((s) => s.value > 0);
  const r = 15.9155; // circumference 100 → percentages map to stroke-dash lengths
  let offset = 25; // start at 12 o'clock

  return (
    <div className="rounded-lg border border-paper-300 bg-surface p-5 shadow-card">
      <div className="overline text-ink-400">{title}</div>
      {total === 0 ? (
        <p className="mt-4 text-sm text-ink-400">No data in this range.</p>
      ) : (
        <div className="mt-4 flex items-center gap-5">
          {/* The total is drawn in the middle of the ring and nowhere else.
              `role="img"` is a leaf, so that figure — the one the design puts
              at the centre of the panel — reached no screen reader at all;
              the legend beside it lists the slices and never their sum. The
              label is the only place a leaf can carry it. */}
          <svg
            viewBox="0 0 42 42"
            className="h-28 w-28 shrink-0"
            role="img"
            aria-label={`${title}: ${total} in total`}
          >
            <circle cx="21" cy="21" r={r} fill="none" stroke="var(--color-paper-300)" strokeWidth="7" />
            {shown.map((s, i) => {
              const pct = (s.value / total) * 100;
              const el = (
                <circle
                  key={s.label}
                  cx="21"
                  cy="21"
                  r={r}
                  fill="none"
                  stroke={PALETTE[i % PALETTE.length]}
                  strokeWidth="7"
                  strokeDasharray={`${pct} ${100 - pct}`}
                  strokeDashoffset={offset}
                >
                  <title>{`${s.label}: ${s.value}`}</title>
                </circle>
              );
              offset -= pct;
              return el;
            })}
            <text
              x="21"
              y="22.5"
              textAnchor="middle"
              className="fill-ink-900 font-semibold"
              style={{ fontSize: '9px' }}
            >
              {total}
            </text>
          </svg>
          <ul className="min-w-0 space-y-1.5 text-sm">
            {shown.map((s, i) => (
              <li key={s.label} className="flex items-center gap-2">
                <span
                  className="h-2.5 w-2.5 shrink-0 rounded-sm"
                  style={{ backgroundColor: PALETTE[i % PALETTE.length] }}
                />
                <span className="truncate text-ink-600">{s.label}</span>
                <span className="tnum ml-auto pl-3 font-semibold text-ink-900">{s.value}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
