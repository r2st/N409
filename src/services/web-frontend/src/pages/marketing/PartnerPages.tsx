import { Link, Navigate, useParams } from 'react-router-dom';
import {
  PARTNER_FAQ,
  PARTNER_MODELS,
  PARTNER_SEGMENTS,
  PROCESS_STEPS,
  partnerModelByKey,
  partnerSegmentBySlug,
  productBySlug,
} from '../../lib/marketing';
import { Seo } from '../../components/Seo';
import { partnerSegmentPageMeta, pageMeta } from '../../lib/pageMeta';
import { FaqAccordion } from '../../components/FaqAccordion';
import { siteConfig } from '../../lib/siteConfig';

/**
 * The public partner programme — `/partners` and `/partners/:segment`.
 *
 * The channel itself is not new: partner-scoped portals, white-label branding,
 * subdomains, partner-settled billing and a signed-webhook API have all shipped.
 * What was missing is any public statement that they exist, so the only way to
 * find the programme was to already be in it. Every capability named on these
 * pages is one the platform actually has — the commercial terms, which nobody
 * has set, route to the partnerships team rather than being invented here.
 */

/** Partnership enquiries go to the configured mailbox, or to /contact if unset. */
function PartnerCta({ label = 'Talk to the partnerships team' }: { label?: string }) {
  const { partnersEmail } = siteConfig();
  return partnersEmail ? (
    <a
      href={`mailto:${partnersEmail}`}
      className="rounded-md bg-bond-600 px-6 py-3 text-sm font-semibold text-bond-fg shadow-lift transition-colors hover:bg-bond-700"
    >
      {label}
    </a>
  ) : (
    <Link
      to="/contact"
      className="rounded-md bg-bond-600 px-6 py-3 text-sm font-semibold text-bond-fg shadow-lift transition-colors hover:bg-bond-700"
    >
      {label}
    </Link>
  );
}

