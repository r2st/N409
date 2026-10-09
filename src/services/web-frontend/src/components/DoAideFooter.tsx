const TOOLS = [
  { icon: '\u{1F4C4}', name: 'Docs', url: 'https://docs.doaide.com', desc: 'Free document generators' },
  { icon: '\u{1F4DD}', name: 'Resume', url: 'https://resume.doaide.com', desc: 'AI resume builder' },
  { icon: '\u{1F3F7}️', name: 'GST Bot', url: 'https://gst.doaide.com', desc: 'GST filing & compliance' },
  { icon: '\u{1F6E1}️', name: 'InsureKit', url: 'https://insure.doaide.com', desc: 'Insurance calculators' },
  { icon: '\u{1F4B0}', name: 'TaxFile', url: 'https://tax.doaide.com', desc: 'Tax & financial calculators' },
  { icon: '\u{1F4C8}', name: 'Pulse', url: 'https://pulse.doaide.com', desc: 'Newsletter growth tools' },
  { icon: '\u{1F9FE}', name: 'Invoicer', url: 'https://invoicer.doaide.com', desc: 'GST invoices in seconds' },
  { icon: '\u{1F4DD}', name: 'Contracts', url: 'https://contracts.doaide.com', desc: 'Business contracts' },
  { icon: '\u{1F3E0}', name: 'HomeNex', url: 'https://homenex.aiknol.com', desc: 'AI CRM for real estate' },
];

export function DoAideFooter() {
  return (
    <section className="border-t border-paper-300 bg-paper-100 px-5 py-8" aria-label="More free tools from DoAide">
      <div className="mx-auto max-w-5xl">
        <p className="mb-4 text-xs font-semibold uppercase tracking-widest text-ink-500">
          More free tools from DoAide
        </p>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          {TOOLS.map((t) => (
            <a
              key={t.url}
              href={t.url}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-start gap-2 rounded-lg border border-paper-300 bg-surface px-3 py-3 text-left no-underline transition-colors hover:border-brass-400"
            >
              <span className="text-lg leading-none">{t.icon}</span>
              <span>
                <strong className="block text-sm text-ink-900">{t.name}</strong>
                <span className="text-xs text-ink-500">{t.desc}</span>
              </span>
            </a>
          ))}
        </div>
        <p className="mt-4 text-xs">
          <a href="https://doaide.com" target="_blank" rel="noopener noreferrer" className="text-brass-500 no-underline hover:underline">
            View all 40+ tools &rarr;
          </a>
        </p>
      </div>
    </section>
  );
}
