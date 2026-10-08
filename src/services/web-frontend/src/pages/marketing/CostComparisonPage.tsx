import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Seo } from '../../components/Seo';
import { FaqAccordion } from '../../components/FaqAccordion';
import { pageMeta } from '../../lib/pageMeta';
import { ShareResultBar } from '../../components/ShareResultBar';
import type { FaqItem } from '../../lib/marketing';

type CompanyStage = 'preseed' | 'seed' | 'series_a' | 'series_b' | 'series_c';

interface StageOption {
  value: CompanyStage;
  label: string;
  employees: string;
}

const STAGES: StageOption[] = [
  { value: 'preseed', label: 'Pre-seed / Bootstrapped', employees: '1–10' },
  { value: 'seed', label: 'Seed', employees: '5–25' },
  { value: 'series_a', label: 'Series A', employees: '20–75' },
  { value: 'series_b', label: 'Series B', employees: '50–200' },
  { value: 'series_c', label: 'Series C+', employees: '200+' },
];

interface ProviderData {
  name: string;
  costRange: [number, number];
  timeline: string;
  timelineWeeks: [number, number];
  features: string[];
  color: string;
  highlight?: boolean;
}

function getProviders(stage: CompanyStage): ProviderData[] {
  const tiers: Record<CompanyStage, { big4: [number, number]; boutique: [number, number]; doaide: [number, number] }> = {
    preseed: { big4: [5000, 10000], boutique: [2000, 4000], doaide: [49, 99] },
    seed: { big4: [5000, 12000], boutique: [2500, 5000], doaide: [49, 149] },
    series_a: { big4: [7000, 15000], boutique: [3000, 5000], doaide: [49, 299] },
    series_b: { big4: [10000, 20000], boutique: [4000, 7000], doaide: [99, 499] },
    series_c: { big4: [12000, 25000], boutique: [5000, 10000], doaide: [199, 999] },
  };

  const t = tiers[stage];

  return [
    {
      name: 'Big 4 / advisory firms',
      costRange: t.big4,
      timeline: '4–6 weeks',
      timelineWeeks: [4, 6],
      features: [
        'Established brand recognition',
        'Experienced valuation teams',
        'Long turnaround times',
        'High cost with limited flexibility',
        'Annual engagement model',
      ],
      color: '#6b7280',
    },
    {
      name: 'Boutique valuation firms',
      costRange: t.boutique,
      timeline: '2–4 weeks',
      timelineWeeks: [2, 4],
      features: [
        'Moderate pricing',
        'Personalized service',
        'Varying quality standards',
        'Manual process — slower iterations',
        'May lack audit-defense experience',
      ],
      color: '#8b5cf6',
    },
    {
      name: 'DoAide 409A',
      costRange: t.doaide,
      timeline: '1–7 days',
      timelineWeeks: [0.14, 1],
      features: [
        'AI-powered with analyst review',
        'First draft in 24 hours',
        'IRS safe-harbor qualified',
        'Audit support included',
        'Transparent, per-report pricing',
      ],
      color: '#D4AF37',
      highlight: true,
    },
  ];
}

function formatCost(amount: number): string {
  return amount.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
}

function SavingsCard({ providers }: { providers: ProviderData[] }) {
  const doaide = providers.find((p) => p.highlight);
  const big4 = providers.find((p) => p.name.includes('Big 4'));
  if (!doaide || !big4) return null;

  const costSaving = big4.costRange[0] - doaide.costRange[1];
  const timeSaving = big4.timelineWeeks[0] - doaide.timelineWeeks[1];

  return (
    <div className="rounded-lg border-2 border-bond-500 bg-bond-50 p-5" data-testid="savings-card">
      <h3 className="font-display text-lg font-semibold text-ink-900">Your potential savings</h3>
      <div className="mt-4 grid grid-cols-2 gap-4">
        <div>
          <div className="text-2xl font-bold text-bond-700">{formatCost(costSaving)}+</div>
          <div className="text-xs text-ink-500">cost savings vs Big 4</div>
        </div>
        <div>
          <div className="text-2xl font-bold text-bond-700">{Math.floor(timeSaving)}+ weeks</div>
          <div className="text-xs text-ink-500">faster delivery</div>
        </div>
      </div>
    </div>
  );
}