function ModelCard({ modelKey }: { modelKey: (typeof PARTNER_MODELS)[number]['key'] }) {
  const model = partnerModelByKey(modelKey);
  return (
    <div className="rounded-lg border border-paper-300 bg-surface p-6 shadow-card">
      <h3 className="font-display text-lg font-semibold text-ink-900">{model.name}</h3>
      <p className="mt-2 text-sm leading-relaxed text-ink-600">{model.summary}</p>
      <dl className="mt-5 space-y-3 text-sm">
        <div>
          <dt className="overline text-xs text-ink-400">You</dt>
          <dd className="text-ink-700">{model.youDo}</dd>
        </div>
        <div>
          <dt className="overline text-xs text-ink-400">Us</dt>
          <dd className="text-ink-700">{model.weDo}</dd>
        </div>
        <div>
          <dt className="overline text-xs text-ink-400">Whose brand</dt>
          <dd className="text-ink-700">{model.brand}</dd>
        </div>
      </dl>
      <ul className="mt-5 space-y-2 border-t border-paper-200 pt-4 text-sm text-ink-700">
        {model.capabilities.map((c) => (
          <li key={c} className="flex gap-2.5">
            <span className="text-bond-600">✓</span>
            {c}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function PartnersPage() {
  return (
    <div>
      <Seo {...pageMeta('/partners')!} />

      <section className="ledger-grid bg-chrome-900 text-chrome-fg">
        <div className="mx-auto max-w-6xl px-5 py-20">
          <div className="overline mb-4 text-brass-400">Partner programme</div>
          <h1 className="max-w-3xl font-display text-4xl leading-tight font-medium sm:text-5xl">
            Offer valuations without building a valuation practice
          </h1>
          <p className="mt-5 max-w-2xl text-lg text-chrome-dim">
            Refer clients, put your own brand on the deliverable, or call the API from inside your product.
            Analyst-reviewed and dual-signed either way.
          </p>
          <div className="mt-8 flex flex-wrap items-center gap-4">
            <PartnerCta />
            <Link
              to="/developers"
              className="rounded-md border border-chrome-600 px-6 py-3 text-sm font-semibold text-chrome-fg transition-colors hover:border-chrome-faint"
            >
              Read the API docs
            </Link>
          </div>
        </div>
      </section>

      {/* Three ways to plug in */}
      <section className="mx-auto max-w-6xl px-5 py-16">
        <div className="overline text-brass-600">Three ways to plug in</div>
        <h2 className="mt-2 font-display text-2xl font-semibold text-ink-900">
          Pick how much of the engagement you want to own
        </h2>
        <div className="mt-8 grid gap-4 lg:grid-cols-3">
          {PARTNER_MODELS.map((model) => (
            <ModelCard key={model.key} modelKey={model.key} />
          ))}
        </div>
      </section>

      {/* Who it's for */}
      <section className="border-t border-paper-300 bg-surface">
        <div className="mx-auto max-w-6xl px-5 py-16">
          <div className="overline text-brass-600">Who it’s for</div>
          <h2 className="mt-2 font-display text-2xl font-semibold text-ink-900">
            Four kinds of partner, four different reasons
          </h2>
          <div className="mt-8 grid gap-4 sm:grid-cols-2">
            {PARTNER_SEGMENTS.map((segment) => (
              <Link
                key={segment.slug}
                to={`/partners/${segment.slug}`}
                className="group rounded-lg border border-paper-300 bg-paper-50 p-6 transition-colors hover:border-ink-300"
              >
                <h3 className="font-display text-lg font-semibold text-ink-900 group-hover:text-bond-700">
                  {segment.name}
                </h3>
                <p className="mt-2 text-sm leading-relaxed text-ink-600">{segment.heroSubhead}</p>
                <span className="mt-4 inline-block text-sm font-semibold text-bond-600 group-hover:text-bond-700">
                  How it works for you →
                </span>
              </Link>
            ))}
          </div>
        </div>
      </section>

      {/* From your product to a signed report */}
      <section className="mx-auto max-w-6xl px-5 py-16">
        <div className="overline text-brass-600">How delivery works</div>
        <h2 className="mt-2 font-display text-2xl font-semibold text-ink-900">
          From your introduction to a signed report
        </h2>
        <div className="mt-8 grid gap-6 sm:grid-cols-3">
          {PROCESS_STEPS.map((s) => (
            <div key={s.step} className="rounded-lg border border-paper-300 bg-surface p-6 shadow-card">
              <div className="tnum font-display text-3xl font-semibold text-bond-600">{s.step}</div>
              <h3 className="mt-3 font-display text-base font-semibold text-ink-900">{s.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-ink-600">{s.body}</p>
            </div>
          ))}
        </div>
      </section>

      {/* FAQ */}
      <section className="mx-auto max-w-3xl px-5 py-16">
        <div className="overline text-brass-600">FAQ</div>
        <h2 className="mt-2 mb-8 font-display text-2xl font-semibold text-ink-900">Partner questions</h2>
        <FaqAccordion items={PARTNER_FAQ} />
      </section>

      <section className="ledger-grid border-t border-chrome-800 bg-chrome-900 text-chrome-fg">
        <div className="mx-auto max-w-4xl px-5 py-16 text-center">
          <h2 className="font-display text-3xl font-semibold">Start a partnership</h2>
          <p className="mx-auto mt-4 max-w-xl text-chrome-dim">
            Tell us which model fits and roughly what volume you expect, and we will come back with terms.
          </p>
          <div className="mt-8 flex flex-wrap items-center justify-center gap-4">
            <PartnerCta />
          </div>
        </div>
      </section>
    </div>
  );
}

export function PartnerSegmentPage() {
  const { segment: slug } = useParams<{ segment: string }>();
  const segment = slug ? partnerSegmentBySlug(slug) : undefined;
  if (!segment) return <Navigate to="/partners" replace />;
  const model = partnerModelByKey(segment.recommendedModel);
  const products = segment.productSlugs.map((s) => productBySlug(s)!).filter(Boolean);

  return (
    <div>
      <Seo {...partnerSegmentPageMeta(segment.slug)!} />

      <nav aria-label="Breadcrumb" className="border-b border-paper-300 bg-paper-100">
        <ol className="mx-auto flex max-w-6xl gap-2 px-5 py-3 text-xs text-ink-500">
          <li>
            <Link to="/" className="hover:text-ink-800">
              Home
            </Link>
          </li>
          <li aria-hidden="true">/</li>
          <li>
            <Link to="/partners" className="hover:text-ink-800">
              Partners
            </Link>
          </li>
          <li aria-hidden="true">/</li>
          <li className="font-semibold text-ink-700" aria-current="page">
            {segment.name}
          </li>
        </ol>
      </nav>

      <section className="ledger-grid bg-chrome-900 text-chrome-fg">
        <div className="mx-auto max-w-6xl px-5 py-20">
          <div className="overline mb-4 text-brass-400">Partner programme</div>
          <h1 className="max-w-3xl font-display text-4xl leading-tight font-medium sm:text-5xl">
            {segment.name}
          </h1>
          <p className="mt-5 max-w-2xl text-lg text-chrome-dim">{segment.heroSubhead}</p>
          <div className="mt-8 flex flex-wrap items-center gap-4">
            <PartnerCta />
            <Link
              to="/partners"
              className="rounded-md border border-chrome-600 px-6 py-3 text-sm font-semibold text-chrome-fg transition-colors hover:border-chrome-faint"
            >
              All partner models
            </Link>
          </div>
        </div>
      </section>

      {/* The problem */}
      <section className="mx-auto max-w-6xl px-5 py-16">
        <div className="grid gap-10 lg:grid-cols-[1.4fr_1fr]">
          <div>
            <div className="overline text-brass-600">The problem</div>
            <h2 className="mt-2 font-display text-2xl font-semibold text-ink-900">Why this lands on you</h2>
            <p className="mt-3 max-w-xl text-sm leading-relaxed text-ink-600">{segment.problem}</p>
            <ul className="mt-6 space-y-3 text-sm text-ink-700">
              {segment.bullets.map((b) => (
                <li key={b} className="flex gap-2.5">
                  <span className="text-ink-400">•</span>
                  {b}
                </li>
              ))}
            </ul>
          </div>
          <aside className="self-start rounded-lg border border-paper-300 bg-paper-100 p-5">
            <div className="overline text-ink-400">Report types you’ll send us</div>
            <ul className="mt-3 space-y-2 text-sm">
              {products.map((p) => (
                <li key={p.slug}>
                  <Link
                    to={`/products/${p.slug}`}
                    className="font-semibold text-bond-600 hover:text-bond-700"
                  >
                    {p.name}
                  </Link>
                  <span className="block text-ink-600">{p.tagline}</span>
                </li>
              ))}
            </ul>
          </aside>
        </div>
      </section>

      {/* The model that fits */}
      <section className="border-t border-paper-300 bg-surface">
        <div className="mx-auto max-w-6xl px-5 py-16">
          <div className="overline text-brass-600">Usually the best fit</div>
          <h2 className="mt-2 font-display text-2xl font-semibold text-ink-900">
            The {model.name.toLowerCase()} model
          </h2>
          <p className="mt-3 max-w-2xl text-sm leading-relaxed text-ink-600">
            Not a rule — partners mix models, and which one fits depends on whose brand the client should see.
            All three are available to every segment.
          </p>
          <div className="mt-8 grid gap-4 lg:grid-cols-3">
            {[model, ...PARTNER_MODELS.filter((m) => m.key !== model.key)].map((m) => (
              <ModelCard key={m.key} modelKey={m.key} />
            ))}
          </div>
        </div>
      </section>

      {/* FAQ */}
      <section className="mx-auto max-w-3xl px-5 py-16">
        <div className="overline text-brass-600">FAQ</div>
        <h2 className="mt-2 mb-8 font-display text-2xl font-semibold text-ink-900">
          {segment.name} questions
        </h2>
        <FaqAccordion items={segment.faq} />
      </section>

      {/* Other segments */}
      <section className="border-t border-paper-300 bg-surface">
        <div className="mx-auto max-w-6xl px-5 py-16">
          <div className="overline text-brass-600">Other partners</div>
          <h2 className="mt-2 font-display text-2xl font-semibold text-ink-900">
            Not quite you? Try one of these
          </h2>
          <div className="mt-8 grid gap-4 sm:grid-cols-3">
            {PARTNER_SEGMENTS.filter((s) => s.slug !== segment.slug).map((other) => (
              <Link
                key={other.slug}
                to={`/partners/${other.slug}`}
                className="group rounded-lg border border-paper-300 bg-paper-50 p-5 transition-colors hover:border-ink-300"
              >
                <h3 className="font-display text-base font-semibold text-ink-900 group-hover:text-bond-700">
                  {other.name}
                </h3>
              </Link>
            ))}
          </div>
        </div>
      </section>

      <section className="ledger-grid border-t border-chrome-800 bg-chrome-900 text-chrome-fg">
        <div className="mx-auto max-w-4xl px-5 py-16 text-center">
          <h2 className="font-display text-3xl font-semibold">Let’s talk</h2>
          <div className="mt-8 flex flex-wrap items-center justify-center gap-4">
            <PartnerCta />
          </div>
        </div>
      </section>
    </div>
  );
}
