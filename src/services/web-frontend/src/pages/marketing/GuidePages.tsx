import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { VALUATION_TRIGGERS, AUDIT_DEFENCE_RATE_USD, formatUsd, productBySlug } from '../../lib/marketing';
import {
  COST_COMPARISON_SECTIONS,
  COST_DRIVERS,
  EXPRESS_DELIVERY_CENTS,
  EXPRESS_DELIVERY_DAYS,
  GUIDE_SECTIONS,
  MARKET_PRICE_BANDS,
  METHODS_SECTIONS,
  NONCOMPLIANCE_CONSEQUENCES,
  PROVIDER_TYPES,
} from '../../lib/marketingContent';
import { Seo } from '../../components/Seo';
import { pageMeta } from '../../lib/pageMeta';

/**
 * The three educational pages a founder reads *before* they are ready to buy
 * (409.ai parity: the 409A guide, the timing question, the cost question).
 *
 * Every price on these pages is read from `lib/marketing` at render — the 409A
 * product's own `priceCents`, the express uplift, the audit-defence rate — so
 * the prose cannot contradict /pricing after a price change. The only literal
 * money figures are the third-party market bands, which are ranges precisely
 * because they are not ours to keep current.
 */

/** Shared shell: SEO tags, heading block, and the closing call to action. */
function GuideShell({
  path,
  overline,
  title,
  standfirst,
  children,
}: {
  path: string;
  overline: string;
  title: string;
  standfirst: string;
  children: ReactNode;
}) {
  return (
    <div className="mx-auto max-w-3xl px-5 py-16">
      <Seo {...pageMeta(path)!} />
      <div className="overline text-ink-400">{overline}</div>
      <h1 className="mt-2 font-display text-4xl font-semibold text-ink-900">{title}</h1>
      <p className="mt-4 text-base leading-relaxed text-ink-600">{standfirst}</p>
      <div className="mt-10 space-y-10">{children}</div>
      <GuideCta />
    </div>
  );
}

/**
 * Closing CTA. Points at the quiz and the sample report rather than straight at
 * checkout: a reader on an explainer page is orienting, and the sample report
 * is the thing that answers "what do I actually get" without an email gate.
 */
function GuideCta() {
  return (
    <div className="mt-14 rounded-lg border border-bond-200 bg-bond-50 p-6">
      <h2 className="font-display text-xl font-semibold text-ink-900">Ready when you are</h2>
      <p className="mt-2 text-sm leading-relaxed text-ink-600">
        Read a complete sample report before you decide, or take the 30-second quiz if you are not sure which
        valuation you need.
      </p>
      <div className="mt-5 flex flex-wrap items-center gap-4">
        <Link
          to="/register"
          className="rounded-md bg-bond-600 px-5 py-2.5 text-sm font-semibold text-bond-fg shadow-card transition-colors hover:bg-bond-700"
        >
          Start a valuation
        </Link>
        <Link to="/sample-report" className="text-sm font-semibold text-bond-600 hover:text-bond-700">
          See a sample report →
        </Link>
        <Link to="/which-valuation" className="text-sm font-semibold text-bond-600 hover:text-bond-700">
          Which valuation do I need? →
        </Link>
      </div>
    </div>
  );
}

function Bullets({ items }: { items: readonly string[] }) {
  return (
    <ul className="mt-3 space-y-2">
      {items.map((item) => (
        <li key={item} className="flex gap-3 text-[0.95rem] leading-relaxed text-ink-700">
          <span aria-hidden="true" className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-bond-500" />
          <span>{item}</span>
        </li>
      ))}
    </ul>
  );
}

/** `/409a-valuation-guide` */
export function ValuationGuidePage() {
  return (
    <GuideShell
      path="/409a-valuation-guide"
      overline="Guide"
      title="The 409A valuation guide"
      standfirst="What a 409A valuation is, why the safe harbor matters more than the number itself, how the value is derived, and what a defensible report has to show."
    >
      {GUIDE_SECTIONS.map((section) => (
        <section key={section.heading} data-testid="guide-section">
          <h2 className="font-display text-2xl font-semibold text-ink-900">{section.heading}</h2>
          <p className="mt-3 text-[0.95rem] leading-relaxed text-ink-700">{section.body}</p>
          {section.bullets && <Bullets items={section.bullets} />}
        </section>
      ))}
    </GuideShell>
  );
}

