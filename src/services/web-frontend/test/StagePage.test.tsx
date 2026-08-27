import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { HelmetProvider } from 'react-helmet-async';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { StagePage } from '../src/pages/marketing/StagePage';
import { ProductPage } from '../src/pages/marketing/ProductPage';
import { FUNDING_STAGES, formatUsd, productBySlug } from '../src/lib/marketing';
import { RAISE_BANDS } from '../src/lib/marketingContent';
import { FUNDING_STAGE_DETAILS, fundingStageBySlug, stagePriceRangeCents } from '../src/lib/marketingContent';
import { anyPageMeta } from '../src/lib/pageMetaRoutes';
import { marketingRoutes } from '../src/lib/routes';

/**
 * The funding-stage landing pages (`/409a-valuation/:stage`).
 *
 * Two things can silently break them. One is registration: a page that renders
 * but is absent from the sitemap or `pageMeta` is a page nobody will ever
 * arrive at, and nothing about it looks wrong locally. The other is the price —
 * it is derived from the same ladder the checkout charges, so a quote here that
 * stops tracking `RAISE_BANDS` advertises a number we do not honour.
 */

const mountStage = (slug: string) =>
  render(
    <HelmetProvider>
      <MemoryRouter initialEntries={[`/409a-valuation/${slug}`]}>
        <Routes>
          <Route path="/409a-valuation/:stage" element={<StagePage />} />
          <Route path="/" element={<div>home</div>} />
        </Routes>
      </MemoryRouter>
    </HelmetProvider>,
  );

const SLUGS = FUNDING_STAGES.map((s) => s.slug);

describe('stage pages: registration', () => {
  it('covers the six stages 409.ai publishes', () => {
    expect(SLUGS).toEqual(['pre-seed', 'seed', 'series-a', 'series-b', 'series-c', 'pre-ipo']);
  });

  it.each(SLUGS)('/409a-valuation/%s is in the sitemap', (slug) => {
    expect(marketingRoutes().map((r) => r.path)).toContain(`/409a-valuation/${slug}`);
  });

  it.each(SLUGS)('/409a-valuation/%s has head metadata and a stage FAQ', (slug) => {
    const meta = anyPageMeta(`/409a-valuation/${slug}`)!;
    expect(meta).toBeDefined();
    expect(meta.title).toContain('409A valuation');
    // The FAQ questions are why the page ranks, so they must reach the markup.
    const json = JSON.stringify(meta.jsonLd);
    expect(json).toContain('"@type":"FAQPage"');
    expect(json).toContain(fundingStageBySlug(slug)!.faq[0]!.q);
  });

  it('names the 409A product page as the breadcrumb parent', () => {
    const json = JSON.stringify(anyPageMeta('/409a-valuation/series-b')!.jsonLd);
    expect(json).toContain('/products/409a-valuation');
  });
});

describe('stage pages: rendering', () => {
  it.each(SLUGS)('renders %s with its own methodology sections', (slug) => {
    const stage = fundingStageBySlug(slug)!;
    mountStage(slug);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(`${stage.name} 409A valuations`);
    for (const section of stage.sections) {
      expect(screen.getByRole('heading', { name: section.title })).toBeInTheDocument();
    }
    for (const method of stage.methods) {
      expect(screen.getByText(method)).toBeInTheDocument();
    }
  });

  it('links every other stage so the set is crawlable from any one of them', () => {
    mountStage('seed');
    for (const other of FUNDING_STAGES.filter((s) => s.slug !== 'seed')) {
      expect(screen.getAllByRole('link', { name: new RegExp(other.name) }).length).toBeGreaterThan(0);
    }
  });

  it('redirects an unknown stage home rather than rendering an empty shell', () => {
    mountStage('series-z');
    expect(screen.getByText('home')).toBeInTheDocument();
  });

  it('gives each stage a distinct hero and search description', () => {
    const subheads = FUNDING_STAGE_DETAILS.map((s) => s.heroSubhead);
    expect(new Set(subheads).size).toBe(subheads.length);
    const blurbs = FUNDING_STAGE_DETAILS.map((s) => s.searchBlurb);
    expect(new Set(blurbs).size).toBe(blurbs.length);
  });
});

describe('stage pricing is derived, not written', () => {
  it('quotes the 409A entry price plus the stage’s own raise-band uplift', () => {
    const base = productBySlug('409a-valuation')!.priceCents;
    for (const stage of FUNDING_STAGE_DETAILS) {
      const { fromCents, toCents } = stagePriceRangeCents(stage);
      expect(fromCents).toBe(base + RAISE_BANDS[stage.bandRange[0]]!.upliftCents);
      expect(toCents).toBe(base + RAISE_BANDS[stage.bandRange[1]]!.upliftCents);
      expect(toCents).toBeGreaterThanOrEqual(fromCents);
    }
  });

  it('rises monotonically from pre-seed to Series C', () => {
    // Later stages have raised more, and the band ladder prices that. A stage
    // whose band went backwards would quote a late-stage company less than a
    // seed one.
    const ordered = ['pre-seed', 'seed', 'series-a', 'series-b', 'series-c'].map(
      (slug) => stagePriceRangeCents(fundingStageBySlug(slug)!).fromCents,
    );
    expect(ordered).toEqual([...ordered].sort((a, b) => a - b));
  });

  it('shows the derived figure on the page', () => {
    const stage = fundingStageBySlug('series-b')!;
    mountStage('series-b');
    const { fromCents } = stagePriceRangeCents(stage);
    expect(
      screen.getAllByText(new RegExp(formatUsd(fromCents).replace(/\$/g, '\\$'))).length,
    ).toBeGreaterThan(0);
  });

  it('clamps a band index that has fallen out of range', () => {
    // The bands are edited independently of the stages; an index past the end
    // must quote the top band rather than NaN on a page a prospect reads.
    const base = productBySlug('409a-valuation')!.priceCents;
    const top = RAISE_BANDS[RAISE_BANDS.length - 1]!.upliftCents;
    const rogue = { ...fundingStageBySlug('seed')!, bandRange: [-1, 99] as [number, number] };
    expect(stagePriceRangeCents(rogue)).toEqual({
      fromCents: base + RAISE_BANDS[0]!.upliftCents,
      toCents: base + top,
    });
  });
});

describe('the 409A product page is a real parent', () => {
  it('links to every stage page', () => {
    render(
      <HelmetProvider>
        <MemoryRouter initialEntries={['/products/409a-valuation']}>
          <Routes>
            <Route path="/products/:slug" element={<ProductPage />} />
          </Routes>
        </MemoryRouter>
      </HelmetProvider>,
    );
    for (const stage of FUNDING_STAGES) {
      const links = screen
        .getAllByRole('link')
        .map((a) => a.getAttribute('href'))
        .filter(Boolean);
      expect(links).toContain(`/409a-valuation/${stage.slug}`);
    }
  });

  it('does not show the stage block on other products', () => {
    render(
      <HelmetProvider>
        <MemoryRouter initialEntries={['/products/asc-718-valuation']}>
          <Routes>
            <Route path="/products/:slug" element={<ProductPage />} />
          </Routes>
        </MemoryRouter>
      </HelmetProvider>,
    );
    expect(screen.queryByText('What changes between pre-seed and pre-IPO')).toBeNull();
  });
});
