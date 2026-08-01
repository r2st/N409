import { useState } from 'react';
import { Link } from 'react-router-dom';
import { QUIZ_OPTIONS, formatUsd, productBySlug } from '../../lib/marketing';
import { Seo } from '../../components/Seo';
import { pageMeta } from '../../lib/pageMeta';

/** "Which valuation?" guided quiz (409.ai §22.5). */
export function WhichValuationPage() {
  const [selected, setSelected] = useState<string | null>(null);
  const product = selected ? productBySlug(selected) : undefined;

  return (
    <div className="mx-auto max-w-4xl px-5 py-16">
      <Seo {...pageMeta('/which-valuation')!} />
      <div className="overline text-ink-400">Which valuation?</div>
      <h1 className="mt-2 font-display text-4xl font-semibold text-ink-900">
        What&rsquo;s driving the need for a valuation?
      </h1>
      <p className="mt-3 max-w-xl text-sm text-ink-600">
        Pick the situation that fits best — we&rsquo;ll point you at the right report.
      </p>

      <div className="mt-8 grid gap-3">
        {QUIZ_OPTIONS.map((option) => {
          const active = selected === option.productSlug;
          return (
            <button
              key={option.label}
              onClick={() => setSelected(option.productSlug)}
              className={`cursor-pointer rounded-lg border p-4 text-left transition-colors ${
                active
                  ? 'border-bond-600 bg-bond-50 ring-2 ring-bond-600/20'
                  : 'border-paper-300 bg-surface hover:border-ink-300'
              }`}
            >
              <span className="block text-sm font-semibold text-ink-900">{option.label}</span>
              {option.subtitle && (
                <span className="mt-0.5 block text-xs text-ink-500">{option.subtitle}</span>
              )}
            </button>
          );
        })}
      </div>

      {product && (
        <div
          className="mt-10 rounded-lg border border-bond-200 bg-surface p-6 shadow-lift"
          data-testid="quiz-result"
        >
          <div className="overline text-bond-700">Our recommendation</div>
          <h2 className="mt-2 font-display text-2xl font-semibold text-ink-900">{product.name}</h2>
          <p className="mt-2 max-w-xl text-sm leading-relaxed text-ink-600">{product.description}</p>
          <div className="mt-5 flex flex-wrap items-center gap-4">
            <Link
              to="/register"
              className="rounded-md bg-bond-600 px-5 py-2.5 text-sm font-semibold text-bond-fg shadow-card transition-colors hover:bg-bond-700"
            >
              Start my {product.short} valuation
            </Link>
            <Link
              to={`/products/${product.slug}`}
              className="text-sm font-semibold text-bond-600 hover:text-bond-700"
            >
              Learn more →
            </Link>
            <span className="tnum text-sm text-ink-500">
              from {formatUsd(product.priceCents)} · draft in 24h
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
