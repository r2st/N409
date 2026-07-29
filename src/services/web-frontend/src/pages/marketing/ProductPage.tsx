import { Link, Navigate, useParams } from 'react-router-dom';
import { PROCESS_STEPS, PRODUCTS, formatUsd, productBySlug, productContent } from '../../lib/marketing';
import { BookACallSection } from './MarketingSections';
import { Seo } from '../../components/Seo';
import { productPageMeta } from '../../lib/pageMeta';
import { FaqAccordion } from '../../components/FaqAccordion';

/**
 * Data-driven product landing page (409.ai §22.2, gap #17) — one per valuation
 * kind. Renders the 8-section 409.ai template: Breadcrumb, Hero (with a report
 * mockup), Problem (cross-linking a related product), Solution cards, Process,
 * Included checklist, FAQ, and a bottom CTA with a legal disclaimer. Long-form
 * copy comes from PRODUCT_CONTENT; the page degrades gracefully to the base
 * fields if a product has no content entry yet.
 */
export function ProductPage() {
  const { slug } = useParams<{ slug: string }>();
  const product = slug ? productBySlug(slug) : undefined;
  if (!product) return <Navigate to="/" replace />;
  const content = productContent(product.slug);

  const related = PRODUCTS.filter((p) => p.slug !== product.slug).slice(0, 3);
  const problemRelated = content ? productBySlug(content.problem.relatedSlug) : undefined;
  const ctaLabel = content?.ctaLabel ?? 'Start my valuation';

  return (
    <div>
      <Seo {...productPageMeta(product.slug)!} />

      {/* 1. Breadcrumb */}
      <nav aria-label="Breadcrumb" className="border-b border-paper-300 bg-paper-100">
        <ol className="mx-auto flex max-w-6xl gap-2 px-5 py-3 text-xs text-ink-500">
          <li>
            <Link to="/" className="hover:text-ink-800">
              Home
            </Link>
          </li>
          <li aria-hidden="true">/</li>
          <li className="hover:text-ink-800">Products</li>
          <li aria-hidden="true">/</li>
          <li className="font-semibold text-ink-700" aria-current="page">
            {product.name}
          </li>
        </ol>
      </nav>

      {/* 2. Hero */}
      <section className="ledger-grid bg-ink-900 text-paper-50">
        <div className="mx-auto grid max-w-6xl gap-10 px-5 py-20 lg:grid-cols-[1.3fr_1fr] lg:items-center">
          <div>
            <div className="overline mb-4 text-brass-400">{product.audience}</div>
            <h1 className="max-w-2xl font-display text-4xl leading-tight font-medium sm:text-5xl">
              {product.name}
            </h1>
            <p className="mt-5 max-w-xl text-lg text-ink-300">{content?.heroSubhead ?? product.tagline}</p>
            <div className="mt-8 flex flex-wrap items-center gap-5">
              <Link
                to="/register"
                className="rounded-md bg-bond-600 px-6 py-3 text-sm font-semibold text-white shadow-lift transition-colors hover:bg-bond-700"
              >
                {ctaLabel}
              </Link>
              <span className="tnum text-sm text-ink-300">
                from <span className="font-semibold text-paper-50">{formatUsd(product.priceCents)}</span> ·{' '}
                {product.deliveryDays} business days
              </span>
            </div>
          </div>
          {/* Report card mockup */}
          <div className="rounded-lg border border-ink-700 bg-ink-800/60 p-6 shadow-lift">
            <div className="flex items-center justify-between border-b border-ink-700 pb-3">
              <span className="overline text-brass-400">{product.short}</span>
              <span className="rounded-full bg-bond-600/20 px-2.5 py-1 text-xs font-semibold text-bond-400">
                Signed
              </span>
            </div>
            <div className="mt-4 space-y-2.5" aria-hidden="true">
              <div className="h-2.5 w-3/4 rounded bg-ink-700" />
              <div className="h-2.5 w-full rounded bg-ink-700" />
              <div className="h-2.5 w-5/6 rounded bg-ink-700" />
            </div>
            <dl className="mt-5 grid grid-cols-2 gap-3 text-sm">
              <div>
                <dt className="text-ink-400">First draft</dt>
                <dd className="font-semibold text-paper-50">24 hours</dd>
              </div>
              <div>
                <dt className="text-ink-400">Methodology</dt>
                <dd className="font-semibold text-paper-50">Multi-approach</dd>
              </div>
            </dl>
          </div>
        </div>
      </section>

      {/* 3. Problem */}
      {content && (
        <section className="mx-auto max-w-6xl px-5 py-16">
          <div className="grid gap-10 lg:grid-cols-[1.4fr_1fr]">
            <div>
              <div className="overline text-brass-600">The problem</div>
              <h2 className="mt-2 font-display text-2xl font-semibold text-ink-900">
                {content.problem.headline}
              </h2>
              <p className="mt-3 max-w-xl text-sm leading-relaxed text-ink-600">{content.problem.body}</p>
              <ul className="mt-6 space-y-3 text-sm text-ink-700">
                {content.problem.bullets.map((b) => (
                  <li key={b} className="flex gap-2.5">
                    <span className="text-ink-400">•</span>
                    {b}
                  </li>
                ))}
              </ul>
            </div>
            {problemRelated && (
              <aside className="self-start rounded-lg border border-paper-300 bg-paper-100 p-5">
                <div className="overline text-ink-400">Related</div>
                <Link to={`/products/${problemRelated.slug}`} className="group mt-2 block">
                  <h3 className="font-display text-base font-semibold text-ink-900 group-hover:text-bond-700">
                    {problemRelated.name}
                  </h3>
                  <p className="mt-1.5 text-sm text-ink-600">{problemRelated.tagline}</p>
                  <span className="mt-3 inline-block text-sm font-semibold text-bond-600 group-hover:text-bond-700">
                    Learn more →
                  </span>
                </Link>
              </aside>
            )}
          </div>
        </section>
      )}

      {/* 4. Solution */}
      {content && (
        <section className="border-t border-paper-300 bg-white">
          <div className="mx-auto max-w-6xl px-5 py-16">
            <div className="overline text-brass-600">The solution</div>
            <h2 className="mt-2 font-display text-2xl font-semibold text-ink-900">{product.tagline}</h2>
            <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              {content.solution.map((card) => (
                <div key={card.title} className="rounded-lg border border-paper-300 bg-paper-50 p-5">
                  <h3 className="font-display text-base font-semibold text-ink-900">{card.title}</h3>
                  <p className="mt-2 text-sm leading-relaxed text-ink-600">{card.body}</p>
                </div>
              ))}
            </div>
          </div>
        </section>
      )}

      {/* 5. Process */}
      <section className="mx-auto max-w-6xl px-5 py-16">
        <div className="overline text-brass-600">How it works</div>
        <h2 className="mt-2 font-display text-2xl font-semibold text-ink-900">
          From intake to signed report in three steps
        </h2>
        <div className="mt-8 grid gap-6 sm:grid-cols-3">
          {PROCESS_STEPS.map((s) => (
            <div key={s.step} className="rounded-lg border border-paper-300 bg-white p-6 shadow-card">
              <div className="tnum font-display text-3xl font-semibold text-bond-600">{s.step}</div>
              <h3 className="mt-3 font-display text-base font-semibold text-ink-900">{s.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-ink-600">{s.body}</p>
            </div>
          ))}
        </div>
      </section>

      {/* 6. Included */}
      <section className="border-t border-paper-300 bg-white">
        <div className="mx-auto max-w-6xl px-5 py-16">
          <div className="grid gap-10 lg:grid-cols-[1fr_1.2fr]">
            <div>
              <div className="overline text-brass-600">What’s included</div>
              <h2 className="mt-2 font-display text-2xl font-semibold text-ink-900">
                Everything in your {product.short} report
              </h2>
              <p className="mt-3 max-w-md text-sm leading-relaxed text-ink-600">{product.description}</p>
              <dl className="mt-6 grid max-w-md grid-cols-2 gap-4 text-sm">
                <div>
                  <dt className="text-ink-500">Price</dt>
                  <dd className="tnum font-semibold text-ink-900">from {formatUsd(product.priceCents)}</dd>
                </div>
                <div>
                  <dt className="text-ink-500">Final delivery</dt>
                  <dd className="font-semibold text-ink-900">{product.deliveryDays} business days</dd>
                </div>
              </dl>
              <Link
                to="/pricing"
                className="mt-6 inline-block rounded-md border border-ink-200 px-4 py-2.5 text-sm font-semibold text-ink-800 transition-colors hover:border-ink-400"
              >
                Configure in the pricing calculator
              </Link>
            </div>
            <ul className="space-y-3 text-sm text-ink-700">
              {(content?.included ?? product.bullets).map((line) => (
                <li key={line} className="flex gap-2.5">
                  <span className="text-bond-600">✓</span>
                  {line}
                </li>
              ))}
            </ul>
          </div>
        </div>
      </section>

      {/* 7. FAQ */}
      {content && content.faq.length > 0 && (
        <section className="mx-auto max-w-3xl px-5 py-16">
          <div className="overline text-brass-600">FAQ</div>
          <h2 className="mt-2 mb-8 font-display text-2xl font-semibold text-ink-900">
            Common {product.short} questions
          </h2>
          <FaqAccordion items={content.faq} />
        </section>
      )}

      {/* 8. Bottom CTA + disclaimer */}
      <section className="ledger-grid border-t border-ink-800 bg-ink-900 text-paper-50">
        <div className="mx-auto max-w-4xl px-5 py-16 text-center">
          <h2 className="font-display text-3xl font-semibold">
            {content?.ctaHeadline ?? `Get your ${product.name} started`}
          </h2>
          <div className="mt-8 flex flex-wrap items-center justify-center gap-4">
            <Link
              to="/register"
              className="rounded-md bg-bond-600 px-6 py-3 text-sm font-semibold text-white shadow-lift transition-colors hover:bg-bond-700"
            >
              {ctaLabel}
            </Link>
            <Link
              to="/pricing"
              className="rounded-md border border-ink-600 px-6 py-3 text-sm font-semibold text-paper-50 transition-colors hover:border-ink-400"
            >
              See pricing
            </Link>
          </div>
          {content && (
            <p className="mx-auto mt-8 max-w-2xl text-xs leading-relaxed text-ink-400">
              {content.disclaimer}
            </p>
          )}
        </div>
      </section>

      {/* Book a call + demo video (gap #22) */}
      <BookACallSection />

      {/* Related products */}
      <section className="border-t border-paper-300 bg-white">
        <div className="mx-auto max-w-6xl px-5 py-14">
          <div className="overline text-ink-400">Related products</div>
          <div className="mt-5 grid gap-4 sm:grid-cols-3">
            {related.map((p) => (
              <Link
                key={p.slug}
                to={`/products/${p.slug}`}
                className="group rounded-lg border border-paper-300 bg-paper-50 p-5 transition-shadow hover:shadow-lift"
              >
                <h3 className="font-display text-base font-semibold text-ink-900 group-hover:text-bond-700">
                  {p.name}
                </h3>
                <p className="mt-1.5 text-sm text-ink-600">{p.tagline}</p>
              </Link>
            ))}
          </div>
        </div>
      </section>
    </div>
  );
}
