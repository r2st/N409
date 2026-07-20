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
