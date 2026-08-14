import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { HelmetProvider } from 'react-helmet-async';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { SiteConfig } from '../src/lib/siteConfig';

// The CTA reads the partnerships mailbox out of build-time config, which is
// inlined before the test runs — mocked so both the configured and the
// unconfigured site are exercised.
const configMock = vi.hoisted(() => ({ current: { socialLinks: [] } as SiteConfig }));
vi.mock('../src/lib/siteConfig', () => ({ siteConfig: () => configMock.current }));

import { PartnerSegmentPage, PartnersPage } from '../src/pages/marketing/PartnerPages';
import {
  PARTNER_FAQ,
  PARTNER_MODELS,
  PARTNER_SEGMENTS,
  partnerSegmentBySlug,
  productBySlug,
} from '../src/lib/marketing';
import { pageMeta } from '../src/lib/pageMeta';
import { marketingRoutes } from '../src/lib/routes';

/**
 * The public partner programme.
 *
 * Two failure modes are guarded here. The first is registration, as everywhere
 * on the marketing site: an unlisted page is an invisible one. The second is
 * specific to this surface — the pages describe commercial arrangements, and
 * the one thing they must not do is invent terms. Nobody has set a referral fee
 * or a wholesale rate, so no page may quote one; the standing check is that a
 * currency figure cannot appear in the model copy without someone deciding it.
 */

const mountHub = () =>
  render(
    <HelmetProvider>
      <MemoryRouter initialEntries={['/partners']}>
        <Routes>
          <Route path="/partners" element={<PartnersPage />} />
        </Routes>
      </MemoryRouter>
    </HelmetProvider>,
  );

const mountSegment = (slug: string) =>
  render(
    <HelmetProvider>
      <MemoryRouter initialEntries={[`/partners/${slug}`]}>
        <Routes>
          <Route path="/partners/:segment" element={<PartnerSegmentPage />} />
          <Route path="/partners" element={<div>hub</div>} />
        </Routes>
      </MemoryRouter>
    </HelmetProvider>,
  );

const SLUGS = PARTNER_SEGMENTS.map((s) => s.slug);

describe('partner pages: registration', () => {
  it('covers the four segments and the three models', () => {
    expect(SLUGS).toEqual([
      'cap-table-platforms',
      'accounting-law-firms',
      'funds-accelerators',
      'fintech-hr-platforms',
    ]);
    expect(PARTNER_MODELS.map((m) => m.key)).toEqual(['referral', 'co_branded', 'api']);
  });

  it.each(['/partners', ...SLUGS.map((s) => `/partners/${s}`)])('%s is in the sitemap', (path) => {
    expect(marketingRoutes().map((r) => r.path)).toContain(path);
  });

  it.each(['/partners', ...SLUGS.map((s) => `/partners/${s}`)])('%s has head metadata', (path) => {
    const meta = pageMeta(path)!;
    expect(meta).toBeDefined();
    expect(meta.title).toBeTruthy();
    expect(meta.description.length).toBeGreaterThan(80);
  });
});

describe('partner hub', () => {
  it('renders all three integration models with their capabilities', () => {
    mountHub();
    for (const model of PARTNER_MODELS) {
      expect(screen.getByRole('heading', { name: model.name })).toBeInTheDocument();
      for (const capability of model.capabilities) {
        expect(screen.getByText(capability)).toBeInTheDocument();
      }
    }
  });

  it('links to every segment page and to the developer docs', () => {
    mountHub();
    const hrefs = screen.getAllByRole('link').map((a) => a.getAttribute('href'));
    for (const slug of SLUGS) expect(hrefs).toContain(`/partners/${slug}`);
    expect(hrefs).toContain('/developers');
  });

  it('sends partnership enquiries to the configured mailbox', () => {
    configMock.current = { socialLinks: [], partnersEmail: 'partners@n409.io' };
    mountHub();
    expect(screen.getAllByRole('link', { name: /partnerships team/i })[0]).toHaveAttribute(
      'href',
      'mailto:partners@n409.io',
    );
    configMock.current = { socialLinks: [] };
  });

  it('falls back to /contact when no mailbox is configured', () => {
    configMock.current = { socialLinks: [] };
    mountHub();
    // A mailto: to an address nobody reads is worse than a contact form.
    expect(screen.getAllByRole('link', { name: /partnerships team/i })[0]).toHaveAttribute(
      'href',
      '/contact',
    );
  });
});

describe('partner segment pages', () => {
  it.each(SLUGS)('%s states its own problem and report types', (slug) => {
    const segment = partnerSegmentBySlug(slug)!;
    mountSegment(slug);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(segment.name);
    expect(screen.getByText(segment.problem)).toBeInTheDocument();
    for (const productSlug of segment.productSlugs) {
      expect(screen.getByRole('link', { name: productBySlug(productSlug)!.name })).toBeInTheDocument();
    }
  });

  it.each(SLUGS)('%s cross-links the other three segments', (slug) => {
    mountSegment(slug);
    const hrefs = screen.getAllByRole('link').map((a) => a.getAttribute('href'));
    for (const other of SLUGS.filter((s) => s !== slug)) {
      expect(hrefs).toContain(`/partners/${other}`);
    }
  });

  it('offers all three models on every segment, recommended one first', () => {
    const segment = partnerSegmentBySlug('cap-table-platforms')!;
    mountSegment(segment.slug);
    const shown = screen
      .getAllByRole('heading', { level: 3 })
      .map((h) => h.textContent)
      .filter((t) => PARTNER_MODELS.some((m) => m.name === t));
    expect(shown).toHaveLength(PARTNER_MODELS.length);
    expect(shown[0]).toBe(PARTNER_MODELS.find((m) => m.key === segment.recommendedModel)!.name);
  });

  it('names every recommended model and product that exists', () => {
    for (const segment of PARTNER_SEGMENTS) {
      expect(PARTNER_MODELS.map((m) => m.key)).toContain(segment.recommendedModel);
      for (const slug of segment.productSlugs) {
        expect(productBySlug(slug), `${segment.slug} → ${slug}`).toBeDefined();
      }
    }
  });

  it('redirects an unknown segment to the hub', () => {
    mountSegment('shoe-shops');
    expect(screen.getByText('hub')).toBeInTheDocument();
  });
});

describe('the programme quotes no terms nobody has set', () => {
  it('names no referral fee or wholesale discount', () => {
    // 409.ai publishes "$150 per report"; we have no such agreed number, and a
    // figure written to fill the gap is a price we could not honour. If this
    // fails because the business has actually set terms, update the copy and
    // this expectation together.
    const copy = [
      ...PARTNER_MODELS.flatMap((m) => [m.summary, m.youDo, m.weDo, m.brand, ...m.capabilities]),
      ...PARTNER_SEGMENTS.flatMap((s) => [s.problem, s.heroSubhead, ...s.bullets]),
    ].join(' ');
    expect(copy).not.toMatch(/\$\s?\d/);
    expect(copy).not.toMatch(/\b\d+\s?%\b/);
  });

  it('routes the money question to the partnerships team', () => {
    const cost = PARTNER_FAQ.find((item) => /cost/i.test(item.q))!;
    expect(cost.a).toMatch(/partnerships team/i);
  });
});
