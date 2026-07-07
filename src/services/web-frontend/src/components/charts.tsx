/** Dependency-free SVG donut chart for the dashboard analytics (M3). */

export interface PieSlice {
  label: string;
  value: number;
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
