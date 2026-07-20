import { describe, expect, it } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { HelpIcon } from '../src/components/HelpIcon';
import { GettingStarted } from '../src/components/GettingStarted';
import { FeaturesPage } from '../src/pages/FeaturesPage';
import { InfoTooltip } from '../src/components/ui';

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
});

describe('FeaturesPage', () => {
  it('lists feature cards with learn-more links into the Help Center', () => {
    wrap(<FeaturesPage />);
    expect(screen.getByRole('heading', { name: 'Features', level: 1 })).toBeInTheDocument();
    const learnMore = screen.getAllByRole('link', { name: 'Learn more →' });
    expect(learnMore.length).toBeGreaterThanOrEqual(20);
    expect(learnMore.every((l) => l.getAttribute('href')?.startsWith('/help/'))).toBe(true);
  });
});
