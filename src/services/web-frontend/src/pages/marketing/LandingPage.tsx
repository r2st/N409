import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ACCOUNTING_PROVIDERS,
  HERO_KINDS,
  HOW_IT_WORKS,
  PRODUCTS,
  STATS,
  formatUsd,
} from '../../lib/marketing';
import { BookACallSection, PartnerLogos, ProofSection, TestimonialsSection } from './MarketingSections';
import { Seo } from '../../components/Seo';
import { pageMeta } from '../../lib/pageMeta';

/** Longest hero word — sizes the rotator slot so the headline never reflows. */
const WIDEST_HERO_KIND = HERO_KINDS.reduce((a, b) => (b.length > a.length ? b : a));

/** Public landing page (409.ai §22.3). */
export function LandingPage() {
  const [heroIndex, setHeroIndex] = useState(0);

  useEffect(() => {
    // Honour prefers-reduced-motion: the headline settles on "409A" — the term
    // that carries the page's search intent anyway — instead of cycling.
    const reduced =
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduced) return;
    const t = setInterval(() => setHeroIndex((i) => (i + 1) % HERO_KINDS.length), 2600);
    return () => clearInterval(t);
  }, []);

  const minPriceCents = Math.min(...PRODUCTS.map((p) => p.priceCents));

  return (
    <div>
      <Seo {...pageMeta('/')!} />
      {/* Hero */}
      <section className="ledger-grid relative overflow-hidden bg-chrome-900 text-chrome-fg">
        <div className="mx-auto max-w-6xl px-5 py-24 lg:py-32">
          <div className="overline mb-6 text-brass-400">Independent · Defensible · Audit-ready</div>
          <h1 className="max-w-3xl font-display text-4xl leading-[1.1] font-medium sm:text-6xl">
            Easier{' '}
            {/* The rotating word sits in a slot sized to the longest option, so
                swapping it never reflows the headline (cumulative layout shift
                is a Core Web Vital and this is the LCP element). */}
            <span className="relative inline-grid align-bottom">
              <span aria-hidden="true" className="invisible col-start-1 row-start-1">
                {WIDEST_HERO_KIND}
              </span>
              <span className="col-start-1 row-start-1 justify-self-start text-brass-300 underline decoration-bond-500 decoration-2 underline-offset-8">
                {HERO_KINDS[heroIndex]}
              </span>
            </span>
            <br />
            valuations.
          </h1>
          <p className="mt-7 max-w-xl text-lg leading-relaxed text-chrome-dim">
            First draft in 24 hours. Dual-signed. From {formatUsd(minPriceCents)} flat.
          </p>
          <div className="mt-9 flex flex-wrap items-center gap-4">
            <Link
              to="/register"
              className="rounded-md bg-bond-600 px-6 py-3 text-sm font-semibold text-bond-fg shadow-lift transition-colors hover:bg-bond-700"
            >
              Start my valuation
            </Link>
            <Link to="/which-valuation" className="text-sm font-semibold text-chrome-fg hover:text-brass-300">
              Not sure which report? Take the quiz →
            </Link>
          </div>
          <div className="mt-6 flex flex-wrap gap-x-5 gap-y-2 text-xs text-chrome-faint">
            <span>✓ No credit card required</span>
            <span>✓ No subscription — one flat price per report</span>
          </div>
        </div>
        <div className="pointer-events-none absolute -right-40 -bottom-40 h-[28rem] w-[28rem] rounded-full bg-bond-700/25 blur-3xl" />
      </section>

      {/* Stats */}
      <section className="border-b border-paper-300 bg-paper-100">
        <div className="mx-auto grid max-w-6xl gap-8 px-5 py-12 sm:grid-cols-3">
          {STATS.map((s) => (
            <div key={s.label} className="text-center">
              <div className="tnum font-display text-5xl font-semibold text-bond-600">{s.value}</div>
              <div className="overline mt-2 text-ink-400">{s.label}</div>
            </div>
          ))}
        </div>
      </section>

      {/* Partner logos (gap #21) */}
      <PartnerLogos />

      {/* Why */}
      <section className="mx-auto max-w-6xl px-5 py-20">
        <div className="overline text-ink-400">Do I need a valuation?</div>
        <h2 className="mt-2 max-w-2xl font-display text-3xl font-semibold text-ink-900">
          If you grant options, report fair value, or transfer shares — yes.
        </h2>
        <div className="mt-10 grid gap-8 md:grid-cols-3">
          <div>
            <h3 className="font-display text-lg font-semibold text-ink-900">Price options safely</h3>
            <p className="mt-2 text-sm leading-relaxed text-ink-600">
              Safe-harbor protection for every grant.
            </p>
          </div>
          <div>
            <h3 className="font-display text-lg font-semibold text-ink-900">Survive the audit</h3>
            <p className="mt-2 text-sm leading-relaxed text-ink-600">
              Full methodology, inputs, and evidence bundle — end to end.
            </p>
          </div>
          <div>
            <h3 className="font-display text-lg font-semibold text-ink-900">Protect the company</h3>
            <p className="mt-2 text-sm leading-relaxed text-ink-600">
              Remove mispricing risk before diligence finds it.
            </p>
          </div>
        </div>
      </section>

      {/* How it works */}
      <section className="border-y border-paper-300 bg-surface">
        <div className="mx-auto max-w-6xl px-5 py-20">
          <div className="overline text-ink-400">How it works</div>
          <h2 className="mt-2 font-display text-3xl font-semibold text-ink-900">Three simple steps</h2>
          <div className="mt-10 grid gap-8 md:grid-cols-3">
            {HOW_IT_WORKS.map((s) => (
              <div key={s.step} className="rounded-lg border border-paper-300 bg-paper-50 p-6">
                <div className="tnum font-display text-3xl font-semibold text-brass-400">{s.step}</div>
                <h3 className="mt-3 font-display text-lg font-semibold text-ink-900">{s.title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-ink-600">{s.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Integrations */}
      <section className="mx-auto max-w-6xl px-5 py-20">
        <div className="overline text-ink-400">Integrations</div>
        <h2 className="mt-2 max-w-2xl font-display text-3xl font-semibold text-ink-900">
          Save hours of work with accounting integrations
        </h2>
        <p className="mt-3 max-w-xl text-sm leading-relaxed text-ink-600">
          Pull financials directly — no spreadsheets, no re-typing.
        </p>
        <div className="mt-8 flex flex-wrap gap-3">
          {ACCOUNTING_PROVIDERS.map((name) => (
            <span
              key={name}
              className="rounded-full border border-paper-300 bg-surface px-5 py-2.5 text-sm font-semibold text-ink-700 shadow-card"
            >
              {name}
            </span>
          ))}
        </div>
      </section>

      {/* Products strip */}
      <section className="border-y border-paper-300 bg-surface">
        <div className="mx-auto max-w-6xl px-5 py-20">
          <div className="overline text-ink-400">Products</div>
          <h2 className="mt-2 font-display text-3xl font-semibold text-ink-900">
            Thirteen report types, one platform
          </h2>
          <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {PRODUCTS.map((p) => (
              <Link
                key={p.slug}
                to={`/products/${p.slug}`}
                className="group rounded-lg border border-paper-300 bg-paper-50 p-5 transition-shadow hover:shadow-lift"
              >
                <div className="flex items-baseline justify-between">
                  <h3 className="font-display text-base font-semibold text-ink-900 group-hover:text-bond-700">
                    {p.name}
                  </h3>
                  <span className="tnum text-xs font-semibold text-ink-400">
                    from {formatUsd(p.priceCents)}
                  </span>
                </div>
                <p className="mt-1.5 text-sm text-ink-600">{p.tagline}</p>
              </Link>
            ))}
          </div>
        </div>
      </section>

      {/* Verifiable proof — always shown. Testimonials render above it only
          once we hold real, permissioned quotes (gap #20). */}
      <TestimonialsSection />
      <ProofSection />

      {/* Book a call + demo video (gap #22) */}
      <BookACallSection />

      {/* CTA */}
      <section className="ledger-grid bg-chrome-900">
        <div className="mx-auto max-w-6xl px-5 py-20 text-center">
          <h2 className="font-display text-3xl font-semibold text-chrome-fg">
            Price your options with confidence
          </h2>
          {/* "Start for free" would read as though the report itself is free.
              What is actually free is everything up to checkout. */}
          <p className="mx-auto mt-3 max-w-md text-sm text-chrome-dim">
            15 minutes to set up. Draft in 24 hours. Pay only when ready.
          </p>
          <div className="mt-7 flex flex-wrap items-center justify-center gap-4">
            <Link
              to="/register"
              className="inline-block rounded-md bg-bond-600 px-7 py-3 text-sm font-semibold text-bond-fg shadow-lift transition-colors hover:bg-bond-700"
            >
              Start my valuation
            </Link>
            <Link to="/pricing" className="text-sm font-semibold text-chrome-fg hover:text-brass-300">
              See pricing →
            </Link>
          </div>
        </div>
      </section>
    </div>
  );
}
