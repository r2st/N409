import { Link } from 'react-router-dom';
import { LogoMark } from '../../components/Logo';
import { Seo } from '../../components/Seo';
import { pageMeta } from '../../lib/pageMeta';

export function LandingPage() {
  return (
    <div className="min-h-screen overflow-hidden bg-chrome-900 text-chrome-fg">
      <Seo {...pageMeta('/')!} />

      {/* Ambient gradient orbs */}
      <div className="pointer-events-none fixed inset-0 overflow-hidden" aria-hidden="true">
        <div className="landing-orb-1 absolute -top-40 -right-40 h-[36rem] w-[36rem] rounded-full bg-bond-600/10 blur-[120px]" />
        <div className="landing-orb-2 absolute -bottom-60 -left-60 h-[44rem] w-[44rem] rounded-full bg-bond-400/8 blur-[140px]" />
        <div className="landing-orb-3 absolute top-1/2 left-1/2 h-[30rem] w-[30rem] -translate-x-1/2 -translate-y-1/2 rounded-full bg-brass-600/5 blur-[100px]" />
      </div>

      {/* Top bar */}
      <header className="landing-fade-in relative z-10">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-5 py-5">
          <Link to="/" className="flex items-center gap-2.5" aria-label="DoAide 409A home">
            <LogoMark size={32} />
            <span className="font-display text-xl font-semibold tracking-tight text-chrome-fg">
              DoAide <em className="font-display italic text-bond-500">409A</em>
            </span>
          </Link>
          <nav className="flex items-center gap-3">
            <Link
              to="/login"
              className="rounded-md px-4 py-2 text-sm font-semibold text-chrome-fg transition-colors hover:text-bond-400"
            >
              Log in
            </Link>
            <Link
              to="/register"
              className="rounded-md bg-bond-600 px-5 py-2 text-sm font-semibold text-bond-fg shadow-lift transition-all hover:bg-bond-500 hover:shadow-[0_0_24px_rgba(240,180,41,0.25)]"
            >
              Get started
            </Link>
          </nav>
        </div>
      </header>

      {/* Hero */}
      <section className="relative z-10 mx-auto max-w-6xl px-5 pt-16 pb-20 sm:pt-24 sm:pb-28 lg:pt-32 lg:pb-36">
        <div className="landing-slide-up flex flex-col items-center text-center">
          <div className="landing-scale-in mb-8 flex h-20 w-20 items-center justify-center rounded-2xl border border-chrome-700 bg-chrome-800/80 shadow-[0_0_40px_rgba(240,180,41,0.12)] backdrop-blur sm:h-24 sm:w-24">
            <LogoMark size={52} />
          </div>

          <div className="overline landing-fade-in-delay-1 mb-4 tracking-[0.22em] text-brass-400">
            Independent · Defensible · Audit-ready
          </div>

          <h1 className="landing-fade-in-delay-2 max-w-3xl font-display text-4xl leading-[1.1] font-medium sm:text-5xl lg:text-6xl">
            AI-powered{' '}
            <span className="text-bond-400">409A</span>{' '}
            valuations for startups
          </h1>

          <p className="landing-fade-in-delay-3 mt-6 max-w-xl text-lg leading-relaxed text-chrome-dim sm:text-xl">
            Automated equity valuations. Compliance-ready reports.
            First draft in 24&nbsp;hours — dual-signed and audit-defensible.
          </p>

          {/* CTA buttons */}
          <div className="landing-fade-in-delay-4 mt-10 flex flex-col items-center gap-4 sm:flex-row">
            <Link
              to="/register"
              className="group relative inline-flex items-center gap-2 rounded-lg bg-bond-600 px-8 py-3.5 text-base font-semibold text-bond-fg shadow-lift transition-all hover:bg-bond-500 hover:shadow-[0_0_32px_rgba(240,180,41,0.3)]"
            >
              <span>Start my valuation</span>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="transition-transform group-hover:translate-x-0.5" aria-hidden="true">
                <path d="M5 12h14M12 5l7 7-7 7" />
              </svg>
            </Link>
            <Link
              to="/login"
              className="inline-flex items-center gap-2 rounded-lg border border-chrome-600 bg-chrome-800/50 px-8 py-3.5 text-base font-semibold text-chrome-fg shadow-card backdrop-blur transition-all hover:border-bond-600/40 hover:bg-chrome-700/60"
            >
              Sign in to your account
            </Link>
          </div>

          <p className="landing-fade-in-delay-5 mt-5 text-xs text-chrome-faint">
            No credit card required · Pay only when your report is ready
          </p>
        </div>
      </section>

      {/* Feature cards */}
      <section className="relative z-10 mx-auto max-w-6xl px-5 pb-24">
        <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map((f, i) => (
            <div
              key={f.title}
              className={`landing-card-${i + 1} rounded-xl border border-chrome-700/60 bg-chrome-800/40 p-7 backdrop-blur transition-all hover:border-bond-600/30 hover:bg-chrome-800/60`}
            >
              <div className="mb-4 flex h-11 w-11 items-center justify-center rounded-lg bg-bond-600/10 text-bond-400">
                {f.icon}
              </div>
              <h3 className="font-display text-lg font-semibold text-chrome-fg">{f.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-chrome-dim">{f.body}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Bottom CTA */}
      <section className="relative z-10 border-t border-chrome-700/40">
        <div className="landing-fade-in-bottom mx-auto max-w-6xl px-5 py-16 text-center">
          <h2 className="font-display text-2xl font-semibold text-chrome-fg sm:text-3xl">
            Price your equity with confidence
          </h2>
          <p className="mx-auto mt-3 max-w-md text-sm text-chrome-dim">
            Join hundreds of startups that trust DoAide 409A for compliant, defensible valuations.
          </p>
          <div className="mt-8 flex flex-wrap items-center justify-center gap-4">
            <Link
              to="/register"
              className="rounded-lg bg-bond-600 px-7 py-3 text-sm font-semibold text-bond-fg shadow-lift transition-all hover:bg-bond-500 hover:shadow-[0_0_24px_rgba(240,180,41,0.25)]"
            >
              Create free account
            </Link>
            <Link
              to="/pricing"
              className="text-sm font-semibold text-chrome-fg transition-colors hover:text-bond-400"
            >
              See pricing →
            </Link>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="relative z-10 border-t border-chrome-700/40 bg-chrome-950/50">
        <div className="mx-auto flex max-w-6xl flex-col items-center gap-4 px-5 py-6 text-xs text-chrome-faint sm:flex-row sm:justify-between">
          <span>© {new Date().getFullYear()} <a href="https://doaide.com" target="_blank" rel="noopener noreferrer" className="transition-colors hover:text-chrome-fg">DoAide</a> · AI tools for small businesses</span>
          <nav className="flex flex-wrap justify-center gap-x-4 gap-y-1 font-mono text-[10px] uppercase tracking-[0.14em]" aria-label="DoAide products">
            <a href="https://desk.doaide.com" target="_blank" rel="noopener noreferrer" className="transition-colors hover:text-chrome-fg">Desk</a>
            <a href="https://herald.doaide.com" target="_blank" rel="noopener noreferrer" className="transition-colors hover:text-chrome-fg">Herald</a>
            <span className="text-brass-400">409A</span>
            <a href="https://job.doaide.com" target="_blank" rel="noopener noreferrer" className="transition-colors hover:text-chrome-fg">AutoApply</a>
            <a href="https://homenex.doaide.com" target="_blank" rel="noopener noreferrer" className="transition-colors hover:text-chrome-fg">Realty</a>
          </nav>
        </div>
      </footer>
    </div>
  );
}

const FEATURES = [
  {
    title: 'AI-driven analysis',
    body: 'Machine-learning models process your financials and cap table to produce a defensible fair market value — no spreadsheet gymnastics.',
    icon: (
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M12 2a4 4 0 0 0-4 4v2H6a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V10a2 2 0 0 0-2-2h-2V6a4 4 0 0 0-4-4z" />
        <circle cx="12" cy="15" r="2" />
      </svg>
    ),
  },
  {
    title: 'Compliance-ready reports',
    body: 'Dual-signed, audit-defensible 409A reports that satisfy IRC §409A safe-harbor requirements. Board-ready from day one.',
    icon: (
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M9 12l2 2 4-4" />
        <path d="M4 6h16v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6z" />
        <path d="M4 6l2-2h12l2 2" />
      </svg>
    ),
  },
  {
    title: '24-hour turnaround',
    body: 'Upload your documents, answer a few questions, and receive your first draft within 24 hours — not weeks.',
    icon: (
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <circle cx="12" cy="12" r="10" />
        <path d="M12 6v6l4 2" />
      </svg>
    ),
  },
  {
    title: 'Cap table integration',
    body: 'Import your cap table directly. Options, SAFEs, convertible notes — all equity instruments modelled automatically.',
    icon: (
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <rect x="3" y="3" width="18" height="18" rx="2" />
        <path d="M3 9h18M9 3v18" />
      </svg>
    ),
  },
  {
    title: 'Flat pricing',
    body: 'One price per report. No subscription, no hidden fees, no hourly billing. Pay only when your valuation is ready.',
    icon: (
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />
      </svg>
    ),
  },
  {
    title: 'Accounting integrations',
    body: 'Pull financials from QuickBooks, Xero, FreshBooks and more — no spreadsheets, no re-typing.',
    icon: (
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" />
      </svg>
    ),
  },
];
