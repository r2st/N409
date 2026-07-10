import { describe, expect, it } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import { HelmetProvider } from 'react-helmet-async';
import {
  absoluteUrl,
  faqJsonLd,
  organizationJsonLd,
  pageTitle,
  productJsonLd,
  siteOrigin,
} from '../src/lib/seo';
import { Seo } from '../src/components/Seo';
import { PRODUCTS } from '../src/lib/marketing';

describe('seo helpers (§24)', () => {
  it('resolves the origin from env with a fallback and no trailing slash', () => {
    expect(siteOrigin({ VITE_SITE_URL: 'https://x.io/' })).toBe('https://x.io');
    expect(siteOrigin({})).toBe('https://www.n409.ai');
  });

  it('builds absolute urls without doubling slashes', () => {
    expect(absoluteUrl('/pricing', 'https://x.io')).toBe('https://x.io/pricing');
    expect(absoluteUrl('/', 'https://x.io')).toBe('https://x.io/');
    expect(absoluteUrl('https://other.com/a', 'https://x.io')).toBe('https://other.com/a');
  });

  it('composes titles with the brand suffix', () => {
    expect(pageTitle('Pricing')).toBe('Pricing · N409');
    expect(pageTitle('N409')).toBe('N409 · Valuations');
    expect(pageTitle('')).toBe('N409 · Valuations');
  });

  it('emits valid Organization JSON-LD', () => {
    const node = organizationJsonLd('https://x.io');
    expect(node['@type']).toBe('Organization');
    expect(node.url).toBe('https://x.io/');
  });

  it('emits Product JSON-LD with a USD offer', () => {
    const product = PRODUCTS[0]!;
    const node = productJsonLd(product, 'https://x.io');
    expect(node['@type']).toBe('Product');
    const offers = node.offers as Record<string, unknown>;
    expect(offers.priceCurrency).toBe('USD');
    expect(offers.price).toBe((product.priceCents / 100).toFixed(2));
  });

  it('emits FAQPage JSON-LD from items', () => {
    const node = faqJsonLd([{ q: 'Q?', a: 'A.' }]) as Record<string, unknown>;
    expect(node['@type']).toBe('FAQPage');
    expect((node.mainEntity as unknown[])).toHaveLength(1);
  });
});

describe('<Seo>', () => {
  it('sets the document title and head meta tags', async () => {
    render(
      <HelmetProvider>
        <Seo
          title="Pricing"
          description="Flat per-report pricing."
          path="/pricing"
          jsonLd={organizationJsonLd('https://x.io')}
        />
      </HelmetProvider>,
    );

    await waitFor(() => expect(document.title).toBe('Pricing · N409'));
    expect(document.querySelector('meta[name="description"]')?.getAttribute('content')).toBe(
      'Flat per-report pricing.',
    );
    expect(document.querySelector('meta[property="og:title"]')?.getAttribute('content')).toBe(
      'Pricing · N409',
    );
    expect(document.querySelector('meta[name="twitter:card"]')?.getAttribute('content')).toBe(
      'summary_large_image',
    );
    expect(document.querySelector('link[rel="canonical"]')?.getAttribute('href')).toContain(
      '/pricing',
    );
    expect(document.querySelector('script[type="application/ld+json"]')?.textContent).toContain(
      'Organization',
    );
  });
});
