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
import { BookACallSection, PartnerLogos, TestimonialsSection } from './MarketingSections';
import { Seo } from '../../components/Seo';
import { SITE_TAGLINE, organizationJsonLd } from '../../lib/seo';

/** Public landing page (409.ai §22.3). */
export function LandingPage() {
  const [heroIndex, setHeroIndex] = useState(0);

  useEffect(() => {
    const t = setInterval(() => setHeroIndex((i) => (i + 1) % HERO_KINDS.length), 2600);
    return () => clearInterval(t);
  }, []);

  const minPrice = Math.min(...PRODUCTS.map((p) => p.priceCents));

  return (
    <div>
      <Seo
        title="N409"
        description={`${SITE_TAGLINE} AI-assisted intake, a transparent valuation engine, and analyst-signed reports across 13 report types.`}
        path="/"
        jsonLd={organizationJsonLd()}
      />
      {/* Hero */}
      <section className="ledger-grid relative overflow-hidden bg-ink-900 text-paper-50">
        <div className="mx-auto max-w-6xl px-5 py-24 lg:py-32">
          <div className="overline mb-6 text-brass-400">Independent · Defensible · Audit-ready</div>
          <h1 className="max-w-3xl font-display text-4xl leading-[1.1] font-medium sm:text-6xl">
            Easier{' '}
            <span className="text-brass-300 underline decoration-bond-500 decoration-2 underline-offset-8">
              {HERO_KINDS[heroIndex]}
            </span>
            <br />
            valuations.
          </h1>
          <p className="mt-7 max-w-xl text-lg leading-relaxed text-ink-300">
            Get your expert-reviewed, audit-defensible valuation with a first draft in 24 hours —
            starting at {formatUsd(minPrice)}.
          </p>
          <div className="mt-9 flex flex-wrap items-center gap-4">
            <Link
              to="/register"
              className="rounded-md bg-bond-600 px-6 py-3 text-sm font-semibold text-white shadow-lift transition-colors hover:bg-bond-700"
            >
              Start my valuation
            </Link>
            <Link to="/which-valuation" className="text-sm font-semibold text-paper-50 hover:text-brass-300">
              Not sure which report? Take the quiz →
            </Link>
          </div>
          <div className="mt-6 flex gap-5 text-xs text-ink-400">
            <span>✓ No credit card required</span>
            <span>✓ No commitment</span>
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
              A qualified 409A valuation gives your option grants safe-harbor protection — the strike
              price the IRS presumes reasonable.
            </p>
          </div>
          <div>
            <h3 className="font-display text-lg font-semibold text-ink-900">Survive the audit</h3>
            <p className="mt-2 text-sm leading-relaxed text-ink-600">
              Every report ships with the full methodology, inputs, and an evidence bundle your
              auditor can trace end to end.
            </p>
          </div>
          <div>
            <h3 className="font-display text-lg font-semibold text-ink-900">Protect the company</h3>
            <p className="mt-2 text-sm leading-relaxed text-ink-600">
              Mispriced equity creates tax liability for employees and clean-up costs at diligence.
              An independent opinion removes that risk.
            </p>
          </div>
        </div>
      </section>

      {/* How it works */}
      <section className="border-y border-paper-300 bg-white">
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
          Onboarding connects to the software your business already uses and pulls your financials
          directly — no spreadsheet exports, no re-typing.
        </p>
        <div className="mt-8 flex flex-wrap gap-3">
          {ACCOUNTING_PROVIDERS.map((name) => (
            <span
              key={name}
              className="rounded-full border border-paper-300 bg-white px-5 py-2.5 text-sm font-semibold text-ink-700 shadow-card"
            >
              {name}
            </span>
          ))}
        </div>
      </section>

      {/* Products strip */}
      <section className="border-y border-paper-300 bg-white">
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

      {/* Testimonials (gap #20) */}
      <TestimonialsSection />

      {/* Book a call + demo video (gap #22) */}
      <BookACallSection />

      {/* CTA */}
      <section className="ledger-grid bg-ink-900">
        <div className="mx-auto max-w-6xl px-5 py-20 text-center">
          <h2 className="font-display text-3xl font-semibold text-paper-50">Put AI into action</h2>
          <p className="mx-auto mt-3 max-w-md text-sm text-ink-300">
            Start your valuation for free. Receive a draft report in just 24 hours.
          </p>
          <Link
            to="/register"
            className="mt-7 inline-block rounded-md bg-bond-600 px-7 py-3 text-sm font-semibold text-white shadow-lift transition-colors hover:bg-bond-700"
          >
            Start my valuation!
          </Link>
        </div>
      </section>
    </div>
  );
}
