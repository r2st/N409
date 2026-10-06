import { useState } from 'react';
import { Link } from 'react-router-dom';
import { CrossProductLinks } from '../../components/CrossProductLinks';
import { Seo } from '../../components/Seo';
import { pageMeta } from '../../lib/pageMeta';
import { ShareResultBar } from '../../components/ShareResultBar';

/**
 * Free, no-signup Startup Valuation Estimator (`/tools/startup-valuation-estimator`).
 *
 * Purely client-side — no backend call. Uses revenue multiples and comparable
 * analysis heuristics to estimate enterprise value and common stock FMV as a
 * range. Targets SEO keywords like "startup valuation estimator", "how much is
 * my startup worth", "409A valuation calculator".
 *
 * Distinct from `/tools/409a-valuation-calculator` which takes specific priced-
 * round data and calls the backend for a probabilistic estimate. This page is
 * broader: it uses industry multiples and stage-based heuristics so a founder
 * with nothing more than revenue and a funding stage can get a ballpark.
 */

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

interface Industry {
  value: string;
  label: string;
  /** Median EV/Revenue multiple — sourced from public-comp averages. */
  revenueMultiple: number;
  /** How wide the band is around the median (±%). */
  spread: number;
}

const INDUSTRIES: Industry[] = [
  { value: 'saas', label: 'SaaS / Cloud Software', revenueMultiple: 10, spread: 0.5 },
  { value: 'fintech', label: 'Fintech', revenueMultiple: 8, spread: 0.45 },
  { value: 'healthtech', label: 'Healthtech / Biotech', revenueMultiple: 7, spread: 0.55 },
  { value: 'ecommerce', label: 'E-Commerce / DTC', revenueMultiple: 3, spread: 0.4 },
  { value: 'marketplace', label: 'Marketplace', revenueMultiple: 6, spread: 0.45 },
  { value: 'hardware', label: 'Hardware / IoT', revenueMultiple: 3, spread: 0.5 },
  { value: 'ai_ml', label: 'AI / Machine Learning', revenueMultiple: 15, spread: 0.55 },
  { value: 'enterprise', label: 'Enterprise Software', revenueMultiple: 8, spread: 0.4 },
  { value: 'consumer', label: 'Consumer / Social', revenueMultiple: 5, spread: 0.55 },
  { value: 'cleantech', label: 'Cleantech / Climate', revenueMultiple: 6, spread: 0.5 },
  { value: 'other', label: 'Other', revenueMultiple: 5, spread: 0.5 },
];

const STAGES = [
  { value: 'pre_seed', label: 'Pre-Seed', discountFactor: 0.6 },
  { value: 'seed', label: 'Seed', discountFactor: 0.7 },
  { value: 'series_a', label: 'Series A', discountFactor: 0.8 },
  { value: 'series_b', label: 'Series B', discountFactor: 0.88 },
  { value: 'series_c', label: 'Series C+', discountFactor: 0.93 },
] as const;

/* ------------------------------------------------------------------ */
/*  Valuation logic                                                    */
/* ------------------------------------------------------------------ */

interface EstimatorInputs {
  annualRevenue: number;
  revenueGrowthRate: number;
  industry: Industry;
  stage: (typeof STAGES)[number];
  totalFunding: number;
  employees: number;
}

interface ValuationResult {
  enterpriseValue: { low: number; mid: number; high: number };
  commonStockFmv: { low: number; mid: number; high: number };
  revenueMultipleUsed: { low: number; mid: number; high: number };
  dlom: number;
  method: string;
}

/**
 * Growth-rate premium: fast-growing companies trade at higher multiples.
 * Capped at 2× to keep estimates grounded.
 */
function growthPremium(growthPct: number): number {
  if (growthPct <= 0) return 0.7;
  if (growthPct <= 20) return 0.85;
  if (growthPct <= 50) return 1.0;
  if (growthPct <= 100) return 1.25;
  if (growthPct <= 200) return 1.5;
  return 1.8;
}

