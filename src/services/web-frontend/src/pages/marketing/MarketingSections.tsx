import { useState } from 'react';
import { Link } from 'react-router-dom';
import {
  DEMO_VIDEO_TITLE,
  PARTNER_LOGOS,
  PROOF_POINTS,
  TESTIMONIALS,
} from '../../lib/marketing';
import { siteConfig } from '../../lib/siteConfig';

/**
 * Shared marketing sections (409.ai gaps #20–#22): the testimonial carousel,
 * the accounting-integrations strip, the verifiable-proof block, and the
 * "Book a call / watch demo" block. Reused by the landing page and the product
 * pages so the CTAs stay in one place.
 */

/** Neutral wordmark badge — we don't ship trademarked vendor logos (gap #21). */
function PartnerBadge({ name, accent }: { name: string; accent: string }) {
  return (
    <div className="flex h-12 items-center justify-center rounded-lg border border-paper-300 bg-white px-4 shadow-card sm:px-6">
      <span className={`font-display text-lg font-semibold tracking-tight ${accent}`}>{name}</span>
    </div>
  );
}

/**
 * Gap #21 — the accounting packages we connect to. Labelled as integrations,
 * not as customers: these vendors are not N409 users, and a "trusted-by" framing
 * over their names claims an endorsement none of them has given.
 */
export function PartnerLogos() {
  return (
    <section className="border-y border-paper-300 bg-paper-100">
      <div className="mx-auto max-w-6xl px-5 py-12">
        <p className="overline text-center text-ink-400">
          Pulls your financials straight from the books you already keep
        </p>
        <div className="mt-8 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
          {PARTNER_LOGOS.map((logo) => (
            <PartnerBadge key={logo.name} name={logo.name} accent={logo.accent} />
          ))}
        </div>
      </div>
    </section>
  );
}

/**
 * Proof that does not depend on a third party vouching for us: what the
 * delivered report actually contains. Shown on the landing page whether or not
 * we have permissioned testimonials yet.
 */
