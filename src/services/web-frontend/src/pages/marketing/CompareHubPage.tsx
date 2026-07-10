import { Link } from 'react-router-dom';
import { FOUNDER_QUESTIONS, PROVIDER_CATEGORIES } from '../../lib/marketing';
import { Seo } from '../../components/Seo';

/**
 * Compare provider hub (409.ai, gap #30) — the overview page at
 * /compare/409a-valuation-providers. Categorises the 409A market into model
 * types, links out to each individual comparison page, and lists the questions
 * founders should ask any provider.
 */
export function CompareHubPage() {
  return (
    <div>
      <Seo
        title="409A valuation providers compared"
        description="A guide to the five kinds of 409A valuation provider — AI-native platforms, cap-table products, bundled providers, startup CPAs, and independent firms — and what founders should ask before choosing one."
        path="/compare/409a-valuation-providers"
      />

      <section className="mx-auto max-w-5xl px-5 py-16">
        <div className="overline text-ink-400">Compare</div>
        <h1 className="mt-2 font-display text-4xl font-semibold text-ink-900">
          409A valuation providers, compared
        </h1>
        <p className="mt-4 max-w-2xl text-sm leading-relaxed text-ink-600">
          Not all 409A providers work the same way. The market splits into five models, each with a different
          trade-off between speed, transparency, and cost. Here’s how they compare — and where N409 fits.
        </p>

        {/* Categories */}
        <div className="mt-10 space-y-4">
          {PROVIDER_CATEGORIES.map((cat) => (
            <div key={cat.title} className="rounded-lg border border-paper-300 bg-white p-6 shadow-card">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <h2 className="font-display text-lg font-semibold text-ink-900">{cat.title}</h2>
                <div className="flex flex-wrap gap-2">
                  {cat.providers.map((p) =>
                    p.slug ? (
                      <Link
                        key={p.name}
                        to={`/compare/${p.slug}`}
                        className="rounded-full border border-bond-200 bg-bond-50 px-3 py-1 text-xs font-semibold text-bond-700 hover:bg-bond-100"
                      >
                        N409 vs {p.name} →
                      </Link>
                    ) : (
                      <span
                        key={p.name}
                        className="rounded-full bg-ink-900 px-3 py-1 text-xs font-semibold text-paper-50"
                      >
                        {p.name}
                      </span>
                    ),
                  )}
                </div>
              </div>
              <p className="mt-3 text-sm leading-relaxed text-ink-600">{cat.description}</p>
              <p className="mt-3 text-xs font-medium text-ink-500">
                <span className="text-brass-600">Trade-off:</span> {cat.tradeoff}
              </p>
            </div>
          ))}
        </div>
      </section>

      {/* What founders should ask */}
      <section className="border-t border-paper-300 bg-white">
        <div className="mx-auto max-w-5xl px-5 py-16">
          <div className="overline text-brass-600">Before you choose</div>
          <h2 className="mt-2 font-display text-2xl font-semibold text-ink-900">
            What founders should ask any 409A provider
          </h2>
          <div className="mt-8 grid gap-4 sm:grid-cols-2">
            {FOUNDER_QUESTIONS.map((item) => (
              <div key={item.q} className="rounded-lg border border-paper-300 bg-paper-50 p-5">
                <h3 className="font-display text-base font-semibold text-ink-900">{item.q}</h3>
                <p className="mt-2 text-sm leading-relaxed text-ink-600">{item.why}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="ledger-grid border-t border-ink-800 bg-ink-900 text-paper-50">
        <div className="mx-auto max-w-4xl px-5 py-16 text-center">
          <h2 className="font-display text-3xl font-semibold">See how N409 stacks up</h2>
          <p className="mx-auto mt-3 max-w-xl text-sm text-ink-300">
            AI-assisted intake, a transparent engine, credentialed analyst review, and per-report pricing
            across 13 report types.
          </p>
          <div className="mt-8 flex flex-wrap items-center justify-center gap-4">
            <Link
              to="/register"
              className="rounded-md bg-bond-600 px-6 py-3 text-sm font-semibold text-white shadow-lift transition-colors hover:bg-bond-700"
            >
              Start my valuation
            </Link>
            <Link
              to="/pricing"
              className="rounded-md border border-ink-600 px-6 py-3 text-sm font-semibold text-paper-50 transition-colors hover:border-ink-400"
            >
              See pricing
            </Link>
          </div>
        </div>
      </section>
    </div>
  );
}
