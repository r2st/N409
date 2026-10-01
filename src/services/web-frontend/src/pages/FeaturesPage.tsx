import { Link } from 'react-router-dom';
import { HELP_CATEGORIES, primaryArticleForCategory } from '../data/helpContent';

/**
 * Features showcase — every platform capability, grouped and linked into the
 * Help Center. Each card reads its title and description straight from the
 * shared help content so the two never drift apart.
 */

const EMOJI: Record<string, string> = {
  dashboard: '📊',
  valuations: '📁',
  methodology: '🧮',
  'cap-table': '🧾',
  comparables: '🏢',
  financials: '💹',
  assumptions: '🎛️',
  'ai-agents': '🤖',
  reports: '📄',
  'board-approval': '✍️',
  grants: '🎯',
  'health-checks': '🩺',
  sensitivity: '📈',
  pwerm: '🎲',
  'value-bridge': '🌉',
  'client-portal': '🤝',
  engagement: '🔄',
  mfa: '🔐',
  monitoring: '🛰️',
  organizations: '🏛️',
  billing: '💳',
  'auditor-portal': '🔎',
  sso: '🪪',
  'data-retention': '🗄️',
  hris: '👥',
  settings: '⚙️',
  'asc718-public': '📐',
  'fund-holdings': '🏦',
  'debt-valuation': '💵',
};

const SECTIONS: Array<{ title: string; blurb: string; categories: string[] }> = [
  {
    title: 'Build a valuation',
    blurb: 'Everything that goes into estimating a defensible fair market value.',
    categories: [
      'valuations',
      'cap-table',
      'financials',
      'comparables',
      'methodology',
      'pwerm',
      'assumptions',
    ],
  },
  {
    title: 'Automation & quality',
    blurb: 'Let the platform do the heavy lifting and catch mistakes early.',
    categories: ['ai-agents', 'health-checks', 'sensitivity', 'value-bridge', 'monitoring'],
  },
  {
    title: 'Deliver & approve',
    blurb: 'Turn the result into an audit-ready, board-adopted deliverable.',
    categories: ['reports', 'board-approval', 'auditor-portal', 'grants'],
  },
  {
    title: 'Specialized valuation engines',
    blurb: 'Purpose-built engines beyond the core 409A: public-company stock comp, fund holdings and debt.',
    categories: ['asc718-public', 'fund-holdings', 'debt-valuation'],
  },
  {
    title: 'Collaborate',
    blurb: 'Give clients, partners and teams the right view of the work.',
    categories: ['dashboard', 'client-portal', 'engagement', 'organizations'],
  },
  {
    title: 'Account & security',
    blurb: 'Enterprise-grade controls for access, billing and compliance.',
    categories: ['mfa', 'sso', 'data-retention', 'hris', 'billing', 'settings'],
  },
];

function FeatureCard({ categoryId }: { categoryId: string }) {
  const cat = HELP_CATEGORIES.find((c) => c.id === categoryId);
  if (!cat) return null;
  const primary = primaryArticleForCategory(categoryId);
  return (
    <div className="flex flex-col rounded-lg border border-paper-300 bg-surface p-5 shadow-card">
      <div className="text-2xl" aria-hidden>
        {EMOJI[categoryId] ?? '•'}
      </div>
      <h3 className="mt-3 font-display text-base font-semibold text-ink-900">{cat.label}</h3>
      <p className="mt-1 flex-1 text-sm leading-relaxed text-ink-500">{cat.blurb}</p>
      {primary && (
        <Link
          to={`/help/${primary.id}`}
          className="mt-3 text-sm font-semibold text-bond-600 hover:text-bond-700"
        >
          Learn more →
        </Link>
      )}
    </div>
  );
}

export function FeaturesPage() {
  return (
    <div className="max-w-5xl">
      <div className="overline text-ink-400">Platform</div>
      <h1 className="mt-1 font-display text-3xl font-semibold text-ink-900">Features</h1>
      <p className="mt-2 max-w-2xl text-sm text-ink-500">
        Everything DoAide 409A does, from building a valuation to delivering an audit-ready report and running an
        enterprise account. Follow any <span className="font-semibold">Learn more</span> link to the full
        guide in the{' '}
        <Link to="/help" className="font-semibold text-bond-600 hover:text-bond-700">
          Help Center
        </Link>
        .
      </p>

      <div className="mt-10 space-y-12">
        {SECTIONS.map((section) => (
          <section key={section.title}>
            <h2 className="font-display text-xl font-semibold text-ink-900">{section.title}</h2>
            <p className="mt-1 text-sm text-ink-500">{section.blurb}</p>
            <div className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {section.categories.map((id) => (
                <FeatureCard key={id} categoryId={id} />
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