export function ProofSection() {
  return (
    <section className="border-y border-paper-300 bg-white">
      <div className="mx-auto max-w-6xl px-5 py-20">
        <div className="overline text-ink-400">What you actually receive</div>
        <h2 className="mt-2 max-w-2xl font-display text-3xl font-semibold text-ink-900">
          Built to be checked, not just trusted
        </h2>
        <div className="mt-10 grid gap-8 md:grid-cols-3">
          {PROOF_POINTS.map((point) => (
            <div key={point.title}>
              <h3 className="font-display text-lg font-semibold text-ink-900">{point.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-ink-600">{point.body}</p>
            </div>
          ))}
        </div>
        <p className="mt-10 text-sm text-ink-600">
          Want to see a real one?{' '}
          <Link to="/contact" className="font-semibold text-bond-600 hover:text-bond-700">
            Ask us for a sample report
          </Link>
          .
        </p>
      </div>
    </section>
  );
}

/**
 * Gap #20 — testimonial carousel. Renders nothing until we hold real,
 * permissioned quotes (see `TESTIMONIALS`); an empty carousel shell reads worse
 * than no section at all, and invented quotes are not an option.
 */
export function TestimonialsSection() {
  const [index, setIndex] = useState(0);
  const count = TESTIMONIALS.length;
  const active = TESTIMONIALS[index % Math.max(count, 1)];
  const go = (delta: number) => setIndex((i) => (i + delta + count) % count);

  if (!active) return null;

  return (
    <section className="border-y border-paper-300 bg-white">
      <div className="mx-auto max-w-4xl px-5 py-20">
        <div className="overline text-center text-ink-400">Hear it from our customers</div>
        <h2 className="mt-2 text-center font-display text-3xl font-semibold text-ink-900">
          Valuations founders and CFOs stand behind
        </h2>

        <figure
          className="mt-10 rounded-xl border border-paper-300 bg-paper-50 p-8 shadow-card sm:p-10"
          aria-roledescription="carousel"
          aria-label="Customer testimonials"
        >
          <blockquote className="font-display text-xl leading-relaxed text-ink-800 sm:text-2xl">
            “{active.quote}”
          </blockquote>
          <figcaption className="mt-8 flex items-center gap-4">
            <div
              aria-hidden="true"
              className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-ink-900 font-display text-sm font-semibold text-brass-300"
            >
              {active.monogram}
            </div>
            <div>
              <div className="font-semibold text-ink-900">{active.name}</div>
              <div className="text-sm text-ink-500">
                {active.role} · {active.company}
              </div>
            </div>
          </figcaption>
        </figure>

        <div className="mt-6 flex items-center justify-center gap-4">
          <button
            type="button"
            onClick={() => go(-1)}
            aria-label="Previous testimonial"
            className="flex h-10 w-10 cursor-pointer items-center justify-center rounded-full border border-ink-200 bg-white text-ink-700 transition-colors hover:border-ink-400 hover:text-ink-900"
          >
            <span aria-hidden="true">‹</span>
          </button>
          <div className="flex gap-2" role="tablist" aria-label="Select testimonial">
            {TESTIMONIALS.map((t, i) => (
              <button
                key={t.company}
                type="button"
                role="tab"
                aria-selected={i === index}
                aria-label={`Testimonial ${i + 1}: ${t.company}`}
                onClick={() => setIndex(i)}
                className={`h-2.5 w-2.5 cursor-pointer rounded-full transition-colors ${
                  i === index ? 'bg-bond-600' : 'bg-ink-200 hover:bg-ink-300'
                }`}
              />
            ))}
          </div>
          <button
            type="button"
            onClick={() => go(1)}
            aria-label="Next testimonial"
            className="flex h-10 w-10 cursor-pointer items-center justify-center rounded-full border border-ink-200 bg-white text-ink-700 transition-colors hover:border-ink-400 hover:text-ink-900"
          >
            <span aria-hidden="true">›</span>
          </button>
        </div>
      </div>
    </section>
  );
}

/**
 * Gap #22 — "Book a call" + demo video. Both are environment-configured (see
 * `siteConfig`): with no booking link the CTA routes to /contact instead of a
 * dead calendar, and with no demo video the whole media column is dropped
 * rather than rendering a play button that plays nothing.
 *
 * When the video *is* configured, the iframe loads only after the user clicks
 * the thumbnail (a click-to-load facade) so no third-party frame or cookie is
 * requested on page load.
 */
export function BookACallSection() {
  const [videoLoaded, setVideoLoaded] = useState(false);
  const { calendlyUrl, demoVideoUrl } = siteConfig();

  const bookingCta = calendlyUrl ? (
    <a
      href={calendlyUrl}
      target="_blank"
      rel="noopener noreferrer"
      className="rounded-md bg-bond-600 px-6 py-3 text-sm font-semibold text-white shadow-lift transition-colors hover:bg-bond-700"
    >
      Book a call
    </a>
  ) : (
    <Link
      to="/contact"
      className="rounded-md bg-bond-600 px-6 py-3 text-sm font-semibold text-white shadow-lift transition-colors hover:bg-bond-700"
    >
      Talk to an analyst
    </Link>
  );

  return (
    <section className="border-y border-paper-300 bg-paper-100">
      <div
        className={`mx-auto grid max-w-6xl gap-10 px-5 py-20 lg:items-center ${
          demoVideoUrl ? 'lg:grid-cols-2' : ''
        }`}
      >
        <div>
          <div className="overline text-ink-400">See it first</div>
          <h2 className="mt-2 font-display text-3xl font-semibold text-ink-900">
            Prefer to talk it through?
          </h2>
          <p className="mt-3 max-w-md text-sm leading-relaxed text-ink-600">
            Talk to a valuation analyst — no sales pitch, just answers about your situation, your
            timeline, and which report you actually need.
            {demoVideoUrl ? ' Or watch the two-minute product demo.' : ''}
          </p>
          <div className="mt-7 flex flex-wrap items-center gap-4">
            {bookingCta}
            {demoVideoUrl && !videoLoaded && (
              <button
                type="button"
                onClick={() => setVideoLoaded(true)}
                className="cursor-pointer text-sm font-semibold text-ink-700 hover:text-ink-900"
              >
                ▸ Watch the demo
              </button>
            )}
          </div>
        </div>

        {demoVideoUrl && (
          <div className="overflow-hidden rounded-xl border border-paper-300 bg-ink-900 shadow-lift">
            <div className="relative aspect-video">
              {videoLoaded ? (
                <iframe
                  className="absolute inset-0 h-full w-full"
                  src={`${demoVideoUrl}?autoplay=1&rel=0`}
                  title={DEMO_VIDEO_TITLE}
                  allow="accelerated-experiments; autoplay; encrypted-media; picture-in-picture"
                  allowFullScreen
                />
              ) : (
                <button
                  type="button"
                  onClick={() => setVideoLoaded(true)}
                  aria-label="Play the N409 product demo"
                  className="ledger-grid group absolute inset-0 flex cursor-pointer items-center justify-center"
                >
                  <span className="flex h-16 w-16 items-center justify-center rounded-full bg-white/90 text-ink-900 shadow-lift transition-transform group-hover:scale-110">
                    <span aria-hidden="true" className="ml-1 text-2xl">
                      ▸
                    </span>
                  </span>
                  <span className="absolute bottom-4 left-4 text-xs font-semibold text-paper-50">
                    {DEMO_VIDEO_TITLE} · 2 min
                  </span>
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
