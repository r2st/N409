import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import {
  BookACallSection,
  PartnerLogos,
  TestimonialsSection,
} from '../src/pages/marketing/MarketingSections';
import { MarketingFooter } from '../src/components/MarketingLayout';
import {
  CALENDLY_URL,
  PARTNER_LOGOS,
  SOCIAL_LINKS,
  TESTIMONIALS,
} from '../src/lib/marketing';

describe('testimonials carousel (gap #20)', () => {
  it('shows the first testimonial and advances with the next arrow', async () => {
    const user = userEvent.setup();
    render(<TestimonialsSection />);

    const first = TESTIMONIALS[0]!;
    expect(screen.getByText(`${first.role} · ${first.company}`)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Next testimonial' }));
    const second = TESTIMONIALS[1]!;
    expect(screen.getByText(`${second.role} · ${second.company}`)).toBeInTheDocument();
    expect(screen.queryByText(`${first.role} · ${first.company}`)).not.toBeInTheDocument();
  });

  it('wraps around when going back from the first card', async () => {
    const user = userEvent.setup();
    render(<TestimonialsSection />);
    await user.click(screen.getByRole('button', { name: 'Previous testimonial' }));
    const last = TESTIMONIALS[TESTIMONIALS.length - 1]!;
    expect(screen.getByText(`${last.role} · ${last.company}`)).toBeInTheDocument();
  });

  it('jumps to a card via its dot control', async () => {
    const user = userEvent.setup();
    render(<TestimonialsSection />);
    const third = TESTIMONIALS[2]!;
    await user.click(
      screen.getByRole('tab', { name: `Testimonial 3: ${third.company}` }),
    );
    expect(screen.getByText(`${third.role} · ${third.company}`)).toBeInTheDocument();
  });
});

describe('partner logo strip (gap #21)', () => {
  it('renders every partner badge', () => {
    render(<PartnerLogos />);
    for (const logo of PARTNER_LOGOS) {
      expect(screen.getByText(logo.name)).toBeInTheDocument();
    }
    expect(PARTNER_LOGOS.map((l) => l.name)).toEqual(
      expect.arrayContaining(['Xero', 'QuickBooks', 'FreshBooks', 'NetSuite', 'Sage', 'Wave']),
    );
  });
});

describe('book a call + demo video (gap #22)', () => {
  it('links to Calendly and lazy-loads the video only after a click', async () => {
    const user = userEvent.setup();
    render(<BookACallSection />);

    expect(screen.getByRole('link', { name: 'Book a call' })).toHaveAttribute('href', CALENDLY_URL);
    // No third-party iframe on first paint (keeps the bundle/privacy clean).
    expect(document.querySelector('iframe')).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Play the N409 product demo' }));
    const frame = document.querySelector('iframe');
    expect(frame).not.toBeNull();
    expect(frame?.getAttribute('src')).toContain('youtube-nocookie.com');
  });
});

describe('footer social links (gap #29)', () => {
  it('renders X and LinkedIn links with the configured hrefs', () => {
    render(
      <MemoryRouter>
        <MarketingFooter />
      </MemoryRouter>,
    );
    const social = screen.getByRole('navigation', { name: 'Social media' });
    for (const link of SOCIAL_LINKS) {
      const anchor = within(social).getByRole('link', { name: link.label });
      expect(anchor).toHaveAttribute('href', link.href);
      expect(anchor).toHaveAttribute('rel', expect.stringContaining('noopener'));
    }
  });
});
