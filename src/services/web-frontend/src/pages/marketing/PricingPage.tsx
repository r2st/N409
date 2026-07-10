import { useState } from 'react';
import { Link } from 'react-router-dom';
import { AUDIT_DEFENCE_RATE_USD, PRICING_FAQ, PRODUCTS, formatUsd, quote } from '../../lib/marketing';
import { Seo } from '../../components/Seo';
import { faqJsonLd } from '../../lib/seo';
import { FaqAccordion } from '../../components/FaqAccordion';

/** Firms/partners contact address for the enterprise tier (gap #32). */
const FIRMS_CONTACT_EMAIL = 'partners@n409.example';

/** Interactive pricing calculator + comparison table (409.ai §22.4). */
export function PricingPage() {
  const [slug, setSlug] = useState(PRODUCTS[0]!.slug);
  const [express, setExpress] = useState(false);
  const [qsbsLetter, setQsbsLetter] = useState(false);

  const product = PRODUCTS.find((p) => p.slug === slug) ?? PRODUCTS[0]!;
  const { totalCents, deliveryDays } = quote(product, { express, qsbsLetter });

  return (
    <div>
      <Seo
        title="Pricing"
        description="Transparent, per-report valuation pricing — one flat price, no subscriptions. 409A from $1,190 with a 24-hour first draft and Express delivery available."
        path="/pricing"
        jsonLd={faqJsonLd(PRICING_FAQ)}
      />
      <section className="mx-auto max-w-6xl px-5 py-16">
        <div className="overline text-ink-400">Pricing</div>
        <h1 className="mt-2 font-display text-4xl font-semibold text-ink-900">
          Transparent, per-report pricing
        </h1>
        <p className="mt-3 max-w-xl text-sm leading-relaxed text-ink-600">
          One flat price per report — no subscriptions, no platform lock-in. What you configure here is what
          checkout charges.
        </p>

        <div className="mt-10 grid gap-8 lg:grid-cols-2">
          {/* Calculator */}
          <div className="rounded-lg border border-paper-300 bg-white p-6 shadow-card">
            <label className="block">
              <span className="mb-1.5 block text-[0.8rem] font-semibold text-ink-700">Report type</span>
              <select
                value={slug}
                onChange={(e) => setSlug(e.target.value)}
                className="w-full rounded-md border border-ink-200 bg-white px-3 py-2 text-sm text-ink-900 focus:border-bond-600 focus:outline-none"
              >
                {PRODUCTS.map((p) => (
                  <option key={p.slug} value={p.slug}>
                    {p.name}
                  </option>
                ))}
              </select>
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
                  <span className="font-semibold text-ink-900">Express delivery · +$500</span>
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
                    <span className="font-semibold text-ink-900">QSBS attestation letter · +$500</span>
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
                className="rounded-md bg-bond-600 px-5 py-2.5 text-sm font-semibold text-white shadow-card transition-colors hover:bg-bond-700"
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

          {/* What's included */}
          <div className="rounded-lg border border-paper-300 bg-paper-100 p-6">
            <h2 className="font-display text-lg font-semibold text-ink-900">Every report includes</h2>
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
      </section>

      {/* Comparison table */}
      <section className="border-t border-paper-300 bg-white">
        <div className="mx-auto max-w-6xl px-5 py-16">
          <h2 className="font-display text-3xl font-semibold text-ink-900">
            Faster, clearer, and built for founders
          </h2>
          <div className="mt-8 overflow-x-auto rounded-lg border border-paper-300 shadow-card">
            <table className="w-full min-w-[720px] text-sm" aria-label="Provider comparison">
              <thead>
                <tr className="border-b border-paper-300 bg-paper-50 text-left">
                  <th className="overline px-5 py-3 font-semibold text-ink-400">Feature</th>
                  <th className="overline px-4 py-3 font-semibold text-bond-700">N409</th>
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
                    `$${AUDIT_DEFENCE_RATE_USD}/hour`,
                    '$300–$500+/hour',
                    'Often unavailable',
                  ],
                ].map(([feature, us, firm, provider]) => (
                  <tr key={feature} className="border-b border-paper-200 bg-white last:border-0">
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

      {/* Firms / partners tier (gap #32) */}
      <section className="mx-auto max-w-6xl px-5 pb-16">
        <div className="grid items-center gap-8 rounded-lg border border-ink-800 bg-ink-900 p-8 text-paper-50 lg:grid-cols-[1.5fr_1fr]">
          <div>
            <div className="overline text-brass-400">For firms &amp; partners</div>
            <h2 className="mt-2 font-display text-2xl font-semibold">
              Leverage our AI-powered valuation technology
            </h2>
            <p className="mt-3 max-w-xl text-sm leading-relaxed text-ink-300">
              Accounting firms, fund administrators, and advisors run valuations at scale on N409 — with
              white-label reports, a partner API, and volume pricing. Tell us about your book of business and
              we’ll put together a plan.
            </p>
            <ul className="mt-5 grid gap-2 text-sm text-ink-300 sm:grid-cols-2">
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
            <a
              href={`mailto:${FIRMS_CONTACT_EMAIL}?subject=N409%20for%20firms`}
              className="inline-block rounded-md bg-bond-600 px-6 py-3 text-sm font-semibold text-white shadow-lift transition-colors hover:bg-bond-700"
            >
              Get in touch
            </a>
            <p className="mt-3 text-xs text-ink-400">{FIRMS_CONTACT_EMAIL}</p>
          </div>
        </div>
      </section>

      {/* FAQ (gap #31) */}
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