/** `/when-do-you-need-a-409a` */
export function WhenDoYouNeedPage() {
  const required = VALUATION_TRIGGERS.filter((t) => t.urgency === 'required');
  const recommended = VALUATION_TRIGGERS.filter((t) => t.urgency === 'recommended');

  return (
    <GuideShell
      path="/when-do-you-need-a-409a"
      overline="Timing"
      title="When do you need a 409A valuation?"
      standfirst="Four events require one and two more make it worth having anyway. The 12-month rule is the one everybody knows; the material-event rule is the one that creates the exposure."
    >
      <section>
        <h2 className="font-display text-2xl font-semibold text-ink-900">You need one</h2>
        <div className="mt-4 space-y-4">
          {required.map((trigger) => (
            <div
              key={trigger.title}
              data-testid="trigger-required"
              className="rounded-lg border border-paper-300 bg-surface p-5"
            >
              <h3 className="text-sm font-semibold text-ink-900">{trigger.title}</h3>
              <p className="mt-1.5 text-[0.95rem] leading-relaxed text-ink-600">{trigger.body}</p>
            </div>
          ))}
        </div>
      </section>

      <section>
        <h2 className="font-display text-2xl font-semibold text-ink-900">
          Worth having, though not required
        </h2>
        <div className="mt-4 space-y-4">
          {recommended.map((trigger) => (
            <div
              key={trigger.title}
              data-testid="trigger-recommended"
              className="rounded-lg border border-paper-300 bg-surface p-5"
            >
              <h3 className="text-sm font-semibold text-ink-900">{trigger.title}</h3>
              <p className="mt-1.5 text-[0.95rem] leading-relaxed text-ink-600">{trigger.body}</p>
            </div>
          ))}
        </div>
      </section>

      <section>
        <h2 className="font-display text-2xl font-semibold text-ink-900">What it costs to get this wrong</h2>
        <p className="mt-3 text-[0.95rem] leading-relaxed text-ink-700">
          The penalty for a discounted strike price falls on the option holder, not on the company that set it
          — which is why an under-priced grant is discovered by an employee, usually at the worst possible
          moment.
        </p>
        <Bullets items={NONCOMPLIANCE_CONSEQUENCES} />
        <p className="mt-4 text-sm leading-relaxed text-ink-500">
          This is general information, not tax advice. Talk to your own adviser about your specific facts.
        </p>
      </section>
    </GuideShell>
  );
}

/** `/how-much-does-a-409a-cost` */
export function ValuationCostPage() {
  // Read from the product registry rather than written into the prose, so a
  // price change on /pricing cannot leave this page quoting last month's number.
  const product = productBySlug('409a-valuation');

  return (
    <GuideShell
      path="/how-much-does-a-409a-cost"
      overline="Pricing"
      title="How much does a 409A valuation cost?"
      standfirst="What drives the price, what the market actually charges, and where the costs sit that are not on the quote."
    >
      <section>
        <h2 className="font-display text-2xl font-semibold text-ink-900">What the market charges</h2>
        <p className="mt-3 text-[0.95rem] leading-relaxed text-ink-700">
          A standalone 409A generally falls into one of three bands, and which band you are in has more to do
          with who you buy from than with how complicated your company is.
        </p>
        <div className="mt-5 space-y-3">
          {MARKET_PRICE_BANDS.map((band) => (
            <div
              key={band.tier}
              data-testid="price-band"
              className="rounded-lg border border-paper-300 bg-surface p-5"
            >
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h3 className="text-sm font-semibold text-ink-900">{band.tier}</h3>
                <span className="tnum text-sm font-semibold text-bond-700">{band.range}</span>
              </div>
              <p className="mt-1.5 text-[0.95rem] leading-relaxed text-ink-600">{band.note}</p>
            </div>
          ))}
        </div>
      </section>

      {product && (
        <section data-testid="our-price">
          <h2 className="font-display text-2xl font-semibold text-ink-900">What we charge</h2>
          <p className="mt-3 text-[0.95rem] leading-relaxed text-ink-700">
            A 409A starts at{' '}
            <strong className="tnum font-semibold text-ink-900">{formatUsd(product.priceCents)}</strong> — one
            flat price per report, with no subscription and no platform to stay on. The final quote rises with
            capital raised, because that is the honest driver of the work;{' '}
            <Link to="/pricing" className="font-semibold text-bond-600 hover:text-bond-700">
              the pricing page
            </Link>{' '}
            computes yours before you sign up for anything. A first draft is ready in 24 hours, and Express
            delivery brings the final report to{' '}
            {EXPRESS_DELIVERY_DAYS === 1 ? 'one day' : `${EXPRESS_DELIVERY_DAYS} days`} for{' '}
            <span className="tnum">{formatUsd(EXPRESS_DELIVERY_CENTS)}</span>.
          </p>
        </section>
      )}

      <section>
        <h2 className="font-display text-2xl font-semibold text-ink-900">What moves the price</h2>
        <div className="mt-4 space-y-4">
          {COST_DRIVERS.map((driver) => (
            <div key={driver.factor} data-testid="cost-driver">
              <h3 className="text-sm font-semibold text-ink-900">{driver.factor}</h3>
              <p className="mt-1 text-[0.95rem] leading-relaxed text-ink-600">{driver.effect}</p>
            </div>
          ))}
        </div>
      </section>

      <section>
        <h2 className="font-display text-2xl font-semibold text-ink-900">
          The cost that is not on the quote
        </h2>
        <p className="mt-3 text-[0.95rem] leading-relaxed text-ink-700">
          Audit support is where a cheap valuation gets expensive. When your auditor tests the report,
          somebody has to answer them, and that time is usually billed separately at partner rates of
          $300–$500+ an hour. We support the valuation at{' '}
          <strong className="tnum font-semibold text-ink-900">${AUDIT_DEFENCE_RATE_USD}/hr</strong>, and
          revisions during the draft cycle are included.
        </p>
      </section>
    </GuideShell>
  );
}

