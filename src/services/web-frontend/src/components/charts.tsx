/** Dependency-free SVG donut chart for the dashboard analytics (M3). */

export interface PieSlice {
  label: string;
  value: number;
}

/** One heatmap cell: a formatted value + its signed delta vs. the base case. */
export interface HeatCell {
  value: number | null;
  delta: number | null;
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
  const deltas = cells.flat().map((c) => (c.delta === null ? 0 : Math.abs(c.delta)));
  const maxAbs = Math.max(0.0001, ...deltas);

  const shade = (delta: number | null): { background: string; color: string } => {
    if (delta === null) return { background: '#f3f4f6', color: '#9ca3af' };
    const intensity = Math.min(1, Math.abs(delta) / maxAbs);
    const alpha = 0.12 + intensity * 0.6;
    // bond green above base, brick red below.
    const rgb = delta >= 0 ? '47, 125, 91' : '160, 82, 82';
    return { background: `rgba(${rgb}, ${alpha})`, color: intensity > 0.6 ? '#fff' : '#1f2937' };
  };

  return (
    <div>
      <h2 className="mb-2 font-display text-lg font-semibold text-ink-900">{title}</h2>
      <div className="overflow-x-auto rounded-lg border border-paper-300 bg-white shadow-card">
        <table className="w-full min-w-[560px] text-sm" role="table">
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
                  return (
                    <td
                      key={j}
                      className="tnum px-4 py-2.5 text-right"
                      style={{ backgroundColor: style.background, color: style.color }}
                      title={cell.delta === null ? 'n/a' : `${(cell.delta * 100).toFixed(1)}%`}
                    >
                      {cell.value === null ? '—' : format(cell.value)}
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

// ledger palette: bond green, brass, ink tones
const PALETTE = ['#2f7d5b', '#b98d4f', '#3b5b7d', '#8d5a7d', '#5b8d8a', '#7d6e3b', '#a05252', '#6b7280'];

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
  const bars: Array<{ label: string; from: number; to: number; value: number; kind: 'total' | 'up' | 'down' }> = [];
  bars.push({ label: start.label, from: 0, to: start.value, value: start.value, kind: 'total' });
  let cum = start.value;
  for (const s of steps) {
    bars.push({ label: s.label, from: cum, to: cum + s.value, value: s.value, kind: s.value >= 0 ? 'up' : 'down' });
    cum += s.value;
  }
  bars.push({ label: end >= 0 ? 'New' : 'New', from: 0, to: end, value: end, kind: 'total' });

  const lo = Math.min(0, ...bars.map((b) => Math.min(b.from, b.to)));
  const hi = Math.max(0, ...bars.map((b) => Math.max(b.from, b.to)));
  const span = hi - lo || 1;
  const W = 100 / bars.length;
  const H = 100;
  const y = (v: number) => ((hi - v) / span) * H;
  const color = (kind: string) => (kind === 'total' ? '#3b5b7d' : kind === 'up' ? '#2f7d5b' : '#a05252');

  return (
    <div className="rounded-lg border border-paper-300 bg-white p-5 shadow-card">
      <div className="overline text-ink-400">{title}</div>
      <svg viewBox="0 0 100 118" className="mt-4 w-full" role="img" aria-label={title} preserveAspectRatio="none">
        {/* zero baseline */}
        <line x1="0" x2="100" y1={y(0)} y2={y(0)} stroke="#d9d2c4" strokeWidth="0.4" />
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
  color = '#2f7d5b',
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
    <div className="rounded-lg border border-paper-300 bg-white p-5 shadow-card">
      <div className="flex items-baseline justify-between">
        <div className="overline text-ink-400">{title}</div>
        {hasData && (
          <div className="tnum text-sm font-semibold text-ink-900">{format(vals[vals.length - 1]!)}</div>
        )}
      </div>
      {!hasData ? (
        <p className="mt-4 text-sm text-ink-400">Not enough data yet.</p>
      ) : (
        <svg viewBox="0 0 100 66" className="mt-3 w-full" role="img" aria-label={title} preserveAspectRatio="none">
          <line x1="0" x2="100" y1={y(lo)} y2={y(lo)} stroke="#eee9df" strokeWidth="0.3" />
          {segments.map((pts, i) => (
            <polyline key={i} points={pts} fill="none" stroke={color} strokeWidth="0.8" strokeLinejoin="round" />
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
    </div>
  );
}

export function DonutChart({ title, slices }: { title: string; slices: PieSlice[] }) {
  const total = slices.reduce((sum, s) => sum + s.value, 0);
  const shown = slices.filter((s) => s.value > 0);
  const r = 15.9155; // circumference 100 → percentages map to stroke-dash lengths
  let offset = 25; // start at 12 o'clock

  return (
    <div className="rounded-lg border border-paper-300 bg-white p-5 shadow-card">
      <div className="overline text-ink-400">{title}</div>
      {total === 0 ? (
        <p className="mt-4 text-sm text-ink-400">No data in this range.</p>
      ) : (
        <div className="mt-4 flex items-center gap-5">
          <svg viewBox="0 0 42 42" className="h-28 w-28 shrink-0" role="img" aria-label={title}>
            <circle cx="21" cy="21" r={r} fill="none" stroke="#eee9df" strokeWidth="7" />
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
