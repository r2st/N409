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
    <section className="border-t border-chrome-200 bg-chrome-50 px-5 py-8 dark:border-chrome-800 dark:bg-chrome-900/50" aria-label="More free tools from DoAide">
      <div className="mx-auto max-w-5xl">
        <p className="mb-4 text-xs font-semibold uppercase tracking-widest text-chrome-500">
          More free tools from DoAide
        </p>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          {TOOLS.map((t) => (
            <a
              key={t.url}
              href={t.url}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-start gap-2 rounded-lg border border-chrome-200 bg-white px-3 py-3 text-left no-underline transition-colors hover:border-brass-400 dark:border-chrome-700 dark:bg-chrome-800 dark:hover:border-brass-500"
            >
              <span className="text-lg leading-none">{t.icon}</span>
              <span>
                <strong className="block text-sm text-ink-900 dark:text-chrome-fg">{t.name}</strong>
                <span className="text-xs text-chrome-500">{t.desc}</span>
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