/** `/409a-valuation-methods` */
export function ValuationMethodsPage() {
  return (
    <GuideShell
      path="/409a-valuation-methods"
      overline="Methods"
      title="409A valuation methods explained"
      standfirst="The market, income, and asset approaches — how they work, when each one applies, and how they are reconciled into a defensible fair market value for your common stock."
    >
      {METHODS_SECTIONS.map((section) => (
        <section key={section.heading} data-testid="guide-section">
          <h2 className="font-display text-2xl font-semibold text-ink-900">{section.heading}</h2>
          <p className="mt-3 text-[0.95rem] leading-relaxed text-ink-700">{section.body}</p>
          {section.bullets && <Bullets items={section.bullets} />}
        </section>
      ))}
    </GuideShell>
  );
}

/** `/409a-valuation-cost-comparison` */
export function ValuationCostComparisonPage() {
  return (
    <GuideShell
      path="/409a-valuation-cost-comparison"
      overline="Cost comparison"
      title="409A valuation cost: Big 4 vs boutique vs automated"
      standfirst="What a 409A valuation costs across four provider types, what is included, what is not, and how to choose."
    >
      {/* Provider comparison cards */}
      <section>
        <h2 className="font-display text-2xl font-semibold text-ink-900">Four kinds of 409A provider</h2>
        <div className="mt-5 space-y-5">
          {PROVIDER_TYPES.map((provider) => (
            <div
              key={provider.name}
              data-testid="provider-type"
              className="rounded-lg border border-paper-300 bg-surface p-5"
            >
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h3 className="text-sm font-semibold text-ink-900">{provider.name}</h3>
                <span className="tnum text-sm font-semibold text-bond-700">{provider.priceRange}</span>
              </div>
              <p className="mt-1 text-xs text-ink-500">Typical turnaround: {provider.turnaround}</p>
              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                <div>
                  <p className="text-xs font-semibold text-ink-600">Strengths</p>
                  <ul className="mt-1 space-y-1">
                    {provider.strengths.map((s) => (
                      <li key={s} className="flex gap-2 text-[0.85rem] leading-relaxed text-ink-600">
                        <span aria-hidden="true" className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500" />
                        <span>{s}</span>
                      </li>
                    ))}
                  </ul>
                </div>
                <div>
                  <p className="text-xs font-semibold text-ink-600">Trade-offs</p>
                  <ul className="mt-1 space-y-1">
                    {provider.tradeoffs.map((t) => (
                      <li key={t} className="flex gap-2 text-[0.85rem] leading-relaxed text-ink-600">
                        <span aria-hidden="true" className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-amber-500" />
                        <span>{t}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* General cost analysis sections */}
      {COST_COMPARISON_SECTIONS.map((section) => (
        <section key={section.heading} data-testid="guide-section">
          <h2 className="font-display text-2xl font-semibold text-ink-900">{section.heading}</h2>
          <p className="mt-3 text-[0.95rem] leading-relaxed text-ink-700">{section.body}</p>
          {section.bullets && <Bullets items={section.bullets} />}
        </section>
      ))}
    </GuideShell>
  );
}
