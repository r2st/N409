import { Link } from 'react-router-dom';
import { Seo } from '../../components/Seo';
import { pageMeta } from '../../lib/pageMeta';

const TOOLS = [
  {
    title: '409A Valuation Calculator',
    description: 'Estimate a range for your common stock from a priced round, capital raised, revenue or profit.',
    path: '/tools/409a-valuation-calculator',
    icon: (
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
        <rect x="4" y="2" width="16" height="20" rx="2" />
        <line x1="8" y1="6" x2="16" y2="6" />
        <line x1="8" y1="10" x2="11" y2="10" />
        <line x1="13" y1="10" x2="16" y2="10" />
        <line x1="8" y1="14" x2="11" y2="14" />
        <line x1="13" y1="14" x2="16" y2="14" />
        <line x1="8" y1="18" x2="11" y2="18" />
        <line x1="13" y1="18" x2="16" y2="18" />
      </svg>
    ),
  },
  {
    title: 'Stock Option Tax Calculator',
    description: 'Estimate tax implications of exercising stock options — ISO vs NSO, AMT exposure, cost basis.',
    path: '/tools/stock-option-tax-calculator',
    icon: (
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
        <circle cx="12" cy="12" r="10" />
        <path d="M12 6v12M9 9c0-1.5 1.3-3 3-3s3 1.5 3 3c0 2-3 2.5-3 4M12 17h.01" />
      </svg>
    ),
  },
  {
    title: '409A Compliance Checker',
    description: 'Answer five questions to check if your 409A valuation is current and compliant with IRS safe harbor.',
    path: '/tools/409a-compliance-checker',
    icon: (
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
        <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
        <path d="M9 12l2 2 4-4" />
      </svg>
    ),
  },
  {
    title: 'Startup Valuation Estimator',
    description: 'Estimate your startup\'s fair market value from revenue, growth rate, industry, and funding stage.',
    path: '/tools/startup-valuation-estimator',
    icon: (
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
        <path d="M3 3v18h18" />
        <path d="M7 16l4-6 4 3 5-7" />
      </svg>
    ),
  },
];

const GUIDES = [
  {
    title: 'The 409A Valuation Guide',
    description: 'What a 409A valuation is, why safe harbor matters, and how the value is derived.',
    path: '/409a-valuation-guide',
  },
  {
    title: 'When Do You Need a 409A?',
    description: 'The four events that trigger a 409A requirement and what happens without one.',
    path: '/when-do-you-need-a-409a',
  },
  {
    title: '409A Valuation Methods Explained',
    description: 'The market, income, and asset approaches — how they work and when each applies.',
    path: '/409a-valuation-methods',
  },
  {
    title: 'How Much Does a 409A Cost?',
    description: 'Market price bands, what drives cost, and how DoAide 409A compares.',
    path: '/how-much-does-a-409a-cost',
  },
  {
    title: '409A Cost Comparison: Big 4 vs Boutique vs Automated',
    description: 'Side-by-side comparison of 409A providers — pricing, turnaround, and trade-offs.',
    path: '/409a-valuation-cost-comparison',
  },
  {
    title: 'Which Valuation Do You Need?',
    description: 'A quick quiz to find the right valuation report for your situation.',
    path: '/which-valuation',
  },
  {
    title: 'Sample 409A Report',
    description: 'See exactly what a defensible 409A valuation report contains.',
    path: '/sample-report',
  },
];

export function ResourcesPage() {
  return (
    <div className="mx-auto max-w-5xl px-5 py-16">
      <Seo {...pageMeta('/resources')!} />
      <div className="overline text-ink-400">Resources</div>
      <h1 className="mt-2 font-display text-4xl font-semibold text-ink-900">409A Resources & Tools</h1>
      <p className="mt-3 max-w-2xl text-sm leading-relaxed text-ink-600">
        Free tools, guides, and educational content to help you understand 409A valuations,
        stock option taxation, and compliance requirements.
      </p>

      <section className="mt-12">
        <h2 className="font-display text-2xl font-semibold text-ink-900">Free Tools</h2>
        <p className="mt-2 text-sm text-ink-600">No signup required. Use them right now.</p>
        <div className="mt-6 grid gap-4 md:grid-cols-3">
          {TOOLS.map((tool) => (
            <Link
              key={tool.path}
              to={tool.path}
              className="group rounded-lg border border-paper-300 bg-surface p-5 shadow-card transition-all hover:border-bond-300 hover:shadow-lift"
            >
              <div className="text-bond-600">{tool.icon}</div>
              <h3 className="mt-3 font-display text-lg font-semibold text-ink-900 group-hover:text-bond-700">
                {tool.title}
              </h3>
              <p className="mt-1 text-sm leading-relaxed text-ink-600">{tool.description}</p>
              <span className="mt-3 inline-block text-sm font-semibold text-bond-600 group-hover:text-bond-700">
                Try it free →
              </span>
            </Link>
          ))}
        </div>
      </section>

      <section className="mt-14">
        <h2 className="font-display text-2xl font-semibold text-ink-900">Guides & Education</h2>
        <p className="mt-2 text-sm text-ink-600">
          Everything you need to know about 409A valuations, written by valuation professionals.
        </p>
        <div className="mt-6 grid gap-3">
          {GUIDES.map((guide) => (
            <Link
              key={guide.path}
              to={guide.path}
              className="group flex items-center gap-4 rounded-lg border border-paper-300 bg-surface p-4 transition-all hover:border-bond-300 hover:shadow-card"
            >
              <div className="flex-1">
                <h3 className="text-sm font-semibold text-ink-900 group-hover:text-bond-700">
                  {guide.title}
                </h3>
                <p className="mt-0.5 text-sm text-ink-600">{guide.description}</p>
              </div>
              <span className="shrink-0 text-sm font-semibold text-bond-600 group-hover:text-bond-700">
                Read →
              </span>
            </Link>
          ))}
        </div>
      </section>

      <section className="mt-14">
        <h2 className="font-display text-2xl font-semibold text-ink-900">From the Blog</h2>
        <p className="mt-2 text-sm text-ink-600">
          Notes on 409A and fair-value practice from the DoAide 409A team.
        </p>
        <div className="mt-4">
          <Link
            to="/blog"
            className="inline-flex items-center gap-2 text-sm font-semibold text-bond-600 hover:text-bond-700"
          >
            Browse all articles →
          </Link>
        </div>
      </section>

      <section className="mt-14">
        <h2 className="font-display text-2xl font-semibold text-ink-900">Compare Providers</h2>
        <p className="mt-2 text-sm text-ink-600">
          See how DoAide 409A stacks up against traditional valuation providers.
        </p>
        <div className="mt-4 flex flex-wrap gap-3">
          <Link
            to="/compare/409a-valuation-providers"
            className="rounded-md bg-bond-600 px-5 py-2.5 text-sm font-semibold text-bond-fg shadow-card transition-colors hover:bg-bond-700"
          >
            Compare all providers
          </Link>
          <Link
            to="/pricing"
            className="rounded-md border border-paper-300 bg-surface px-5 py-2.5 text-sm font-semibold text-ink-700 shadow-card transition-colors hover:bg-paper-50"
          >
            View pricing
          </Link>
        </div>
      </section>
    </div>
  );
}
