import { useState } from 'react';
import { Link } from 'react-router-dom';
import {
  AUDIT_DEFENCE_RATE_USD,
  PRICING_FAQ,
  PRICING_TIERS,
  PRODUCTS,
  formatUsd,
  type PricingTier,
} from '../../lib/marketing';
import { RAISE_BANDS, quote } from '../../lib/marketingContent';
import { Seo } from '../../components/Seo';
import { pageMeta } from '../../lib/pageMeta';
import { FaqAccordion } from '../../components/FaqAccordion';
import { siteConfig } from '../../lib/siteConfig';

function TierCard({ tier }: { tier: PricingTier }) {
  const highlighted = tier.highlight;
  return (
    <div
      className={`relative flex flex-col rounded-xl border p-6 shadow-card ${
        highlighted
          ? 'border-bond-600 ring-2 ring-bond-600/20'
          : 'border-paper-300'
      }`}
      data-testid={`tier-${tier.tier}`}
    >
      {highlighted && (
        <span className="absolute -top-3 left-1/2 -translate-x-1/2 rounded-full bg-bond-600 px-3 py-0.5 text-xs font-semibold text-bond-fg">
          Most popular
        </span>
      )}
      <h3 className="font-display text-xl font-semibold text-ink-900">{tier.name}</h3>
      <p className="mt-1 text-sm text-ink-500">{tier.tagline}</p>
      <div className="mt-4">
        <span className="tnum font-display text-4xl font-semibold text-ink-900">
          {formatUsd(tier.priceCents)}
        </span>
        <span className="ml-1 text-sm text-ink-500">
          {tier.interval === 'one_time'
            ? tier.priceCents === 0
              ? ''
              : '/valuation'
            : tier.interval === 'year'
              ? '/year'
              : '/month'}
        </span>
      </div>
      {tier.priceCents === 0 ? (
        <p className="mt-1 text-xs text-ink-400">Sample report, no card required</p>
      ) : tier.valuationLimit !== null ? (
        <p className="mt-1 text-xs text-ink-400">
          {tier.interval === 'one_time'
            ? 'Single valuation report'
            : `Up to ${tier.valuationLimit} valuations/year`}
        </p>
      ) : (
        <p className="mt-1 text-xs text-ink-400">Unlimited valuations</p>
      )}
      <ul className="mt-6 flex-1 space-y-2.5 text-sm text-ink-700">
        {tier.features.map((f) => (
          <li key={f} className="flex gap-2.5">
            <span className="text-bond-600">✓</span>
            {f}
          </li>
        ))}
      </ul>
      <Link
        to={tier.priceCents === 0 ? '/register' : `/order?tier=${tier.tier}`}
        className={`mt-6 block rounded-md px-5 py-2.5 text-center text-sm font-semibold shadow-card transition-colors ${
          highlighted
            ? 'bg-bond-600 text-bond-fg hover:bg-bond-700'
            : 'bg-surface text-ink-900 ring-1 ring-inset ring-paper-300 hover:bg-paper-50'
        }`}
        data-testid={`cta-${tier.tier}`}
      >
        {tier.priceCents === 0
          ? 'Try free'
          : tier.interval === 'one_time'
            ? 'Get started'
            : 'Subscribe'}
      </Link>
    </div>
  );
}

