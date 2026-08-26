import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { HelpIcon } from '../src/components/HelpIcon';
import { GettingStarted } from '../src/components/GettingStarted';
import { FeaturesPage } from '../src/pages/FeaturesPage';
import { InfoTooltip } from '../src/components/ui';
import * as helpContent from '../src/data/helpContent';

afterEach(() => {
  vi.restoreAllMocks();
});

function wrap(ui: React.ReactElement) {
  return render(<MemoryRouter>{ui}</MemoryRouter>);
}

describe('HelpIcon', () => {
  it('opens the article in a slide-over dialog and closes on Escape', async () => {
    const user = userEvent.setup();
    wrap(<HelpIcon article="methodology-opm" />);

    await user.click(screen.getByRole('button', { name: /Help: Option Pricing Method/ }));
    const dialog = await screen.findByRole('dialog', { name: /Option Pricing Method/ });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(screen.getByRole('link', { name: /Open in Help Center/ })).toHaveAttribute(
      'href',
      '/help/methodology-opm',
    );

    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('labels itself from metadata and fetches the prose only when opened', async () => {
    // The corpus is a separate chunk (see `data/helpBodies.ts`). The button's
    // accessible name and the panel header come from metadata, so neither
    // waits on the fetch — but the body does, and it has to arrive.
    const user = userEvent.setup();
    const load = vi.spyOn(helpContent, 'loadHelpBodies');
    wrap(<HelpIcon article="methodology-opm" />);

    const trigger = screen.getByRole('button', { name: /Help: Option Pricing Method/ });
    expect(load).not.toHaveBeenCalled();

    await user.click(trigger);
    expect(load).toHaveBeenCalled();
    // A body sentence, not a title — proof the prose itself arrived.
    expect(await screen.findByText(/treats each class of equity as a call option/i)).toBeInTheDocument();
  });

  it('says the article failed rather than that it does not exist', async () => {
    // A chunk that did not arrive is a network fact, not a fact about the
    // knowledge base: "coming soon" here would report the former as the latter.
    const user = userEvent.setup();
    vi.spyOn(helpContent, 'loadHelpBodies').mockRejectedValue(new Error('chunk load failed'));
    wrap(<HelpIcon article="methodology-opm" />);

    await user.click(screen.getByRole('button', { name: /Help: Option Pricing Method/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/could not be loaded/i);
    expect(screen.queryByText(/coming soon/i)).toBeNull();
    // The header still names the article — metadata never depended on the fetch.
    expect(screen.getByRole('dialog', { name: /Option Pricing Method/ })).toBeInTheDocument();
  });

  it('still says "coming soon" for an id with no article', async () => {
    const user = userEvent.setup();
    const load = vi.spyOn(helpContent, 'loadHelpBodies');
    wrap(<HelpIcon article="no-such-article" />);

    await user.click(screen.getByRole('button', { name: /Help: Help/ }));
    expect(await screen.findByText(/coming soon/i)).toBeInTheDocument();
    // Nothing to fetch: an unknown id must not pull the corpus down.
    expect(load).not.toHaveBeenCalled();
  });
});

describe('InfoTooltip', () => {
  it('reveals its text on focus', async () => {
    const user = userEvent.setup();
    wrap(<InfoTooltip text="Explains the field" label="About it" />);
    expect(screen.queryByRole('tooltip')).toBeNull();
    await user.tab();
    expect(screen.getByRole('tooltip')).toHaveTextContent('Explains the field');
  });
});

describe('GettingStarted', () => {
  it('tracks progress and can be dismissed', async () => {
    const user = userEvent.setup();
    wrap(<GettingStarted />);

    // All eight steps render, starting at 0/8.
    expect(screen.getByText('0/8')).toBeInTheDocument();
    const checks = screen.getAllByRole('checkbox');
    expect(checks).toHaveLength(8);

    await user.click(checks[0]!);
    expect(screen.getByText('1/8')).toBeInTheDocument();
    expect(localStorage.getItem('n409.getting-started.done')).toContain('company');

    await user.click(screen.getByRole('button', { name: /Hide/ }));
    expect(screen.queryByText(/step by step/)).toBeNull();
    expect(localStorage.getItem('n409.getting-started.dismissed')).toBe('1');
  });

  it('stays hidden once dismissed', () => {
    localStorage.setItem('n409.getting-started.dismissed', '1');
    const { container } = wrap(<GettingStarted />);
    expect(container).toBeEmptyDOMElement();
  });

  it('surfaces the specialized engines as explore links (not extra steps)', () => {
    wrap(<GettingStarted />);
    // Still exactly eight checklist steps.
    expect(screen.getAllByRole('checkbox')).toHaveLength(8);
    expect(screen.getByText('Beyond your first valuation')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /ASC 718 \(public company\)/ })).toHaveAttribute(
      'href',
      '/help/asc718-public-overview',
    );
    expect(screen.getByRole('link', { name: /Fund holdings/ })).toHaveAttribute(
      'href',
      '/help/fund-holdings-overview',
    );
    expect(screen.getByRole('link', { name: /Debt valuation/ })).toHaveAttribute(
      'href',
      '/help/debt-valuation-overview',
    );
  });
});

describe('FeaturesPage', () => {
  it('lists feature cards with learn-more links into the Help Center', () => {
    wrap(<FeaturesPage />);
    expect(screen.getByRole('heading', { name: 'Features', level: 1 })).toBeInTheDocument();
    const learnMore = screen.getAllByRole('link', { name: 'Learn more →' });
    expect(learnMore.length).toBeGreaterThanOrEqual(20);
    expect(learnMore.every((l) => l.getAttribute('href')?.startsWith('/help/'))).toBe(true);
  });

  it('showcases the specialized valuation engines section', () => {
    wrap(<FeaturesPage />);
    expect(
      screen.getByRole('heading', { name: 'Specialized valuation engines', level: 2 }),
    ).toBeInTheDocument();
    // The three engine categories each render a learn-more link into the Help Center.
    const hrefs = screen.getAllByRole('link', { name: 'Learn more →' }).map((l) => l.getAttribute('href'));
    expect(hrefs).toContain('/help/asc718-public-overview');
    expect(hrefs).toContain('/help/fund-holdings-overview');
    expect(hrefs).toContain('/help/debt-valuation-overview');
  });
});