function ComparisonBar({ provider, maxCost }: { provider: ProviderData; maxCost: number }) {
  const widthPct = (provider.costRange[1] / maxCost) * 100;

  return (
    <div
      className={`rounded-lg border p-5 ${
        provider.highlight
          ? 'border-bond-500 bg-bond-50 shadow-card'
          : 'border-paper-300 bg-surface'
      }`}
      data-testid={`provider-${provider.name.toLowerCase().replace(/[^a-z0-9]/g, '-')}`}
    >
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3
            className={`font-display text-lg font-semibold ${
              provider.highlight ? 'text-bond-700' : 'text-ink-900'
            }`}
          >
            {provider.name}
            {provider.highlight && (
              <span className="ml-2 rounded-full bg-bond-600 px-2 py-0.5 text-xs font-semibold text-bond-fg">
                Best value
              </span>
            )}
          </h3>
          <div className="mt-1 text-sm text-ink-500">Delivery: {provider.timeline}</div>
        </div>
        <div className="text-right">
          <div className={`text-xl font-bold ${provider.highlight ? 'text-bond-700' : 'text-ink-900'}`}>
            {formatCost(provider.costRange[0])}–{formatCost(provider.costRange[1])}
          </div>
        </div>
      </div>

      {/* Cost bar */}
      <div className="mt-3 h-3 rounded-full bg-paper-200">
        <div
          className="h-3 rounded-full transition-all duration-700"
          style={{ width: `${Math.max(widthPct, 2)}%`, backgroundColor: provider.color }}
        />
      </div>

      {/* Features */}
      <ul className="mt-4 grid gap-1.5 sm:grid-cols-2">
        {provider.features.map((f) => (
          <li key={f} className="flex gap-2 text-xs text-ink-600">
            <span style={{ color: provider.color }}>
              {provider.highlight ? '✓' : '·'}
            </span>
            {f}
          </li>
        ))}
      </ul>
    </div>
  );
}

const COST_FAQ: FaqItem[] = [
  {
    q: 'Why is DoAide 409A so much cheaper than traditional providers?',
    a: 'DoAide uses AI to automate the data-intensive parts of the valuation process — financial modeling, comparable selection, and report drafting. A credentialed analyst still reviews and signs every report, but the automation eliminates weeks of manual work.',
  },
  {
    q: 'Is a cheaper 409A valuation less defensible?',
    a: 'No. Price and defensibility are independent. What matters is methodology (using accepted approaches), independence (qualified appraiser), and documentation (thorough report). DoAide reports meet all three criteria and qualify for IRS safe harbor.',
  },
  {
    q: 'What is included in the price?',
    a: 'Every DoAide valuation includes: the full valuation report, analyst review and sign-off, a board resolution template, and ongoing audit support. There are no hidden fees for revisions or auditor inquiries.',
  },
  {
    q: 'Do Big 4 firms charge extra for audit support?',
    a: 'Many traditional providers charge $150–$250/hour for audit support, which can add $1,000–$5,000 to your total cost if your auditor has questions. DoAide includes audit support at no extra charge.',
  },
  {
    q: 'How accurate are these cost estimates?',
    a: 'These ranges are based on published pricing and market research as of 2024–2025. Actual pricing varies by provider, company complexity, and negotiated terms. DoAide pricing shown reflects current list prices.',
  },
];