export function PricingPage() {
  const [slug, setSlug] = useState(PRODUCTS[0]!.slug);
  const [express, setExpress] = useState(false);
  const [qsbsLetter, setQsbsLetter] = useState(false);
  const [raiseBand, setRaiseBand] = useState(0);
  const { partnersEmail } = siteConfig();

  const product = PRODUCTS.find((p) => p.slug === slug) ?? PRODUCTS[0]!;
  const { totalCents, deliveryDays } = quote(product, { express, qsbsLetter, raiseBand });

  return (
    <div>
      <Seo {...pageMeta('/pricing')!} />

      {/* Tier cards */}
      <section className="mx-auto max-w-6xl px-5 py-16">
        <div className="overline text-ink-400">Pricing</div>
        <h1 className="mt-2 font-display text-4xl font-semibold text-ink-900">
          Simple, transparent pricing
        </h1>
        <p className="mt-3 max-w-xl text-sm leading-relaxed text-ink-600">
          Choose the plan that fits your stage. Pay per valuation or subscribe for ongoing coverage.
        </p>

        <div className="mt-10 grid gap-8 lg:grid-cols-3" data-testid="pricing-tiers">
          {PRICING_TIERS.map((t) => (
            <TierCard key={t.tier} tier={t} />
          ))}
        </div>
      </section>

      {/* Why we charge */}
      <section className="border-t border-paper-300 bg-paper-50" data-testid="why-we-charge">
        <div className="mx-auto max-w-3xl px-5 py-12 text-center">
          <div className="overline text-ink-400">Transparency</div>
          <h2 className="mt-2 font-display text-2xl font-semibold text-ink-900">Why we charge</h2>
          <p className="mx-auto mt-4 max-w-xl text-sm leading-relaxed text-ink-600">
            Every valuation runs through AI models that cost real money in compute. Our price covers those costs
            and nothing more — no markups, no margin padding. Competitors charge $990–$3,500 per report because
            they rely on hours of manual analyst work. Our AI does the heavy lifting, so we can pass the savings
            on to you.
          </p>
          <div className="mt-8 grid gap-6 sm:grid-cols-3">
            <div className="rounded-lg border border-paper-300 bg-surface p-5">
              <div className="font-display text-2xl font-semibold text-bond-600">$5–15</div>
              <div className="mt-1 text-xs text-ink-500">AI compute per report</div>
            </div>
            <div className="rounded-lg border border-paper-300 bg-surface p-5">
              <div className="font-display text-2xl font-semibold text-bond-600">$49</div>
              <div className="mt-1 text-xs text-ink-500">What we charge (covers costs + infra)</div>
            </div>
            <div className="rounded-lg border border-paper-300 bg-surface p-5">
              <div className="font-display text-2xl font-semibold text-bond-600">$990+</div>
              <div className="mt-1 text-xs text-ink-500">What others charge</div>
            </div>
          </div>
        </div>
      </section>

      {/* Per-report calculator */}
      <section className="border-t border-paper-300 bg-paper-50">
        <div className="mx-auto max-w-6xl px-5 py-16">
          <div className="overline text-ink-400">Per-report pricing</div>
          <h2 className="mt-2 font-display text-3xl font-semibold text-ink-900">
            Need a different report type?
          </h2>
          <p className="mt-3 max-w-xl text-sm leading-relaxed text-ink-600">
            One flat price per report — no subscriptions required. Configure your report and see what checkout
            charges.
          </p>

          <div className="mt-10 grid gap-8 lg:grid-cols-2">
            <div className="rounded-lg border border-paper-300 bg-surface p-6 shadow-card">
              <label className="block">
                <span className="mb-1.5 block text-[0.8rem] font-semibold text-ink-700">Report type</span>
                <select
                  value={slug}
                  onChange={(e) => setSlug(e.target.value)}
                  className="w-full rounded-md border border-ink-200 bg-surface px-3 py-2 text-sm text-ink-900 focus:border-bond-600 focus:outline-none"
                >
                  {PRODUCTS.map((p) => (
                    <option key={p.slug} value={p.slug}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </label>

              <label className="mt-5 block">
                <span className="mb-1.5 flex items-baseline justify-between">
                  <span className="text-[0.8rem] font-semibold text-ink-700">Capital raised to date</span>
                  <span className="tnum text-[0.8rem] font-semibold text-ink-900" data-testid="raise-band">
                    {RAISE_BANDS[raiseBand]!.label}
                  </span>
                </span>
                <input
                  type="range"
                  min={0}
                  max={RAISE_BANDS.length - 1}
                  step={1}
                  value={raiseBand}
                  onChange={(e) => setRaiseBand(Number(e.target.value))}
                  className="w-full accent-bond-600"
                  aria-label="Capital raised to date"
                  aria-valuetext={RAISE_BANDS[raiseBand]!.label}
                />
                <span className="mt-1 flex justify-between text-[0.7rem] text-ink-400">
                  <span>{RAISE_BANDS[0]!.label}</span>
                  <span>{RAISE_BANDS.at(-1)!.label}</span>
                </span>
              </label>

              <div className="mt-5 space-y-3">
                <label className="flex items-start gap-3 rounded-md border border-paper-300 p-3.5 text-sm">
                  <input
                    type="checkbox"
                    checked={express}
                    onChange={(e) => setExpress(e.target.checked)}
                    className="mt-0.5"
                  />
                  <span>
                    <span className="font-semibold text-ink-900">Express delivery · +$29</span>
                    <span className="mt-0.5 block text-xs text-ink-500">
                      Receive your final report in 1 business day instead of {product.deliveryDays}.
                    </span>
                  </span>
                </label>
                {product.kind !== 'qsbs' && (
                  <label className="flex items-start gap-3 rounded-md border border-paper-300 p-3.5 text-sm">
                    <input
                      type="checkbox"
                      checked={qsbsLetter}
                      onChange={(e) => setQsbsLetter(e.target.checked)}
                      className="mt-0.5"
                    />
                    <span>
                      <span className="font-semibold text-ink-900">QSBS attestation letter · included</span>
                      <span className="mt-0.5 block text-xs text-ink-500">
                        Add documentation and support for QSBS tax status.
                      </span>
                    </span>
                  </label>
                )}
              </div>

              <div className="mt-6 flex items-end justify-between border-t border-paper-300 pt-5">
                <div>
                  <div className="overline text-ink-400">Your price</div>
                  <div
                    className="tnum font-display text-4xl font-semibold text-ink-900"
                    data-testid="quote-total"
                  >
                    {formatUsd(totalCents)}
                  </div>
                  <div className="mt-1 text-xs text-ink-500">
                    Delivered in {deliveryDays} business day{deliveryDays === 1 ? '' : 's'} · first draft in 24
                    hours
                  </div>
                </div>
                <Link
                  to="/register"
                  className="rounded-md bg-bond-600 px-5 py-2.5 text-sm font-semibold text-bond-fg shadow-card transition-colors hover:bg-bond-700"
                >
                  Get the report
                </Link>
              </div>
              <p className="mt-4 text-xs text-ink-400">
                Not sure which report you need?{' '}
                <Link to="/which-valuation" className="font-semibold text-bond-600 hover:text-bond-700">
                  Take the 30-second quiz
                </Link>
              </p>
            </div>

            <div className="rounded-lg border border-paper-300 bg-paper-100 p-6">
              <h3 className="font-display text-lg font-semibold text-ink-900">Every report includes</h3>
              <ul className="mt-4 space-y-2.5 text-sm text-ink-700">
                {[
                  'Credentialed analyst review and dual signatures',
                  'Full methodology appendix and calculation history',
                  'AI-assisted intake — connect accounting software or upload documents',
                  'Draft review cycle with revisions included',
                  'Audit-defense evidence bundle on request',
                  'Live status tracking from intake to delivery',
                ].map((line) => (
                  <li key={line} className="flex gap-2.5">
                    <span className="text-bond-600">✓</span>
                    {line}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      </section>

      {/* Comparison table */}
      <section className="border-t border-paper-300 bg-surface">
        <div className="mx-auto max-w-6xl px-5 py-16">
          <h2 className="font-display text-3xl font-semibold text-ink-900">
            Faster, clearer, and built for founders
          </h2>
          <div className="mt-8 overflow-x-auto overscroll-x-contain rounded-lg border border-paper-300 shadow-card">
            <table className="w-full min-w-[720px] text-sm" aria-label="Provider comparison">
              <thead>
                <tr className="border-b border-paper-300 bg-paper-50 text-left">
                  <th className="overline px-5 py-3 font-semibold text-ink-400">Feature</th>
                  <th className="overline px-4 py-3 font-semibold text-bond-700">DoAide 409A</th>
                  <th className="overline px-4 py-3 font-semibold text-ink-400">Accounting firm</th>
                  <th className="overline px-4 py-3 font-semibold text-ink-400">Cap table provider</th>
                </tr>
              </thead>
              <tbody>
                {[
                  [
                    'Onboarding',
                    'Online form + software connect',
                    'Email + document back-and-forth',
                    'Mostly email or manual uploads',
                  ],
                  ['Time required', '15 minutes', '8–20+ hours', '1–5 hours'],
                  ['First draft', '24 hours', '4–12 weeks', '3–8 weeks'],
                  ['Final report', '7 business days · 1 day Express', '4–12 weeks', '3–8 weeks'],
                  [
                    'Software integrations',
                    'QuickBooks, Xero, FreshBooks & more',
                    'Manual document collection',
                    'Limited or platform-dependent',
                  ],
                  [
                    'Report quality',
                    'AI-assisted draft + expert review',
                    'Manual analyst process',
                    'Platform-dependent',
                  ],
                  ['Expert sign-off', '✓', '✓', '✓'],
                  ['Report revisions', 'Included', 'Limited or extra fees', 'Varies'],
                  [
                    'Audit support',
                    `From $${AUDIT_DEFENCE_RATE_USD}/hour`,
                    '$300–$500+/hour',
                    'Often unavailable',
                  ],
                ].map(([feature, us, firm, provider]) => (
                  <tr key={feature} className="border-b border-paper-200 bg-surface last:border-0">
                    <td className="px-5 py-3 font-semibold text-ink-800">{feature}</td>
                    <td className="px-4 py-3 font-medium text-bond-700">{us}</td>
                    <td className="px-4 py-3 text-ink-600">{firm}</td>
                    <td className="px-4 py-3 text-ink-600">{provider}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      {/* Firms / partners tier */}
      <section className="mx-auto max-w-6xl px-5 pb-16">
        <div className="grid items-center gap-8 rounded-lg border border-chrome-800 bg-chrome-900 p-8 text-chrome-fg lg:grid-cols-[1.5fr_1fr]">
          <div>
            <div className="overline text-brass-400">For firms &amp; partners</div>
            <h2 className="mt-2 font-display text-2xl font-semibold">
              Leverage our AI-powered valuation technology
            </h2>
            <p className="mt-3 max-w-xl text-sm leading-relaxed text-chrome-dim">
              Accounting firms, fund administrators, and advisors run valuations at scale on DoAide 409A — with
              white-label reports, a partner API, and volume pricing. Tell us about your book of business and
              we'll put together a plan.
            </p>
            <ul className="mt-5 grid gap-2 text-sm text-chrome-dim sm:grid-cols-2">
              {[
                'White-label reports and client portal',
                'Partner API and bulk intake',
                'Volume pricing across all report types',
                'Dedicated support and onboarding',
              ].map((line) => (
                <li key={line} className="flex gap-2.5">
                  <span className="text-bond-400">✓</span>
                  {line}
                </li>
              ))}
            </ul>
          </div>
          <div className="text-center lg:text-right">
            {partnersEmail ? (
              <>
                <a
                  href={`mailto:${partnersEmail}?subject=DoAide%20409A%20for%20firms`}
                  className="inline-block rounded-md bg-bond-600 px-6 py-3 text-sm font-semibold text-bond-fg shadow-lift transition-colors hover:bg-bond-700"
                >
                  Get in touch
                </a>
                <p className="mt-3 text-xs break-words text-chrome-faint">{partnersEmail}</p>
              </>
            ) : (
              <>
                <Link
                  to="/contact"
                  className="inline-block rounded-md bg-bond-600 px-6 py-3 text-sm font-semibold text-bond-fg shadow-lift transition-colors hover:bg-bond-700"
                >
                  Get in touch
                </Link>
                <p className="mt-3 text-xs text-ink-400">We reply within one business day.</p>
              </>
            )}
          </div>
        </div>
      </section>

      {/* FAQ */}
      <section className="border-t border-paper-300 bg-paper-50">
        <div className="mx-auto max-w-3xl px-5 py-16">
          <div className="overline text-ink-400">FAQ</div>
          <h2 className="mt-2 mb-8 font-display text-3xl font-semibold text-ink-900">
            Pricing &amp; valuation questions
          </h2>
          <FaqAccordion items={PRICING_FAQ} />
          <p className="mt-8 text-sm text-ink-500">
            Still have questions?{' '}
            <Link to="/contact" className="font-semibold text-bond-600 hover:text-bond-700">
              Get in touch
            </Link>{' '}
            or{' '}
            <Link to="/which-valuation" className="font-semibold text-bond-600 hover:text-bond-700">
              take the 30-second quiz
            </Link>
            .
          </p>
        </div>
      </section>
    </div>
  );
}
