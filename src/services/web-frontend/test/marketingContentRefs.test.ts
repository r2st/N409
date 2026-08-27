import { describe, expect, it } from 'vitest';
import { COMPARISONS, FUNDING_STAGES, PARTNER_SEGMENTS } from '../src/lib/marketing';
import {
  COMPARISON_DETAILS,
  FUNDING_STAGE_DETAILS,
  PARTNER_SEGMENT_DETAILS,
  comparisonBySlug,
  fundingStageBySlug,
  partnerSegmentBySlug,
} from '../src/lib/marketingContent';

/**
 * The two halves of the three slug-driven marketing page families name the same
 * pages, in the same order, by the same name.
 *
 * `marketing.ts` holds the identities and `marketingContent.ts` holds the
 * bodies, because the header menu and the footer link to all seventeen of these
 * pages from the landing page — so while the prose sat next to the links, every
 * first visit downloaded it. The cost of that split is that a page can now be
 * added to one half and not the other: a link in the nav that renders a
 * redirect to `/`, or a page with a body, a sitemap entry and no way to reach
 * it. Neither is visible in a type error, and both are invisible in a test that
 * mounts one page at a time.
 *
 * Order matters as well as membership: the nav renders the ref list and the
 * "other stages" strips render the detail list, so a reordering that touched
 * only one of them would show the reader two different sequences.
 */
describe('the marketing content split names one set of pages', () => {
  const cases = [
    {
      what: 'comparisons',
      refs: COMPARISONS.map((c) => ({ slug: c.slug, name: c.competitor })),
      details: COMPARISON_DETAILS.map((c) => ({ slug: c.slug, name: c.competitor })),
      bySlug: comparisonBySlug as (slug: string) => unknown,
    },
    {
      what: 'funding stages',
      refs: FUNDING_STAGES.map((s) => ({ slug: s.slug, name: s.name })),
      details: FUNDING_STAGE_DETAILS.map((s) => ({ slug: s.slug, name: s.name })),
      bySlug: fundingStageBySlug as (slug: string) => unknown,
    },
    {
      what: 'partner segments',
      refs: PARTNER_SEGMENTS.map((s) => ({ slug: s.slug, name: s.name })),
      details: PARTNER_SEGMENT_DETAILS.map((s) => ({ slug: s.slug, name: s.name })),
      bySlug: partnerSegmentBySlug as (slug: string) => unknown,
    },
  ];

  it.each(cases)('$what: the light half and the bodies agree exactly', ({ refs, details }) => {
    expect(refs).toEqual(details);
    expect(refs.length).toBeGreaterThan(0);
  });

  it.each(cases)('$what: every link in the nav resolves to a body', ({ refs, bySlug }) => {
    for (const ref of refs) expect(bySlug(ref.slug), ref.slug).toBeDefined();
  });
});
