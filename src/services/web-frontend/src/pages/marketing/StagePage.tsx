import { Link, Navigate, useParams } from 'react-router-dom';
import {
  FUNDING_STAGES,
  PROCESS_STEPS,
  formatUsd,
  fundingStageBySlug,
  stagePriceRangeCents,
} from '../../lib/marketing';
import { Seo } from '../../components/Seo';
import { stagePageMeta } from '../../lib/pageMeta';
import { FaqAccordion } from '../../components/FaqAccordion';

/**
 * `/409a-valuation/:stage` — the funding-stage landing pages.
 *
 * The product page answers "what is a 409A"; a founder searching for their own
 * stage is asking a narrower question, which is what actually changes in the
 * analysis between a pre-seed with three SAFEs and a pre-IPO with a tender
 * offer. Each page names the methods that differ there and quotes the price
 * band that stage falls in, derived from the same ladder the checkout charges.
 *
 * Data-driven from FUNDING_STAGES; an unknown segment redirects home rather
 * than rendering an empty shell.
 */
export function StagePage() {
  const { stage: slug } = useParams<{ stage: string }>();
  const stage = slug ? fundingStageBySlug(slug) : undefined;
  if (!stage) return <Navigate to="/" replace />;

  const { fromCents, toCents } = stagePriceRangeCents(stage);
  const price =
    fromCents === toCents ? `${formatUsd(fromCents)}` : `${formatUsd(fromCents)} – ${formatUsd(toCents)}`;
  const others = FUNDING_STAGES.filter((s) => s.slug !== stage.slug);

  return (
    <div>
      <Seo {...stagePageMeta(stage.slug)!} />

      <nav aria-label="Breadcrumb" className="border-b border-paper-300 bg-paper-100">
        <ol className="mx-auto flex max-w-6xl gap-2 px-5 py-3 text-xs text-ink-500">
          <li>
            <Link to="/" className="hover:text-ink-800">
              Home
            </Link>
          </li>
          <li aria-hidden="true">/</li>
          <li>
            <Link to="/products/409a-valuation" className="hover:text-ink-800">
              409A Valuation
            </Link>
          </li>
          <li aria-hidden="true">/</li>
          <li className="font-semibold text-ink-700" aria-current="page">
            {stage.name}
          </li>
        </ol>
      </nav>

      {/* Hero */}
      <section className="ledger-grid bg-chrome-900 text-chrome-fg">
        <div className="mx-auto max-w-6xl px-5 py-20">
          <div className="overline mb-4 text-brass-400">{stage.audience}</div>
          <h1 className="max-w-3xl font-display text-4xl leading-tight font-medium sm:text-5xl">
            {stage.name} 409A valuations
          </h1>
          <p className="mt-5 max-w-2xl text-lg text-chrome-dim">{stage.heroSubhead}</p>
          <div className="mt-8 flex flex-wrap items-center gap-5">
            <Link
              to="/register"
              className="rounded-md bg-bond-600 px-6 py-3 text-sm font-semibold text-bond-fg shadow-lift transition-colors hover:bg-bond-700"
            >
              Start my valuation
            </Link>
            <span className="tnum text-sm text-chrome-dim">
              typically <span className="font-semibold text-chrome-fg">{price}</span> · first draft in 24
              hours
            </span>
          </div>
          <ul className="mt-10 flex flex-wrap gap-2">
            {stage.methods.map((m) => (
              <li
                key={m}
                className="rounded-full border border-chrome-700 bg-chrome-800/60 px-3 py-1.5 text-xs font-semibold text-chrome-dim"
              >
                {m}
              </li>
            ))}
          </ul>
        </div>
      </section>

      {/* What changes at this stage */}
      <section className="mx-auto max-w-6xl px-5 py-16">
        <div className="overline text-brass-600">What changes at {stage.name.toLowerCase()}</div>
        <h2 className="mt-2 font-display text-2xl font-semibold text-ink-900">
          The analysis is not the same at every stage
        </h2>
        <div className="mt-8 space-y-8">
          {stage.sections.map((section) => (
            <article key={section.title} className="border-l-2 border-brass-400 pl-5">
              <h3 className="font-display text-lg font-semibold text-ink-900">{section.title}</h3>
              <p className="mt-2 max-w-3xl text-sm leading-relaxed text-ink-600">{section.body}</p>
            </article>
          ))}
        </div>
      </section>

      {/* What it costs */}
      <section className="border-t border-paper-300 bg-surface">
        <div className="mx-auto max-w-6xl px-5 py-16">
          <div className="grid gap-10 lg:grid-cols-[1fr_1.2fr]">
            <div>
              <div className="overline text-brass-600">What it costs</div>
              <h2 className="mt-2 font-display text-2xl font-semibold text-ink-900">{stage.name} pricing</h2>
              <p className="mt-3 max-w-md text-sm leading-relaxed text-ink-600">
                One flat price per report, set by the capital you have raised rather than by a subscription.
                Express delivery and a QSBS attestation letter are optional add-ons.
              </p>
              <dl className="mt-6 grid max-w-md grid-cols-2 gap-4 text-sm">
                <div>
                  <dt className="text-ink-500">Typical {stage.name} price</dt>
                  <dd className="tnum font-semibold text-ink-900">{price}</dd>
                </div>
                <div>
                  <dt className="text-ink-500">Final delivery</dt>
                  <dd className="font-semibold text-ink-900">7 business days</dd>
                </div>
              </dl>
              <Link
                to="/pricing"
                className="mt-6 inline-block rounded-md border border-ink-200 px-4 py-2.5 text-sm font-semibold text-ink-800 transition-colors hover:border-ink-400"
              >
                Configure in the pricing calculator
              </Link>
            </div>
            <div className="grid gap-6 sm:grid-cols-3">
              {PROCESS_STEPS.map((s) => (
                <div key={s.step} className="rounded-lg border border-paper-300 bg-paper-50 p-5">
                  <div className="tnum font-display text-3xl font-semibold text-bond-600">{s.step}</div>
                  <h3 className="mt-3 font-display text-base font-semibold text-ink-900">{s.title}</h3>
                  <p className="mt-2 text-sm leading-relaxed text-ink-600">{s.body}</p>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* FAQ */}
      <section className="mx-auto max-w-3xl px-5 py-16">
        <div className="overline text-brass-600">FAQ</div>
        <h2 className="mt-2 mb-8 font-display text-2xl font-semibold text-ink-900">{stage.name} questions</h2>
        <FaqAccordion items={stage.faq} />
      </section>

      {/* Other stages — the internal linking that makes the set crawlable */}
      <section className="border-t border-paper-300 bg-surface">
        <div className="mx-auto max-w-6xl px-5 py-16">
          <div className="overline text-brass-600">Other stages</div>
          <h2 className="mt-2 font-display text-2xl font-semibold text-ink-900">
            409A valuations by funding stage
          </h2>
          <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {others.map((other) => (
              <Link
                key={other.slug}
                to={`/409a-valuation/${other.slug}`}
                className="group rounded-lg border border-paper-300 bg-paper-50 p-5 transition-colors hover:border-ink-300"
              >
                <h3 className="font-display text-base font-semibold text-ink-900 group-hover:text-bond-700">
                  {other.name}
                </h3>
                <p className="mt-1.5 text-sm text-ink-600">{other.audience}</p>
              </Link>
            ))}
          </div>
        </div>
      </section>

      {/* Bottom CTA */}
      <section className="ledger-grid border-t border-chrome-800 bg-chrome-900 text-chrome-fg">
        <div className="mx-auto max-w-4xl px-5 py-16 text-center">
          <h2 className="font-display text-3xl font-semibold">Get your {stage.name} 409A started</h2>
          <div className="mt-8 flex flex-wrap items-center justify-center gap-4">
            <Link
              to="/register"
              className="rounded-md bg-bond-600 px-6 py-3 text-sm font-semibold text-bond-fg shadow-lift transition-colors hover:bg-bond-700"
            >
              Start my valuation
            </Link>
            <Link
              to="/products/409a-valuation"
              className="rounded-md border border-chrome-600 px-6 py-3 text-sm font-semibold text-chrome-fg transition-colors hover:border-chrome-faint"
            >
              About 409A valuations
            </Link>
          </div>
        </div>
      </section>
    </div>
  );
}
