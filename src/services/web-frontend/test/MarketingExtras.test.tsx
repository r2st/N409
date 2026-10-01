import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import type { SiteConfig } from '../src/lib/siteConfig';

// The components read their external links through siteConfig(), which resolves
// build-time `import.meta.env` defines. Those are inlined as literals before the
// test runs, so the module is mocked to exercise both the configured and the
// unconfigured site.
const configMock = vi.hoisted(() => ({ current: { socialLinks: [] } as SiteConfig }));
vi.mock('../src/lib/siteConfig', () => ({ siteConfig: () => configMock.current }));

import {
  BookACallSection,
  PartnerLogos,
  ProofSection,
  TestimonialsSection,
} from '../src/pages/marketing/MarketingSections';
import { MarketingFooter } from '../src/components/MarketingLayout';
import { PricingPage } from '../src/pages/marketing/PricingPage';
import { PARTNER_LOGOS, PROOF_POINTS, TESTIMONIALS } from '../src/lib/marketing';

function configure(config: Partial<SiteConfig>) {
  configMock.current = { socialLinks: [], ...config };
}

afterEach(() => {
  configure({});
});

describe('testimonials (gap #20)', () => {
  it('renders nothing while we hold no permissioned quotes', () => {
    // Invented endorsements attributed to named people are a fabricated
    // testimonial (FTC 16 CFR §255); an empty carousel shell is no better.
    const { container } = render(<TestimonialsSection />);
    expect(TESTIMONIALS).toHaveLength(0);
    expect(container).toBeEmptyDOMElement();
  });
});

describe('proof section', () => {
  it('states what the delivered report contains', () => {
    render(
      <MemoryRouter>
        <ProofSection />
      </MemoryRouter>,
    );
    for (const point of PROOF_POINTS) {
      expect(screen.getByText(point.title)).toBeInTheDocument();
    }
  });

  it('offers a sample report instead of a third-party endorsement', () => {
    render(
      <MemoryRouter>
        <ProofSection />
      </MemoryRouter>,
    );
    expect(screen.getByRole('link', { name: /sample report/i })).toHaveAttribute('href', '/contact');
  });
});

describe('accounting integrations strip (gap #21)', () => {
  it('renders every integration badge', () => {
    render(<PartnerLogos />);
    for (const logo of PARTNER_LOGOS) {
      expect(screen.getByText(logo.name)).toBeInTheDocument();
    }
  });

  it('describes them as integrations, not as customers', () => {
    // These vendors are software we connect to. A "trusted-by" framing over
    // their names claims an endorsement none of them has given.
    const { container } = render(<PartnerLogos />);
    expect(container.textContent).not.toMatch(/trusted by/i);
    expect(screen.getByText(/books you already keep/i)).toBeInTheDocument();
  });
});

describe('book a call + demo video (gap #22)', () => {
  it('routes to the contact page when no booking link is configured', () => {
    render(
      <MemoryRouter>
        <BookACallSection />
      </MemoryRouter>,
    );
    expect(screen.getByRole('link', { name: /talk to an analyst/i })).toHaveAttribute('href', '/contact');
    expect(screen.queryByRole('link', { name: 'Book a call' })).toBeNull();
  });

  it('links out to the calendar when one is configured', () => {
    configure({ calendlyUrl: 'https://calendly.com/n409/30min' });
    render(
      <MemoryRouter>
        <BookACallSection />
      </MemoryRouter>,
    );
    const link = screen.getByRole('link', { name: 'Book a call' });
    expect(link).toHaveAttribute('href', 'https://calendly.com/n409/30min');
    expect(link).toHaveAttribute('rel', expect.stringContaining('noopener'));
  });

  it('omits the video entirely when none is configured', () => {
    render(
      <MemoryRouter>
        <BookACallSection />
      </MemoryRouter>,
    );
    expect(screen.queryByRole('button', { name: /play the n409 product demo/i })).toBeNull();
    expect(screen.queryByText(/watch the demo/i)).toBeNull();
    expect(document.querySelector('iframe')).toBeNull();
  });

  it('lazy-loads a configured video only after the user clicks', async () => {
    configure({ demoVideoUrl: 'https://www.youtube-nocookie.com/embed/abc123' });
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <BookACallSection />
      </MemoryRouter>,
    );

    // No third-party frame or cookie is requested on page load.
    expect(document.querySelector('iframe')).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Play the DoAide 409A product demo' }));
    expect(document.querySelector('iframe')?.getAttribute('src')).toContain(
      'youtube-nocookie.com/embed/abc123',
    );
  });
});

describe('firms & partners tier (gap #32)', () => {
  it('routes the enterprise CTA through /contact when no address is configured', () => {
    render(
      <MemoryRouter>
        <PricingPage />
      </MemoryRouter>,
    );
    const ctas = screen.getAllByRole('link', { name: 'Get in touch' });
    expect(ctas.every((el) => el.getAttribute('href') === '/contact')).toBe(true);
    expect(document.querySelector('a[href^="mailto:"]')).toBeNull();
  });

  it('uses a mailto CTA once a partner address is configured', () => {
    configure({ partnersEmail: 'partners@doaide.com' });
    render(
      <MemoryRouter>
        <PricingPage />
      </MemoryRouter>,
    );
    const mailto = screen
      .getAllByRole('link', { name: 'Get in touch' })
      .find((el) => el.getAttribute('href')?.startsWith('mailto:'));
    expect(mailto?.getAttribute('href')).toContain('partners@doaide.com');
    expect(screen.getByText('partners@doaide.com')).toBeInTheDocument();
  });
});

describe('footer social links (gap #29)', () => {
  it('omits the social nav when no profiles are configured', () => {
    render(
      <MemoryRouter>
        <MarketingFooter />
      </MemoryRouter>,
    );
    expect(screen.queryByRole('navigation', { name: 'Social media' })).toBeNull();
  });

  it('renders the configured profiles with safe rel attributes', () => {
    const socialLinks = [
      { label: 'X (Twitter)', href: 'https://x.com/n409' },
      { label: 'LinkedIn', href: 'https://www.linkedin.com/company/n409/' },
    ];
    configure({ socialLinks });
    render(
      <MemoryRouter>
        <MarketingFooter />
      </MemoryRouter>,
    );
    const social = screen.getByRole('navigation', { name: 'Social media' });
    for (const link of socialLinks) {
      const anchor = within(social).getByRole('link', { name: link.label });
      expect(anchor).toHaveAttribute('href', link.href);
      expect(anchor).toHaveAttribute('rel', expect.stringContaining('noopener'));
    }
  });

  it('shows the current year in the copyright line', () => {
    render(
      <MemoryRouter>
        <MarketingFooter />
      </MemoryRouter>,
    );
    expect(screen.getByText(new RegExp(`©\\s*${new Date().getFullYear()}\\s+DoAide`))).toBeInTheDocument();
  });
});
