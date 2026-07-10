import { Link, Navigate, useParams } from 'react-router-dom';
import { formatUsd, productBySlug, PRODUCTS } from '../../lib/marketing';

/** Data-driven product landing page (409.ai §22.2) — one per valuation kind. */
export function ProductPage() {
  const { slug } = useParams<{ slug: string }>();
  const product = slug ? productBySlug(slug) : undefined;
  if (!product) return <Navigate to="/" replace />;

  const related = PRODUCTS.filter((p) => p.slug !== product.slug).slice(0, 3);

  return (
    <div>
      <section className="ledger-grid bg-ink-900 text-paper-50">
        <div className="mx-auto max-w-6xl px-5 py-20">
          <div className="overline mb-4 text-brass-400">{product.audience}</div>
          <h1 className="max-w-2xl font-display text-4xl leading-tight font-medium sm:text-5xl">
            {product.name}
          </h1>
          <p className="mt-5 max-w-xl text-lg text-ink-300">{product.tagline}</p>
          <div className="mt-8 flex flex-wrap items-center gap-5">
            <Link
              to="/register"
              className="rounded-md bg-bond-600 px-6 py-3 text-sm font-semibold text-white shadow-lift transition-colors hover:bg-bond-700"
            >
              Start my valuation
            </Link>
            <span className="tnum text-sm text-ink-300">
              from <span className="font-semibold text-paper-50">{formatUsd(product.priceCents)}</span> ·{' '}
              {product.deliveryDays} business days
            </span>
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-5 py-16">
        <div className="grid gap-10 lg:grid-cols-[1.4fr_1fr]">
          <div>
            <h2 className="font-display text-2xl font-semibold text-ink-900">What you get</h2>
            <p className="mt-3 max-w-xl text-sm leading-relaxed text-ink-600">{product.description}</p>
            <ul className="mt-6 space-y-3 text-sm text-ink-700">
              {product.bullets.map((b) => (
                <li key={b} className="flex gap-2.5">
                  <span className="text-bond-600">✓</span>
                  {b}
                </li>
              ))}
            </ul>
          </div>
          <div className="rounded-lg border border-paper-300 bg-white p-6 shadow-card">
            <div className="overline text-ink-400">At a glance</div>
            <dl className="mt-4 space-y-3 text-sm">
              <div className="flex justify-between">
                <dt className="text-ink-500">Price</dt>
                <dd className="tnum font-semibold text-ink-900">from {formatUsd(product.priceCents)}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-ink-500">First draft</dt>
                <dd className="font-semibold text-ink-900">24 hours</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-ink-500">Final delivery</dt>
                <dd className="font-semibold text-ink-900">{product.deliveryDays} business days</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-ink-500">Express option</dt>
                <dd className="font-semibold text-ink-900">1 business day</dd>
              </div>
            </dl>
            <Link
              to="/pricing"
              className="mt-5 block rounded-md border border-ink-200 px-4 py-2.5 text-center text-sm font-semibold text-ink-800 transition-colors hover:border-ink-400"
            >
              Configure in the pricing calculator
            </Link>
          </div>
        </div>
      </section>

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
