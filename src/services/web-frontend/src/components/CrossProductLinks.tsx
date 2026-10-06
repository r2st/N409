const LINKS: Record<string, { href: string; label: string; text: string }[]> = {
  pricing: [
    {
      href: 'https://contracts.doaide.com',
      label: 'Contract Generator',
      text: 'Need legal documents for your startup? Generate NDAs, SAFEs, and employment agreements',
    },
    {
      href: 'https://fincalc.doaide.com',
      label: 'Financial Calculators',
      text: "Calculate your startup's runway, burn rate, and dilution scenarios",
    },
  ],
  valuation: [
    {
      href: 'https://contracts.doaide.com',
      label: 'Contract Generator',
      text: 'Draft SAFE agreements, convertible notes, and equity compensation plans',
    },
    {
      href: 'https://fincalc.doaide.com',
      label: 'Financial Calculators',
      text: 'Model cap table scenarios and calculate dilution from your next round',
    },
    {
      href: 'https://comply.doaide.com',
      label: 'Compliance Tracker',
      text: 'Track 409A renewal deadlines alongside your other compliance obligations',
    },
  ],
  tax: [
    {
      href: 'https://fincalc.doaide.com',
      label: 'Financial Calculators',
      text: 'Run more financial scenarios — EMI, investment returns, and retirement planning',
    },
    {
      href: 'https://salary.doaide.com',
      label: 'Salary Calculator',
      text: 'Calculate take-home pay including stock option compensation',
    },
  ],
  'free-tools': [
    {
      href: 'https://gst.doaide.com',
      label: 'GST Bot',
      text: 'Free GST calculator, GSTIN verification, and HSN code lookup for Indian businesses',
    },
    {
      href: 'https://contracts.doaide.com',
      label: 'Contract Generator',
      text: 'AI-powered contract drafting — NDAs, service agreements, and employment contracts',
    },
    {
      href: 'https://resume.doaide.com',
      label: 'Resume Builder',
      text: 'Build a professional resume with AI-powered suggestions',
    },
  ],
};

export function CrossProductLinks({ page }: { page: string }) {
  const items = LINKS[page];
  if (!items) return null;

  return (
    <aside className="mt-12 border-t border-paper-200 pt-8" aria-label="Explore more DoAide tools">
      <h3 className="mb-4 font-display text-lg font-semibold text-ink-900">
        Explore More Tools
      </h3>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {items.map((link) => (
          <a
            key={link.href}
            href={link.href}
            target="_blank"
            rel="noopener noreferrer"
            className="group flex flex-col gap-1 rounded-lg border border-paper-300 bg-surface p-4 no-underline transition-all hover:border-bond-400 hover:shadow-card"
          >
            <strong className="text-sm text-bond-600 group-hover:text-bond-700">
              {link.label} <span className="text-xs text-ink-300">↗</span>
            </strong>
            <span className="text-xs leading-relaxed text-ink-500">
              {link.text}
            </span>
          </a>
        ))}
      </div>
    </aside>
  );
}
