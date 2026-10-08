import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { HelmetProvider } from 'react-helmet-async';
import { ReadinessCheckerPage } from '../src/pages/marketing/ReadinessCheckerPage';

function renderPage() {
  return render(
    <HelmetProvider>
      <MemoryRouter initialEntries={['/tools/readiness-checker']}>
        <Routes>
          <Route path="/tools/readiness-checker" element={<ReadinessCheckerPage />} />
        </Routes>
      </MemoryRouter>
    </HelmetProvider>,
  );
}

describe('ReadinessCheckerPage', () => {
  it('renders the heading and all ten questions', () => {
    renderPage();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Readiness Checker');
    expect(screen.getByTestId('question-incorporation')).toBeTruthy();
    expect(screen.getByTestId('question-last_409a')).toBeTruthy();
    expect(screen.getByTestId('question-funding')).toBeTruthy();
    expect(screen.getByTestId('question-trigger')).toBeTruthy();
    expect(screen.getByTestId('question-revenue')).toBeTruthy();
    expect(screen.getByTestId('question-employees')).toBeTruthy();
    expect(screen.getByTestId('question-option_pool')).toBeTruthy();
    expect(screen.getByTestId('question-cap_table')).toBeTruthy();
    expect(screen.getByTestId('question-financials')).toBeTruthy();
    expect(screen.getByTestId('question-grants_planned')).toBeTruthy();
  });

  it('shows empty state before all questions are answered', () => {
    renderPage();
    expect(screen.getByText(/Answer all 10 questions/)).toBeTruthy();
  });

  it('shows a readiness score when all questions are answered favorably', async () => {
    const user = userEvent.setup();
    renderPage();

    const bestOptions = [
      '1–3 years ago',
      'Less than 6 months ago',
      'Series A or B',
      'No triggering events',
      '$1M–$10M',
      '11–50',
      'Yes — 10–20%',
      'Current in cap table software',
      'Current (last quarter)',
      'Not immediately',
    ];

    for (const label of bestOptions) {
      await user.click(screen.getByRole('button', { name: label }));
    }

    const result = screen.getByTestId('readiness-result');
    expect(result).toHaveTextContent('Ready');
    expect(screen.getByTestId('readiness-score')).toBeTruthy();
  });

  it('shows missing items when answers indicate gaps', async () => {
    const user = userEvent.setup();
    renderPage();

    const mixedOptions = [
      '1–3 years ago',
      'Never had one',
      'Seed / Angel',
      'Yes — M&A or IPO plans',
      'Pre-revenue',
      '1–10',
      'No option pool yet',
      'No cap table',
      'No formal financial statements',
      'Yes — within 30 days',
    ];

    for (const label of mixedOptions) {
      await user.click(screen.getByRole('button', { name: label }));
    }

    const result = screen.getByTestId('readiness-result');
    expect(result).toHaveTextContent('Needs preparation');
    expect(result).toHaveTextContent('Missing items');
  });

  it('renders FAQ section', () => {
    renderPage();
    expect(screen.getByText('Frequently asked questions')).toBeTruthy();
    expect(screen.getByText('What documents do I need for a 409A valuation?')).toBeTruthy();
  });

  it('shows progress bar', () => {
    renderPage();
    expect(screen.getByRole('progressbar')).toBeTruthy();
    expect(screen.getByText('0 of 10 answered')).toBeTruthy();
  });
});
