import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type * as Marketing from '../src/lib/marketing';

/**
 * The carousel itself, with quotes.
 *
 * `TESTIMONIALS` ships empty — inventing endorsements attributed to named
 * people is a fabricated testimonial (FTC 16 CFR §255), and MarketingExtras
 * pins that the section renders nothing at all while we hold none. That leaves
 * every line of the carousel unreachable from the real data, so the code that
 * runs the day a permissioned quote arrives has never been executed. This file
 * supplies fixtures to exercise it.
 */
vi.mock('../src/lib/marketing', async (importOriginal) => {
  const actual = await importOriginal<typeof Marketing>();
  return {
    ...actual,
    TESTIMONIALS: [
      {
        quote: 'The report answered the questions our auditor had before they asked them.',
        name: 'Dana Reed',
        role: 'CFO',
        company: 'Zorblatt Dynamics',
        monogram: 'ZD',
      },
      {
        quote: 'Priced and delivered in a week, with the cap table pulled straight from Carta.',
        name: 'Sam Ito',
        role: 'Founder',
        company: 'Meridian Labs',
        monogram: 'ML',
      },
      {
        quote: 'The backsolve was explained well enough that our board did not need me to.',
        name: 'Priya Raman',
        role: 'General Counsel',
        company: 'Halcyon Bio',
        monogram: 'HB',
      },
    ],
  };
});

const { TestimonialsSection } = await import('../src/pages/marketing/MarketingSections');

const quoted = () => screen.getByRole('figure').textContent ?? '';
const dots = () => within(screen.getByRole('tablist')).getAllByRole('tab');

describe('TestimonialsSection carousel', () => {
  it('opens on the first quote, attributed in full', () => {
    render(<TestimonialsSection />);
    expect(quoted()).toContain('answered the questions our auditor had');
    expect(quoted()).toContain('Dana Reed');
    expect(quoted()).toContain('CFO · Zorblatt Dynamics');
    expect(screen.getByText('ZD')).toBeInTheDocument();
  });

  it('gives the carousel a role and a name a screen reader can announce', () => {
    render(<TestimonialsSection />);
    const figure = screen.getByRole('figure');
    expect(figure).toHaveAttribute('aria-roledescription', 'carousel');
    expect(figure).toHaveAttribute('aria-label', 'Customer testimonials');
  });

  it('advances and rewinds one quote at a time', async () => {
    const user = userEvent.setup();
    render(<TestimonialsSection />);

    await user.click(screen.getByRole('button', { name: 'Next testimonial' }));
    expect(quoted()).toContain('Sam Ito');
    await user.click(screen.getByRole('button', { name: 'Previous testimonial' }));
    expect(quoted()).toContain('Dana Reed');
  });

  /*
   * The wrap is the arithmetic worth pinning. `go` adds `count` before the
   * modulo precisely so stepping back from the first quote lands on the last
   * rather than on index -1, which would render nothing.
   */
  it('wraps backwards from the first quote to the last', async () => {
    const user = userEvent.setup();
    render(<TestimonialsSection />);

    await user.click(screen.getByRole('button', { name: 'Previous testimonial' }));
    expect(quoted()).toContain('Priya Raman');
  });

  it('wraps forwards from the last quote to the first', async () => {
    const user = userEvent.setup();
    render(<TestimonialsSection />);

    const next = screen.getByRole('button', { name: 'Next testimonial' });
    await user.click(next);
    await user.click(next);
    expect(quoted()).toContain('Priya Raman');
    await user.click(next);
    expect(quoted()).toContain('Dana Reed');
  });

  it('jumps straight to a quote from its dot, and marks which is showing', async () => {
    const user = userEvent.setup();
    render(<TestimonialsSection />);

    expect(dots()[0]).toHaveAttribute('aria-selected', 'true');
    await user.click(screen.getByRole('tab', { name: 'Testimonial 3: Halcyon Bio' }));

    expect(quoted()).toContain('Priya Raman');
    expect(dots()[2]).toHaveAttribute('aria-selected', 'true');
    expect(dots()[0]).toHaveAttribute('aria-selected', 'false');
  });

  it('gives one dot per quote, each naming the company it selects', () => {
    render(<TestimonialsSection />);
    const labels = dots().map((d) => d.getAttribute('aria-label'));
    expect(labels).toEqual([
      'Testimonial 1: Zorblatt Dynamics',
      'Testimonial 2: Meridian Labs',
      'Testimonial 3: Halcyon Bio',
    ]);
  });
});
