import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, describeActionFailure } from '../../lib/api';
import { optional, useFormValidation, type Rules } from '../../lib/useFormValidation';
import { Seo } from '../../components/Seo';
import { pageMeta } from '../../lib/pageMeta';

/**
 * The free, no-signup 409A estimator (`/tools/409a-valuation-calculator`).
 *
 * Public on purpose, and deliberately honest about what it is not: the
 * disclaimer is rendered from the response body rather than hard-coded here,
 * so the caveat cannot drift from the endpoint that computed the number. The
 * distribution is drawn as a curve rather than a single figure for the same
 * reason — a point estimate would read as a valuation, and this is not one.
 */

type Range = { p10: number; median: number; p90: number };

interface EstimatorResponse {
  inputs: { stages: string[]; round_ages: string[] };
  result: {
    stage: string;
    equity_value: Range;
    common_allocation: Range;
    common_share_band: { low: number; high: number };
    common_fmv: Range;
    dlom: number;
    per_share: Range | null;
    evidence: { source: string; label: string; weight: number; implied: Range; note: string }[];
    curve: { value: number; density: number }[];
    disclaimer: string;
  };
}

const STAGES: { value: string; label: string }[] = [
  { value: 'pre_seed', label: 'Pre-seed / no priced round' },
  { value: 'seed', label: 'Seed' },
  { value: 'series_a', label: 'Series A' },
  { value: 'series_b', label: 'Series B' },
  { value: 'series_c', label: 'Series C / growth' },
  { value: 'pre_ipo', label: 'Pre-IPO / late stage' },
];

const ROUND_AGES: { value: string; label: string }[] = [
  { value: 'never', label: 'Never' },
  { value: 'under_6m', label: 'In the last 6 months' },
  { value: '6_to_12m', label: '6 to 12 months ago' },
  { value: '1_to_2y', label: '1 to 2 years ago' },
  { value: 'over_2y', label: 'Over 2 years ago' },
];

const MONEY_FIELDS = [
  {
    key: 'post_money',
    label: 'Post-money of that round',
    hint: 'The valuation your last priced round closed at.',
  },
  {
    key: 'capital_raised',
    label: 'Total capital raised',
    hint: 'Include SAFEs and notes. Used as supporting evidence of scale, never as a market price.',
  },
  { key: 'revenue_ltm', label: 'Revenue, last 12 months', hint: '' },
  {
    key: 'profit_ltm',
    label: 'Profit, last 12 months',
    hint: 'EBITDA or pre-tax profit. Leave blank if not yet profitable.',
  },
] as const;

type MoneyKey = (typeof MONEY_FIELDS)[number]['key'];

/** Compact currency — a range is unreadable at full precision. */
function usd(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1e9) return `$${(n / 1e9).toFixed(1)}B`;
  if (abs >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `$${Math.round(n / 1e3)}K`;
  return `$${n.toFixed(0)}`;
}