export function CostComparisonPage() {
  const [stage, setStage] = useState<CompanyStage | null>(null);

  const providers = stage ? getProviders(stage) : null;
  const maxCost = providers ? Math.max(...providers.map((p) => p.costRange[1])) : 0;

  const shareText = providers
    ? `409A Cost Comparison for ${STAGES.find((s) => s.value === stage)?.label}: DoAide from ${formatCost(providers[2]!.costRange[0])} vs Big 4 ${formatCost(providers[0]!.costRange[0])}–${formatCost(providers[0]!.costRange[1])}`
    : undefined;

  return (
    <div className="mx-auto max-w-4xl px-5 py-16">
      <Seo {...pageMeta('/tools/cost-comparison')!} />
      <div className="overline text-ink-400">Free tool</div>
      <h1 className="mt-2 font-display text-4xl font-semibold text-ink-900">
        409A Cost Comparison Calculator
      </h1>
      <p className="mt-3 max-w-2xl text-sm leading-relaxed text-ink-600">
        Compare the cost and timeline of a 409A valuation across provider types — Big 4 advisory
        firms, boutique valuation firms, and AI-powered platforms. Select your company stage to
        see a personalised comparison. Free, instant, no signup required.
      </p>

      {/* Stage selector */}
      <div className="mt-8">
        <label className="text-sm font-semibold text-ink-900">
          Select your company stage
        </label>
        <div className="mt-3 grid gap-3 sm:grid-cols-3 md:grid-cols-5">
          {STAGES.map((s) => (
            <button
              key={s.value}
              type="button"
              onClick={() => setStage(s.value)}
              className={`cursor-pointer rounded-lg border px-4 py-3 text-left transition-colors ${
                stage === s.value
                  ? 'border-bond-600 bg-bond-50 shadow-card'
                  : 'border-paper-300 bg-surface hover:bg-paper-50'
              }`}
              data-testid={`stage-${s.value}`}
            >
              <div className={`text-sm font-semibold ${stage === s.value ? 'text-bond-700' : 'text-ink-900'}`}>
                {s.label}
              </div>
              <div className="mt-0.5 text-xs text-ink-500">{s.employees} employees</div>
            </button>
          ))}
        </div>
      </div>

      {/* Results */}
      {!providers && (
        <div className="mt-10 rounded-lg border border-dashed border-paper-300 p-8 text-center text-sm text-ink-500" data-testid="comparison-result">
          Select your company stage above to see a cost comparison.
        </div>
      )}

      {providers && (
        <div className="mt-10 space-y-6" data-testid="comparison-result">
          <SavingsCard providers={providers} />

          <div className="grid gap-4">
            {/* Show DoAide first (reversed order for visual emphasis) */}
            {[...providers].reverse().map((p) => (
              <ComparisonBar key={p.name} provider={p} maxCost={maxCost} />
            ))}
          </div>

          <ShareResultBar
            title="409A cost comparison"
            text={shareText!}
            emailSubject="409A Valuation Cost Comparison"
            emailLabel="Share with your CFO"
          />

          <div className="flex flex-wrap items-center gap-3">
            <Link
              to="/register"
              className="rounded-md bg-bond-600 px-5 py-2.5 text-sm font-semibold text-bond-fg shadow-card transition-colors hover:bg-bond-700"
            >
              Start your 409A valuation
            </Link>
            <Link to="/pricing" className="text-sm font-semibold text-bond-600 hover:text-bond-700">
              See detailed pricing →
            </Link>
          </div>

          {/* Disclaimer */}
          <p className="rounded-lg border border-paper-200 bg-paper-50 p-4 text-xs leading-relaxed text-ink-500">
            <strong>Disclaimer:</strong> Cost and timeline ranges shown are estimates based on
            published pricing and market research. Actual pricing varies by provider, company
            complexity, engagement scope, and negotiated terms. DoAide pricing reflects current
            list prices and may be subject to change. This tool is for informational purposes
            only and does not constitute a quote or binding offer from any provider.
          </p>
        </div>
      )}

      {/* FAQ section */}
      <section className="mt-14 border-t border-paper-200 pt-10">
        <h2 className="font-display text-2xl font-semibold text-ink-900">
          Frequently asked questions
        </h2>
        <div className="mt-6">
          <FaqAccordion items={COST_FAQ} />
        </div>
      </section>
    </div>
  );
}