/**
 * Scale premium: more employees ≈ more traction → slight multiple uplift.
 */
function scalePremium(employees: number): number {
  if (employees <= 5) return 0.85;
  if (employees <= 20) return 0.95;
  if (employees <= 50) return 1.0;
  if (employees <= 200) return 1.05;
  return 1.1;
}

/**
 * DLOM (Discount for Lack of Marketability) — earlier-stage companies
 * have higher discounts because their shares are harder to sell.
 */
function dlomForStage(stage: string): number {
  switch (stage) {
    case 'pre_seed': return 0.35;
    case 'seed': return 0.30;
    case 'series_a': return 0.25;
    case 'series_b': return 0.20;
    case 'series_c': return 0.15;
    default: return 0.25;
  }
}

function estimate(inputs: EstimatorInputs): ValuationResult {
  const { annualRevenue, revenueGrowthRate, industry, stage, totalFunding, employees } = inputs;

  // Base revenue multiple adjusted for growth and scale
  const gPremium = growthPremium(revenueGrowthRate);
  const sPremium = scalePremium(employees);
  const adjustedMultiple = industry.revenueMultiple * gPremium * sPremium;

  // Range based on industry spread
  const lowMultiple = adjustedMultiple * (1 - industry.spread);
  const highMultiple = adjustedMultiple * (1 + industry.spread);

  // Enterprise value from revenue multiples
  let evLow = annualRevenue * lowMultiple;
  let evMid = annualRevenue * adjustedMultiple;
  let evHigh = annualRevenue * highMultiple;

  // Floor: enterprise value should be at least total funding raised
  const fundingFloor = totalFunding * 0.8;
  evLow = Math.max(evLow, fundingFloor);
  evMid = Math.max(evMid, fundingFloor * 1.2);
  evHigh = Math.max(evHigh, fundingFloor * 1.5);

  // Common stock allocation — preferred stock gets liquidation preference
  const dlom = dlomForStage(stage.value);
  const allocationDiscount = stage.discountFactor;
  const commonFactor = allocationDiscount * (1 - dlom);

  return {
    enterpriseValue: { low: evLow, mid: evMid, high: evHigh },
    commonStockFmv: {
      low: evLow * commonFactor,
      mid: evMid * commonFactor,
      high: evHigh * commonFactor,
    },
    revenueMultipleUsed: { low: lowMultiple, mid: adjustedMultiple, high: highMultiple },
    dlom,
    method: annualRevenue > 0 ? 'Revenue Multiple' : 'Funding-Based',
  };
}

/* ------------------------------------------------------------------ */
/*  Formatting helpers                                                 */
/* ------------------------------------------------------------------ */

function usd(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1e9) return `$${(n / 1e9).toFixed(1)}B`;
  if (abs >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `$${Math.round(n / 1e3).toLocaleString()}K`;
  return `$${Math.round(n).toLocaleString()}`;
}

function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

