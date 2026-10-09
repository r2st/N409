import { Link } from 'react-router-dom';
import { CrossProductLinks } from '../../components/CrossProductLinks';
import { Seo } from '../../components/Seo';
import { pageMeta } from '../../lib/pageMeta';

const FREE_TOOLS = [
  {
    title: '409A Valuation Calculator',
    description:
      'Estimate a range for your common stock from a priced round, capital raised, revenue or profit. No signup required.',
    path: '/tools/409a-valuation-calculator',
    icon: (
      <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
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
    title: 'Safe Harbor Compliance Checker',
    description:
      'Answer five questions to check whether your 409A valuation is current and meets IRS safe harbor requirements. Instant results.',
    path: '/tools/409a-compliance-checker',
    icon: (
      <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
        <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
        <path d="M9 12l2 2 4-4" />
      </svg>
    ),
  },
  {
    title: 'Startup Valuation Estimator',
    description:
      'Enter revenue, growth rate, industry, and funding stage to estimate your company\'s fair market value and 409A common stock range.',
    path: '/tools/startup-valuation-estimator',
    icon: (
      <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
        <path d="M3 3v18h18" />
        <path d="M7 16l4-6 4 3 5-7" />
      </svg>
    ),
  },
  {
    title: 'Stock Option Tax Calculator',
    description:
      'Estimate tax implications of exercising ISOs and NSOs, AMT exposure, and cost basis. Free, no signup required.',
    path: '/tools/stock-option-tax-calculator',
    icon: (
      <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
        <circle cx="12" cy="12" r="10" />
        <path d="M12 6v12M9 9c0-1.5 1.3-3 3-3s3 1.5 3 3c0 2-3 2.5-3 4M12 17h.01" />
      </svg>
    ),
  },
  {
    title: 'Valuation Readiness Checker',
    description:
      'Answer 10 questions about your startup to get a readiness score, missing-items checklist, and estimated timeline. No signup required.',
    path: '/tools/readiness-checker',
    icon: (
      <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
        <path d="M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2" />
        <rect x="9" y="3" width="6" height="4" rx="1" />
        <path d="M9 14l2 2 4-4" />
      </svg>
    ),
  },
  {
    title: '409A Cost Comparison Calculator',
    description:
      'Compare cost and timeline of Big 4 firms, boutique providers, and AI-powered platforms for your company stage. Free, instant.',
    path: '/tools/cost-comparison',
    icon: (
      <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
        <rect x="3" y="12" width="4" height="9" rx="1" />
        <rect x="10" y="8" width="4" height="13" rx="1" />
        <rect x="17" y="3" width="4" height="18" rx="1" />
      </svg>
    ),
  },
  {
    title: '409A Deadline Tracker',
    description:
      'Key 409A deadlines and compliance reminders. Embeddable on your site — perfect for accelerators, law firms, and startup blogs.',
    path: '/tools/deadline-widget',
    icon: (
      <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
        <rect x="3" y="4" width="18" height="18" rx="2" />
        <path d="M16 2v4M8 2v4M3 10h18" />
        <path d="M8 14h.01M12 14h.01M16 14h.01M8 18h.01M12 18h.01" />
      </svg>
    ),
  },
];

export function FreeToolsPage() {
  return (
    <div className="mx-auto max-w-5xl px-5 py-16">
      <Seo {...pageMeta('/free-tools')!} />
      <div className="overline text-ink-400">Free tools</div>
      <h1 className="mt-2 font-display text-4xl font-semibold text-ink-900">
        Free 409A tools for startups
      </h1>
      <p className="mt-4 max-w-2xl text-sm leading-relaxed text-ink-600">
        Everything you need to understand your 409A valuation — calculators, compliance checkers, and
        estimators. No signup, no email gate, completely free.
      </p>

      <div className="mt-10 grid gap-6 sm:grid-cols-2">
        {FREE_TOOLS.map((tool) => (
          <Link
            key={tool.path}
            to={tool.path}
            className="group rounded-lg border border-paper-300 bg-surface p-6 shadow-card transition-shadow hover:shadow-lift"
          >
            <div className="flex items-start gap-4">
              <div className="shrink-0 text-bond-600">{tool.icon}</div>
              <div>
                <h2 className="font-display text-lg font-semibold text-ink-900 group-hover:text-bond-700">
                  {tool.title}
                </h2>
                <p className="mt-2 text-sm leading-relaxed text-ink-600">{tool.description}</p>
                <span className="mt-3 inline-block text-sm font-semibold text-bond-600 group-hover:text-bond-700">
                  Try free →
                </span>
              </div>
            </div>
          </Link>
        ))}
      </div>

      <div className="mt-14 rounded-lg border border-bond-200 bg-bond-50 p-6">
        <h2 className="font-display text-xl font-semibold text-ink-900">
          Need a full 409A valuation?
        </h2>
        <p className="mt-2 text-sm leading-relaxed text-ink-600">
          Our free tools give you a starting point. When you are ready for an audit-defensible,
          analyst-signed report, start a valuation — first draft in 24 hours, from $49.
        </p>
        <div className="mt-5 flex flex-wrap items-center gap-4">
          <Link
            to="/register"
            className="rounded-md bg-bond-600 px-5 py-2.5 text-sm font-semibold text-bond-fg shadow-card transition-colors hover:bg-bond-700"
          >
            Start a valuation
          </Link>
          <Link to="/pricing" className="text-sm font-semibold text-bond-600 hover:text-bond-700">
            See pricing →
          </Link>
        </div>
      </div>

      <CrossProductLinks page="free-tools" />
    </div>
  );
}
