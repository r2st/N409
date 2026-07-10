import { useState } from 'react';
import {
  CALENDLY_URL,
  DEMO_VIDEO_EMBED_URL,
  DEMO_VIDEO_TITLE,
  PARTNER_LOGOS,
  TESTIMONIALS,
} from '../../lib/marketing';

/**
 * Shared marketing sections (409.ai gaps #20–#22): the testimonial carousel,
 * the "Trusted by" partner-logo strip, and the "Book a call / watch demo"
 * block. Reused by the landing page and the product pages so the CTAs stay in
 * one place.
 */

/** Neutral wordmark badge — we don't ship trademarked vendor logos (gap #21). */
function PartnerBadge({ name, accent }: { name: string; accent: string }) {
  return (
    <div className="flex h-12 items-center justify-center rounded-lg border border-paper-300 bg-white px-6 shadow-card">
      <span className={`font-display text-lg font-semibold tracking-tight ${accent}`}>{name}</span>
    </div>
  );
}

/** Gap #21 — "Trusted by" logo strip using placeholder wordmark badges. */
export function PartnerLogos() {
  return (
    <section className="border-y border-paper-300 bg-paper-100">
      <div className="mx-auto max-w-6xl px-5 py-12">
        <p className="overline text-center text-ink-400">
          Trusted by finance teams at growing companies
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

/** Gap #20 — 3-card testimonial carousel with prev/next navigation. */
export function TestimonialsSection() {
  const [index, setIndex] = useState(0);
  const count = TESTIMONIALS.length;
  const active = TESTIMONIALS[index]!;
  const go = (delta: number) => setIndex((i) => (i + delta + count) % count);

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
 * Gap #22 — "Book a call" + demo video. The video iframe loads only after the
 * user clicks the thumbnail (a click-to-load facade) so no third-party frame
 * or cookie is requested on page load — keeps the bundle and privacy footprint
 * clean.
 */
export function BookACallSection() {
  const [videoLoaded, setVideoLoaded] = useState(false);

  return (
    <section className="border-y border-paper-300 bg-paper-100">
      <div className="mx-auto grid max-w-6xl gap-10 px-5 py-20 lg:grid-cols-2 lg:items-center">
        <div>
          <div className="overline text-ink-400">See it first</div>
          <h2 className="mt-2 font-display text-3xl font-semibold text-ink-900">
            Prefer to talk it through?
          </h2>
          <p className="mt-3 max-w-md text-sm leading-relaxed text-ink-600">
            Book a 30-minute call with a valuation analyst — no sales pitch, just answers about your
            situation, timeline, and which report you need. Or watch the two-minute product demo.
          </p>
          <div className="mt-7 flex flex-wrap items-center gap-4">
            <a
              href={CALENDLY_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="rounded-md bg-bond-600 px-6 py-3 text-sm font-semibold text-white shadow-lift transition-colors hover:bg-bond-700"
            >
              Book a call
            </a>
            {!videoLoaded && (
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

        <div className="overflow-hidden rounded-xl border border-paper-300 bg-ink-900 shadow-lift">
          <div className="relative aspect-video">
            {videoLoaded ? (
              <iframe
                className="absolute inset-0 h-full w-full"
                src={`${DEMO_VIDEO_EMBED_URL}?autoplay=1&rel=0`}
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
      </div>
    </section>
  );
}