export function ValuationEstimatorPage(): React.JSX.Element {
  const meta = pageMeta('/tools/startup-valuation-estimator');

  const [annualRevenue, setAnnualRevenue] = useState('');
  const [revenueGrowthRate, setRevenueGrowthRate] = useState('');
  const [industryValue, setIndustryValue] = useState('');
  const [stageValue, setStageValue] = useState('');
  const [totalFunding, setTotalFunding] = useState('');
  const [employees, setEmployees] = useState('');
  const [result, setResult] = useState<ValuationResult | null>(null);

  const industry = INDUSTRIES.find((i) => i.value === industryValue);
  const stage = STAGES.find((s) => s.value === stageValue);

  const canEstimate =
    (annualRevenue !== '' || totalFunding !== '') &&
    industry !== undefined &&
    stage !== undefined;

  function handleEstimate() {
    if (!industry || !stage) return;

    const inputs: EstimatorInputs = {
      annualRevenue: parseFloat(annualRevenue) || 0,
      revenueGrowthRate: parseFloat(revenueGrowthRate) || 0,
      industry,
      stage,
      totalFunding: parseFloat(totalFunding) || 0,
      employees: parseInt(employees, 10) || 10,
    };

    setResult(estimate(inputs));
  }

  function handleReset() {
    setAnnualRevenue('');
    setRevenueGrowthRate('');
    setIndustryValue('');
    setStageValue('');
    setTotalFunding('');
    setEmployees('');
    setResult(null);
  }

  const shareText = result
    ? `Estimated startup valuation: ${usd(result.commonStockFmv.low)} – ${usd(result.commonStockFmv.high)} (common stock FMV). Method: ${result.method}, DLOM: ${pct(result.dlom)}.`
    : '';

  return (
    <div className="mx-auto max-w-4xl px-5 py-16">
      {meta && <Seo {...meta} />}

      <div className="overline text-ink-400">Free tool</div>
      <h1 className="mt-2 font-display text-4xl font-semibold text-ink-900">
        Startup Valuation Estimator
      </h1>
      <p className="mt-3 max-w-2xl text-sm leading-relaxed text-ink-600">
        Estimate your startup&apos;s fair market value in under a minute. Enter basic company data
        and get a valuation range based on industry revenue multiples, growth-rate adjustments, and
        stage-appropriate discounts. No signup, no email, completely free.
      </p>

      <div className="mt-10 grid gap-8 lg:grid-cols-2">
        {/* --- Left column: inputs --- */}
        <div className="grid gap-4" data-testid="estimator-inputs">
          <div className="rounded-lg border border-paper-300 bg-surface p-4">
            <label htmlFor="annual-revenue" className="text-sm font-semibold text-ink-900">
              Annual Revenue (USD)
            </label>
            <p className="mt-0.5 text-xs text-ink-500">
              Last 12 months of revenue. Enter 0 if pre-revenue.
            </p>
            <input
              id="annual-revenue"
              type="number"
              min="0"
              placeholder="e.g. 2000000"
              value={annualRevenue}
              onChange={(e) => setAnnualRevenue(e.target.value)}
              className="mt-2 w-full rounded-md border border-paper-300 bg-surface px-3 py-2 text-sm text-ink-900 placeholder:text-ink-400"
            />
          </div>

          <div className="rounded-lg border border-paper-300 bg-surface p-4">
            <label htmlFor="growth-rate" className="text-sm font-semibold text-ink-900">
              Revenue Growth Rate (% YoY)
            </label>
            <p className="mt-0.5 text-xs text-ink-500">
              Year-over-year revenue growth percentage. Leave blank if unsure.
            </p>
            <input
              id="growth-rate"
              type="number"
              placeholder="e.g. 100"
              value={revenueGrowthRate}
              onChange={(e) => setRevenueGrowthRate(e.target.value)}
              className="mt-2 w-full rounded-md border border-paper-300 bg-surface px-3 py-2 text-sm text-ink-900 placeholder:text-ink-400"
            />
          </div>

          <div className="rounded-lg border border-paper-300 bg-surface p-4">
            <label htmlFor="industry" className="text-sm font-semibold text-ink-900">
              Industry
            </label>
            <p className="mt-0.5 text-xs text-ink-500">
              Determines the baseline revenue multiple.
            </p>
            <select
              id="industry"
              value={industryValue}
              onChange={(e) => setIndustryValue(e.target.value)}
              className="mt-2 w-full rounded-md border border-paper-300 bg-surface px-3 py-2 text-sm text-ink-900"
            >
              <option value="">Select industry…</option>
              {INDUSTRIES.map((i) => (
                <option key={i.value} value={i.value}>{i.label}</option>
              ))}
            </select>
          </div>

          <div className="rounded-lg border border-paper-300 bg-surface p-4">
            <label htmlFor="stage" className="text-sm font-semibold text-ink-900">
              Funding Stage
            </label>
            <p className="mt-0.5 text-xs text-ink-500">
              Later stages get higher common stock allocation and lower DLOM.
            </p>
            <select
              id="stage"
              value={stageValue}
              onChange={(e) => setStageValue(e.target.value)}
              className="mt-2 w-full rounded-md border border-paper-300 bg-surface px-3 py-2 text-sm text-ink-900"
            >
              <option value="">Select stage…</option>
              {STAGES.map((s) => (
                <option key={s.value} value={s.value}>{s.label}</option>
              ))}
            </select>
          </div>

          <div className="rounded-lg border border-paper-300 bg-surface p-4">
            <label htmlFor="total-funding" className="text-sm font-semibold text-ink-900">
              Total Funding Raised (USD)
            </label>
            <p className="mt-0.5 text-xs text-ink-500">
              All equity, SAFEs, and convertible notes combined.
            </p>
            <input
              id="total-funding"
              type="number"
              min="0"
              placeholder="e.g. 5000000"
              value={totalFunding}
              onChange={(e) => setTotalFunding(e.target.value)}
              className="mt-2 w-full rounded-md border border-paper-300 bg-surface px-3 py-2 text-sm text-ink-900 placeholder:text-ink-400"
            />
          </div>

          <div className="rounded-lg border border-paper-300 bg-surface p-4">
            <label htmlFor="employees" className="text-sm font-semibold text-ink-900">
              Number of Employees
            </label>
            <p className="mt-0.5 text-xs text-ink-500">
              Full-time equivalent headcount.
            </p>
            <input
              id="employees"
              type="number"
              min="1"
              placeholder="e.g. 25"
              value={employees}
              onChange={(e) => setEmployees(e.target.value)}
              className="mt-2 w-full rounded-md border border-paper-300 bg-surface px-3 py-2 text-sm text-ink-900 placeholder:text-ink-400"
            />
          </div>

          <div className="flex gap-3">
            <button
              type="button"
              disabled={!canEstimate}
              onClick={handleEstimate}
              data-testid="estimate-button"
              className="rounded-md bg-bond-600 px-5 py-2.5 text-sm font-semibold text-bond-fg shadow-card transition-colors hover:bg-bond-700 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Estimate Valuation
            </button>
            {result && (
              <button
                type="button"
                onClick={handleReset}
                data-testid="reset-button"
                className="rounded-md border border-paper-300 px-5 py-2.5 text-sm font-semibold text-ink-600 transition-colors hover:bg-paper-100"
              >
                Reset
              </button>
            )}
          </div>
        </div>

        {/* --- Right column: results --- */}
        <div data-testid="estimator-result">
          {!result && (
            <div className="rounded-lg border border-dashed border-paper-300 p-6 text-sm text-ink-500">
              Enter your company details and click &ldquo;Estimate Valuation&rdquo; to see a range.
            </div>
          )}
          {result && (
            <div className="space-y-4">
              {/* Common stock FMV — the headline number */}
              <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-6 shadow-card">
                <div className="text-xs font-semibold uppercase tracking-wider text-emerald-700">
                  Estimated Common Stock FMV
                </div>
                <div className="mt-2 flex items-baseline gap-2">
                  <span className="font-display text-3xl font-bold text-emerald-800" data-testid="fmv-mid">
                    {usd(result.commonStockFmv.mid)}
                  </span>
                </div>
                <div className="mt-1 text-sm text-emerald-700" data-testid="fmv-range">
                  Range: {usd(result.commonStockFmv.low)} – {usd(result.commonStockFmv.high)}
                </div>
              </div>

              {/* Enterprise value */}
              <div className="rounded-lg border border-paper-300 bg-surface p-5">
                <div className="text-xs font-semibold uppercase tracking-wider text-ink-500">
                  Enterprise Value
                </div>
                <div className="mt-1 font-display text-xl font-semibold text-ink-900" data-testid="ev-mid">
                  {usd(result.enterpriseValue.mid)}
                </div>
                <div className="text-sm text-ink-500" data-testid="ev-range">
                  Range: {usd(result.enterpriseValue.low)} – {usd(result.enterpriseValue.high)}
                </div>
              </div>

              {/* Methodology breakdown */}
              <div className="rounded-lg border border-paper-300 bg-surface p-5">
                <div className="text-xs font-semibold uppercase tracking-wider text-ink-500">
                  Methodology
                </div>
                <div className="mt-3 grid grid-cols-2 gap-3 text-sm">
                  <div>
                    <span className="text-ink-500">Method</span>
                    <div className="font-semibold text-ink-900" data-testid="method">{result.method}</div>
                  </div>
                  <div>
                    <span className="text-ink-500">Revenue Multiple</span>
                    <div className="font-semibold text-ink-900" data-testid="multiple">
                      {result.revenueMultipleUsed.low.toFixed(1)}× – {result.revenueMultipleUsed.high.toFixed(1)}×
                    </div>
                  </div>
                  <div>
                    <span className="text-ink-500">DLOM</span>
                    <div className="font-semibold text-ink-900" data-testid="dlom">{pct(result.dlom)}</div>
                  </div>
                  <div>
                    <span className="text-ink-500">Stage Allocation</span>
                    <div className="font-semibold text-ink-900" data-testid="allocation">
                      {pct(stage?.discountFactor ?? 0)}
                    </div>
                  </div>
                </div>
              </div>

              {/* Disclaimer */}
              <div className="rounded-md border border-amber-200 bg-amber-50 p-4 text-xs leading-relaxed text-amber-800">
                <strong>Disclaimer:</strong> This estimate is for informational purposes only and
                does not constitute a 409A valuation, financial advice, or a formal appraisal.
                Actual 409A valuations require a qualified independent appraiser and consider many
                additional factors including cap table structure, liquidation preferences, option
                pool, market conditions, and company-specific risks.
              </div>

              <ShareResultBar
                title="Startup valuation estimate"
                text={shareText}
                emailSubject="Startup Valuation Estimate"
                emailLabel="Share with your co-founder"
                className="mt-2"
              />

              {/* CTA */}
              <div className="rounded-lg border border-bond-200 bg-bond-50 p-5">
                <h3 className="font-display text-lg font-semibold text-ink-900">
                  Need a defensible 409A valuation?
                </h3>
                <p className="mt-1 text-sm text-ink-600">
                  A professional 409A valuation gives you IRS safe harbor protection, is accepted by
                  auditors, and satisfies board and investor requirements. DoAide 409A delivers in
                  days, not weeks.
                </p>
                <div className="mt-4 flex flex-wrap items-center gap-3">
                  <Link
                    to="/register"
                    className="rounded-md bg-bond-600 px-5 py-2.5 text-sm font-semibold text-bond-fg shadow-card transition-colors hover:bg-bond-700"
                    data-testid="cta-register"
                  >
                    Get a professional 409A valuation
                  </Link>
                  <Link
                    to="/tools/409a-valuation-calculator"
                    className="text-sm font-semibold text-bond-600 hover:text-bond-700"
                  >
                    Try the detailed calculator →
                  </Link>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* --- Educational content --- */}
      <section className="mt-14 border-t border-paper-200 pt-10" data-testid="educational-content">
        <h2 className="font-display text-2xl font-semibold text-ink-900">
          How Startup Valuations Work
        </h2>
        <div className="mt-6 grid gap-5 md:grid-cols-3">
          {[
            {
              title: 'Revenue Multiples',
              body: 'The most common approach for revenue-generating startups. Your annual revenue is multiplied by an industry-specific factor — SaaS companies trade at 8–15× revenue, while e-commerce typically sees 2–5×. Growth rate significantly influences where you land in the range.',
            },
            {
              title: 'Common Stock vs. Preferred',
              body: 'Investors hold preferred stock with liquidation preferences and other rights. Common stock (what employees get through options) is worth less. The difference depends on how many preference layers exist and the company\'s stage — early-stage common stock can be 60–80% less than the preferred price.',
            },
            {
              title: 'Discount for Lack of Marketability',
              body: 'Private company shares cannot be easily sold on a market. A DLOM is applied to reflect this illiquidity, typically 15–35% depending on stage. Pre-IPO companies have lower DLOMs because a liquidity event is closer.',
            },
          ].map((item) => (
            <div key={item.title} className="rounded-lg border border-paper-300 bg-surface p-4">
              <h3 className="text-sm font-semibold text-ink-900">{item.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-ink-600">{item.body}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="mt-10 border-t border-paper-200 pt-10" data-testid="why-409a-section">
        <h2 className="font-display text-2xl font-semibold text-ink-900">
          Why You Need a 409A Valuation
        </h2>
        <div className="mt-6 grid gap-5 md:grid-cols-2">
          {[
            {
              title: 'IRS Compliance',
              body: 'IRC §409A requires that stock options be granted at or above fair market value. Without a qualified independent appraisal, option holders face a 20% penalty tax plus interest on vesting.',
            },
            {
              title: 'Safe Harbor Protection',
              body: 'A 409A valuation by a qualified appraiser creates a presumption of reasonableness that the IRS must overcome — shifting the burden of proof from your company to the government.',
            },
            {
              title: 'Board & Investor Requirements',
              body: 'Most VCs and board members require a current 409A before approving option grants. It protects the company and its employees from future tax and legal exposure.',
            },
            {
              title: 'Audit Readiness',
              body: 'ASC 718 (stock-based compensation accounting) requires a supportable FMV for every grant. Auditors will ask for the 409A report backing each exercise price.',
            },
          ].map((item) => (
            <div key={item.title} className="rounded-lg border border-paper-300 bg-surface p-4">
              <h3 className="text-sm font-semibold text-ink-900">{item.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-ink-600">{item.body}</p>
            </div>
          ))}
        </div>
      </section>

      {/* --- FAQ for SEO --- */}
      <section className="mt-10 border-t border-paper-200 pt-10" data-testid="faq-section">
        <h2 className="font-display text-2xl font-semibold text-ink-900">
          Frequently Asked Questions
        </h2>
        <div className="mt-6 grid gap-4">
          {[
            {
              q: 'How accurate is this startup valuation estimator?',
              a: 'This tool provides a directional estimate based on public-market revenue multiples adjusted for stage and growth. It is not a substitute for a formal 409A valuation, which considers cap table structure, liquidation preferences, comparable transactions, and company-specific risk factors. Use it as a starting point for planning.',
            },
            {
              q: 'What is a 409A valuation and do I need one?',
              a: 'A 409A valuation is an independent appraisal of your company\'s common stock fair market value, required under IRC §409A before granting stock options. If you plan to issue equity compensation, you need one. Without it, option holders risk a 20% penalty tax plus interest.',
            },
            {
              q: 'How often do I need a new 409A valuation?',
              a: 'At least every 12 months, or sooner if a material event occurs — such as a new funding round, significant revenue change, M&A activity, or a change in business model. Most companies get a new 409A before each major option grant.',
            },
            {
              q: 'What is the difference between enterprise value and common stock FMV?',
              a: 'Enterprise value is the total value of the business. Common stock FMV is the per-share (or aggregate) value of common shares after accounting for preferred stock liquidation preferences and applying a discount for lack of marketability (DLOM). Common stock FMV is always lower than enterprise value.',
            },
          ].map((item) => (
            <div key={item.q} className="rounded-lg border border-paper-300 bg-surface p-4">
              <h3 className="text-sm font-semibold text-ink-900">{item.q}</h3>
              <p className="mt-2 text-sm leading-relaxed text-ink-600">{item.a}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="mx-auto max-w-5xl px-5 pb-12">
        <CrossProductLinks page="valuation" />
      </section>
    </div>
  );
}