/** Per-share figures are quoted to the cent, or finer when they are tiny. */
function perShare(n: number): string {
  if (n < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

/** Parse a typed figure, tolerating the commas and $ people actually type. */
function parseMoney(raw: string): number | null {
  const cleaned = raw.replace(/[$,\s]/g, '');
  if (cleaned === '') return null;
  const n = Number(cleaned);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * The density curve, with the central 80 percent shaded and the median marked.
 * Plotted against log(value), which is the axis the lognormal is symmetric on
 * — on a linear axis the same distribution looks like an error.
 */
function DistributionChart({ curve, band }: { curve: { value: number; density: number }[]; band: Range }) {
  const W = 640;
  const H = 180;
  const pad = { top: 8, bottom: 28 };

  const xs = curve.map((p) => Math.log(p.value));
  const minX = xs[0]!;
  const maxX = xs[xs.length - 1]!;
  const maxD = Math.max(...curve.map((p) => p.density));

  const sx = (logV: number) => ((logV - minX) / (maxX - minX)) * W;
  const sy = (d: number) => pad.top + (1 - d / maxD) * (H - pad.top - pad.bottom);

  const line = curve
    .map((p, i) => `${i === 0 ? 'M' : 'L'}${sx(Math.log(p.value))},${sy(p.density)}`)
    .join('');
  const inBand = curve.filter((p) => p.value >= band.p10 && p.value <= band.p90);
  const baseY = H - pad.bottom;
  const area =
    inBand.length > 0
      ? `M${sx(Math.log(inBand[0]!.value))},${baseY}` +
        inBand.map((p) => `L${sx(Math.log(p.value))},${sy(p.density)}`).join('') +
        `L${sx(Math.log(inBand[inBand.length - 1]!.value))},${baseY}Z`
      : '';

  return (
    <figure className="mt-6">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="h-auto w-full"
        role="img"
        aria-label={`Indicative equity value distribution: central 80 percent from ${usd(band.p10)} to ${usd(band.p90)}, median ${usd(band.median)}.`}
      >
        {area && <path d={area} className="fill-bond-600/15" />}
        <path d={line} className="fill-none stroke-bond-600" strokeWidth={2} />
        <line
          x1={sx(Math.log(band.median))}
          x2={sx(Math.log(band.median))}
          y1={pad.top}
          y2={baseY}
          className="stroke-bond-700"
          strokeWidth={1.5}
          strokeDasharray="4 3"
        />
        <line x1={0} x2={W} y1={baseY} y2={baseY} className="stroke-paper-300" strokeWidth={1} />
        {(
          [
            [band.p10, usd(band.p10)],
            [band.median, `Median ${usd(band.median)}`],
            [band.p90, usd(band.p90)],
          ] as const
        ).map(([v, label], i) => (
          <text
            key={label}
            x={Math.min(W - 4, Math.max(4, sx(Math.log(v))))}
            y={H - 8}
            textAnchor={i === 0 ? 'start' : i === 2 ? 'end' : 'middle'}
            className="fill-ink-500 text-[11px]"
          >
            {label}
          </text>
        ))}
      </svg>
      <figcaption className="mt-2 text-xs text-ink-500">
        The curve shows the spread of indicative outcomes consistent with your inputs. The shaded region
        covers the central 80 percent, with the median marked.
      </figcaption>
    </figure>
  );
}

function RangeRow({ label, range, format }: { label: string; range: Range; format: (n: number) => string }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-paper-200 py-2.5 last:border-b-0">
      <span className="text-sm text-ink-600">{label}</span>
      <span className="tnum text-sm font-semibold text-ink-900">
        {format(range.p10)} – {format(range.p90)}
        <span className="ml-2 font-normal text-ink-500">median {format(range.median)}</span>
      </span>
    </div>
  );
}

export function CalculatorPage() {
  const [stage, setStage] = useState('series_a');
  const [roundAge, setRoundAge] = useState('under_6m');
  const [money, setMoney] = useState<Record<MoneyKey, string>>({
    post_money: '',
    capital_raised: '',
    revenue_ltm: '',
    profit_ltm: '',
  });
  const [shares, setShares] = useState('');
  const [data, setData] = useState<EstimatorResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  /*
   * Every box here is free text — `inputMode="decimal"` is a keyboard hint and
   * not a constraint — and `parseMoney` returns null for anything it cannot
   * read. So a visitor who typed "2.5m" or "-400" or "0" had their figure
   * silently dropped and was then told to "Enter a round price, profit,
   * revenue, or capital raised", which they had just done. Nothing on this
   * page is required; what is checked is that a figure which was typed is one
   * the estimator can actually use.
   */
  const figures = useMemo(() => ({ ...money, shares }), [money, shares]);
  const figureRules: Rules<typeof figures> = Object.fromEntries(
    [...MONEY_FIELDS.map((f) => f.key), 'shares' as const].map((key) => [
      key,
      optional<typeof figures>(key, (values) => {
        const raw = String(values[key]).replace(/[$,\s]/g, '');
        const value = Number(raw);
        if (!Number.isFinite(value)) return 'Enter a figure in digits, e.g. 2500000.';
        return value > 0 ? null : 'Enter a figure above zero, or leave the box blank.';
      }),
    ]),
  );
  const { errorFor, blurHandler } = useFormValidation(figures, figureRules);

  const payload = useMemo(() => {
    const body: Record<string, unknown> = { stage, round_age: roundAge };
    for (const { key } of MONEY_FIELDS) {
      const n = parseMoney(money[key]);
      if (n !== null) body[key] = n;
    }
    const s = parseMoney(shares);
    if (s !== null) body.fully_diluted_shares = s;
    return body;
  }, [stage, roundAge, money, shares]);

  const hasEvidence = MONEY_FIELDS.some(({ key }) => parseMoney(money[key]) !== null);

  // Recompute as the form is edited. The endpoint is pure computation and
  // stores nothing, so there is nothing to debounce against beyond keystroke
  // chatter; the request is cheap and the last one in wins.
  const seq = useRef(0);
  useEffect(() => {
    if (!hasEvidence) {
      setData(null);
      setError(null);
      return;
    }
    const ticket = ++seq.current;
    const timer = setTimeout(() => {
      api<EstimatorResponse>('/fmv-estimator', { method: 'POST', body: payload })
        .then((res) => {
          if (ticket !== seq.current) return; // a later edit already won
          setData(res);
          setError(null);
        })
        .catch((err: unknown) => {
          if (ticket !== seq.current) return;
          setData(null);
          // `detail || message` already preferred the server's sentence; what it
          // fell through to on a detail-less body was the reason phrase.
          setError(describeActionFailure(err, 'Could not estimate.'));
        });
    }, 250);
    return () => clearTimeout(timer);
  }, [payload, hasEvidence]);

  const result = data?.result;

  return (
    <div className="mx-auto max-w-4xl px-5 py-16">
      <Seo {...pageMeta('/tools/409a-valuation-calculator')!} />
      <div className="overline text-ink-400">409A valuation calculator</div>
      <h1 className="mt-2 font-display text-4xl font-semibold text-ink-900">409A Valuation Calculator</h1>
      <p className="mt-3 max-w-2xl text-sm leading-relaxed text-ink-600">
        Estimate a range for your common stock from the evidence you actually have: a priced round, capital
        raised, revenue, or profit. Free, no signup, no email required.
      </p>

      <div className="mt-10 grid gap-8 md:grid-cols-2">
        <form className="grid gap-5" onSubmit={(e) => e.preventDefault()}>
          <label className="grid gap-1.5">
            <span className="text-sm font-semibold text-ink-900">When was your last priced round?</span>
            <select
              value={roundAge}
              onChange={(e) => setRoundAge(e.target.value)}
              className="rounded-md border border-paper-300 bg-surface px-3 py-2 text-sm text-ink-900"
            >
              {ROUND_AGES.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>

          <label className="grid gap-1.5">
            <span className="text-sm font-semibold text-ink-900">Stage</span>
            <select
              value={stage}
              onChange={(e) => setStage(e.target.value)}
              className="rounded-md border border-paper-300 bg-surface px-3 py-2 text-sm text-ink-900"
            >
              {STAGES.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>

          {MONEY_FIELDS.map((f) => (
            <label key={f.key} className="grid gap-1.5">
              <span className="text-sm font-semibold text-ink-900">
                {f.label} <span className="font-normal text-ink-500">(optional)</span>
              </span>
              <input
                inputMode="decimal"
                value={money[f.key]}
                onChange={(e) => setMoney((m) => ({ ...m, [f.key]: e.target.value }))}
                onBlur={blurHandler(f.key)}
                placeholder="$"
                aria-invalid={errorFor(f.key) ? true : undefined}
                aria-describedby={errorFor(f.key) ? `${f.key}-error` : undefined}
                className="rounded-md border border-paper-300 bg-surface px-3 py-2 text-sm text-ink-900"
              />
              {errorFor(f.key) ? (
                <span id={`${f.key}-error`} className="text-xs font-medium text-red-600">
                  {errorFor(f.key)}
                </span>
              ) : (
                f.hint && <span className="text-xs text-ink-500">{f.hint}</span>
              )}
            </label>
          ))}

          <label className="grid gap-1.5">
            <span className="text-sm font-semibold text-ink-900">
              Fully diluted shares{' '}
              <span className="font-normal text-ink-500">(optional, for a per-share figure)</span>
            </span>
            <input
              inputMode="decimal"
              value={shares}
              onChange={(e) => setShares(e.target.value)}
              onBlur={blurHandler('shares')}
              aria-invalid={errorFor('shares') ? true : undefined}
              aria-describedby={errorFor('shares') ? 'shares-error' : undefined}
              className="rounded-md border border-paper-300 bg-surface px-3 py-2 text-sm text-ink-900"
            />
            {errorFor('shares') && (
              <span id="shares-error" className="text-xs font-medium text-red-600">
                {errorFor('shares')}
              </span>
            )}
          </label>
        </form>

        <div data-testid="calculator-result">
          {!hasEvidence && (
            <div className="rounded-lg border border-dashed border-paper-300 p-6 text-sm text-ink-500">
              Enter a round price, profit, revenue, or capital raised.
            </div>
          )}
          {error && (
            <div role="alert" className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800">
              {error}
            </div>
          )}
          {result && (
            <div className="rounded-lg border border-paper-300 bg-surface p-6 shadow-card">
              <div className="overline text-bond-700">Indicative range</div>
              {result.per_share && (
                <div className="mt-2">
                  <div className="tnum font-display text-3xl font-semibold text-ink-900">
                    {perShare(result.per_share.p10)} – {perShare(result.per_share.p90)}
                  </div>
                  <div className="text-xs text-ink-500">per common share, after a marketability discount</div>
                </div>
              )}
              <div className="mt-4">
                <RangeRow label="Total equity value" range={result.equity_value} format={usd} />
                <RangeRow
                  label={`Common allocation (${Math.round(result.common_share_band.low * 100)}–${Math.round(
                    result.common_share_band.high * 100,
                  )}%)`}
                  range={result.common_allocation}
                  format={usd}
                />
                <RangeRow
                  label={`Common after DLOM (${Math.round(result.dlom * 100)}%)`}
                  range={result.common_fmv}
                  format={usd}
                />
              </div>
            </div>
          )}
        </div>
      </div>

      {result && (
        <>
          <DistributionChart curve={result.curve} band={result.equity_value} />

          <section className="mt-10">
            <h2 className="font-display text-xl font-semibold text-ink-900">What the estimate is built on</h2>
            <div className="mt-4 grid gap-3">
              {result.evidence.map((e) => (
                <div key={e.source} className="rounded-lg border border-paper-300 bg-surface p-4">
                  <div className="flex items-baseline justify-between gap-4">
                    <span className="text-sm font-semibold text-ink-900">{e.label}</span>
                    <span className="tnum text-xs text-ink-500">
                      {Math.round(e.weight * 100)}% of the blend
                    </span>
                  </div>
                  <div className="tnum mt-1 text-sm text-ink-700">
                    implies {usd(e.implied.p10)} – {usd(e.implied.p90)}
                  </div>
                  <p className="mt-1 text-xs leading-relaxed text-ink-500">{e.note}</p>
                </div>
              ))}
            </div>
          </section>

          <p className="mt-8 rounded-lg border border-amber-200 bg-amber-50 p-4 text-xs leading-relaxed text-amber-900">
            {result.disclaimer}
          </p>
        </>
      )}

      <section className="mt-14 border-t border-paper-200 pt-10">
        <div className="overline text-ink-400">Method</div>
        <h2 className="mt-2 font-display text-2xl font-semibold text-ink-900">
          How a 409A valuation is actually calculated
        </h2>
        <p className="mt-3 max-w-2xl text-sm leading-relaxed text-ink-600">
          A real appraisal runs three steps. The estimator above compresses all of them into a
          stage-calibrated statistical range, which is why it can only ever be indicative.
        </p>
        <ol className="mt-6 grid gap-5">
          {[
            {
              title: 'Establish total equity value',
              body: 'The appraiser values the whole company using the market approach (your recent financing and comparable companies), the income approach (earnings and cash flows), or the asset approach, depending on stage and data quality. The estimator mirrors this by blending whichever evidence you have.',
            },
            {
              title: 'Allocate value across share classes',
              body: 'Equity value is split across preferred and common using an option pricing model (OPM), a probability-weighted expected return method (PWERM), or a hybrid. This is where liquidation preferences and participation rights reduce what flows to common.',
            },
            {
              title: 'Apply a marketability discount',
              body: 'Common stock in a private company cannot be freely sold, so a discount for lack of marketability (DLOM) is applied. The result is the fair market value per share used for option strike prices.',
            },
          ].map((step, i) => (
            <li key={step.title} className="flex gap-4">
              <span className="tnum shrink-0 text-sm font-semibold text-bond-600">
                {String(i + 1).padStart(2, '0')}
              </span>
              <div>
                <div className="text-sm font-semibold text-ink-900">{step.title}</div>
                <p className="mt-1 text-sm leading-relaxed text-ink-600">{step.body}</p>
              </div>
            </li>
          ))}
        </ol>

        <div className="mt-10 flex flex-wrap items-center gap-4">
          <Link
            to="/register"
            className="rounded-md bg-bond-600 px-5 py-2.5 text-sm font-semibold text-bond-fg shadow-card transition-colors hover:bg-bond-700"
          >
            Get your real 409A valuation report
          </Link>
          <Link to="/sample-report" className="text-sm font-semibold text-bond-600 hover:text-bond-700">
            See a sample report →
          </Link>
        </div>
      </section>
    </div>
  );
}
