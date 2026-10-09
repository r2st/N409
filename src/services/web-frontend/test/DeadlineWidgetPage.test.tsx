import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { HelmetProvider } from 'react-helmet-async';
import { DeadlineWidgetPage, DeadlineWidgetEmbed } from '../src/pages/marketing/DeadlineWidgetPage';

function renderPage() {
  return render(
    <HelmetProvider>
      <MemoryRouter initialEntries={['/tools/deadline-widget']}>
        <Routes>
          <Route path="/tools/deadline-widget" element={<DeadlineWidgetPage />} />
        </Routes>
      </MemoryRouter>
    </HelmetProvider>,
  );
}

function renderEmbed() {
  return render(
    <MemoryRouter initialEntries={['/tools/deadline-widget/embed']}>
      <Routes>
        <Route path="/tools/deadline-widget/embed" element={<DeadlineWidgetEmbed />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('DeadlineWidgetPage', () => {
  it('renders the heading and deadline list', () => {
    renderPage();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Deadline Tracker');
    expect(screen.getByTestId('deadline-list')).toBeTruthy();
  });

  it('shows all six deadlines', () => {
    renderPage();
    expect(screen.getByTestId('deadline-12-month-expiry')).toBeTruthy();
    expect(screen.getByTestId('deadline-post-funding')).toBeTruthy();
    expect(screen.getByTestId('deadline-annual-audit')).toBeTruthy();
    expect(screen.getByTestId('deadline-board-approval')).toBeTruthy();
    expect(screen.getByTestId('deadline-ipo-readiness')).toBeTruthy();
    expect(screen.getByTestId('deadline-year-end-refresh')).toBeTruthy();
  });

  it('shows urgent badges on urgent deadlines', () => {
    renderPage();
    const urgent = screen.getAllByText('Urgent');
    expect(urgent.length).toBeGreaterThanOrEqual(2);
  });

  it('displays embed code', () => {
    renderPage();
    const embedCode = screen.getByTestId('embed-code');
    expect(embedCode.textContent).toContain('iframe');
    expect(embedCode.textContent).toContain('deadline-widget/embed');
  });

  it('renders FAQ section', () => {
    renderPage();
    expect(screen.getByText('Frequently asked questions')).toBeTruthy();
    expect(screen.getByText('How do I embed this widget on my site?')).toBeTruthy();
  });

  it('has a CTA to start valuation', () => {
    renderPage();
    expect(screen.getByRole('link', { name: 'Start your 409A valuation' })).toBeTruthy();
  });
});

describe('DeadlineWidgetEmbed', () => {
  it('renders the embed version with DoAide branding', () => {
    renderEmbed();
    expect(screen.getByTestId('deadline-embed')).toBeTruthy();
    expect(screen.getByText('DoAide 409A')).toBeTruthy();
  });

  it('shows urgent deadlines in the embed', () => {
    renderEmbed();
    expect(screen.getByText('12-month valuation expiry')).toBeTruthy();
    expect(screen.getByText('Post-funding round valuation')).toBeTruthy();
  });

  it('links back to readiness checker', () => {
    renderEmbed();
    expect(screen.getByText(/Check your 409A readiness/)).toBeTruthy();
  });
});
