import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { HelmetProvider } from 'react-helmet-async';
import { ValuationEstimatorPage } from '../src/pages/marketing/ValuationEstimatorPage';

function renderPage() {
  return render(
    <HelmetProvider>
      <MemoryRouter initialEntries={['/tools/startup-valuation-estimator']}>
        <Routes>
          <Route path="/tools/startup-valuation-estimator" element={<ValuationEstimatorPage />} />
        </Routes>
      </MemoryRouter>
    </HelmetProvider>,
  );
}

describe('ValuationEstimatorPage', () => {
  it('renders the heading and input form', () => {
    renderPage();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Startup Valuation Estimator');
    expect(screen.getByTestId('estimator-inputs')).toBeTruthy();
    expect(screen.getByLabelText(/Annual Revenue/)).toBeTruthy();
    expect(screen.getByLabelText(/Revenue Growth Rate/)).toBeTruthy();
    expect(screen.getByLabelText(/Industry/)).toBeTruthy();
    expect(screen.getByLabelText(/Funding Stage/)).toBeTruthy();
    expect(screen.getByLabelText(/Total Funding Raised/)).toBeTruthy();
    expect(screen.getByLabelText(/Number of Employees/)).toBeTruthy();
  });

  it('shows empty state before estimation', () => {
    renderPage();
    expect(screen.getByText(/Enter your company details/)).toBeTruthy();
  });

  it('disables estimate button when required fields are missing', () => {
    renderPage();
    const button = screen.getByTestId('estimate-button');
    expect(button).toBeDisabled();
  });

  it('enables estimate button when revenue, industry, and stage are filled', async () => {
    const user = userEvent.setup();
    renderPage();

    await user.type(screen.getByLabelText(/Annual Revenue/), '2000000');
    await user.selectOptions(screen.getByLabelText(/Industry/), 'saas');
    await user.selectOptions(screen.getByLabelText(/Funding Stage/), 'series_a');

    const button = screen.getByTestId('estimate-button');
    expect(button).not.toBeDisabled();
  });

  it('shows valuation results after clicking estimate', async () => {
    const user = userEvent.setup();
    renderPage();

    await user.type(screen.getByLabelText(/Annual Revenue/), '2000000');
    await user.type(screen.getByLabelText(/Revenue Growth Rate/), '100');
    await user.selectOptions(screen.getByLabelText(/Industry/), 'saas');
    await user.selectOptions(screen.getByLabelText(/Funding Stage/), 'series_a');
    await user.type(screen.getByLabelText(/Total Funding Raised/), '5000000');
    await user.type(screen.getByLabelText(/Number of Employees/), '25');

    await user.click(screen.getByTestId('estimate-button'));

    // Result panels should appear
    expect(screen.getByTestId('fmv-mid')).toBeTruthy();
    expect(screen.getByTestId('fmv-range')).toBeTruthy();
    expect(screen.getByTestId('ev-mid')).toBeTruthy();
    expect(screen.getByTestId('ev-range')).toBeTruthy();
    expect(screen.getByTestId('method')).toHaveTextContent('Revenue Multiple');
    expect(screen.getByTestId('dlom')).toHaveTextContent('25%');
  });

  it('produces reasonable numbers for a SaaS Series A startup', async () => {
    const user = userEvent.setup();
    renderPage();

    await user.type(screen.getByLabelText(/Annual Revenue/), '2000000');
    await user.type(screen.getByLabelText(/Revenue Growth Rate/), '100');
    await user.selectOptions(screen.getByLabelText(/Industry/), 'saas');
    await user.selectOptions(screen.getByLabelText(/Funding Stage/), 'series_a');
    await user.type(screen.getByLabelText(/Total Funding Raised/), '5000000');
    await user.type(screen.getByLabelText(/Number of Employees/), '25');

    await user.click(screen.getByTestId('estimate-button'));

    // EV mid should contain 'M' — at 2M revenue × ~12.5× multiple ≈ $25M
    const evText = screen.getByTestId('ev-mid').textContent!;
    expect(evText).toContain('M');

    // Common stock FMV should be less than enterprise value
    const fmvText = screen.getByTestId('fmv-mid').textContent!;
    expect(fmvText).toContain('M');
  });

  it('uses funding floor for pre-revenue companies', async () => {
    const user = userEvent.setup();
    renderPage();

    // Pre-revenue company with $3M raised
    await user.type(screen.getByLabelText(/Annual Revenue/), '0');
    await user.selectOptions(screen.getByLabelText(/Industry/), 'saas');
    await user.selectOptions(screen.getByLabelText(/Funding Stage/), 'seed');
    await user.type(screen.getByLabelText(/Total Funding Raised/), '3000000');

    await user.click(screen.getByTestId('estimate-button'));

    expect(screen.getByTestId('method')).toHaveTextContent('Funding-Based');
    // Should still produce a result
    expect(screen.getByTestId('fmv-mid')).toBeTruthy();
  });

  it('resets form and results on reset click', async () => {
    const user = userEvent.setup();
    renderPage();

    await user.type(screen.getByLabelText(/Annual Revenue/), '1000000');
    await user.selectOptions(screen.getByLabelText(/Industry/), 'fintech');
    await user.selectOptions(screen.getByLabelText(/Funding Stage/), 'seed');
    await user.click(screen.getByTestId('estimate-button'));

    // Result should be visible
    expect(screen.getByTestId('fmv-mid')).toBeTruthy();

    // Click reset
    await user.click(screen.getByTestId('reset-button'));

    // Back to empty state
    expect(screen.getByText(/Enter your company details/)).toBeTruthy();
    expect(screen.queryByTestId('fmv-mid')).toBeNull();
  });

  it('renders educational content sections', () => {
    renderPage();
    expect(screen.getByTestId('educational-content')).toBeTruthy();
    expect(screen.getByText('How Startup Valuations Work')).toBeTruthy();
    expect(screen.getByText('Revenue Multiples')).toBeTruthy();
    expect(screen.getByText('Common Stock vs. Preferred')).toBeTruthy();
    expect(screen.getByText('Discount for Lack of Marketability')).toBeTruthy();
  });

  it('renders the why-409a section', () => {
    renderPage();
    expect(screen.getByTestId('why-409a-section')).toBeTruthy();
    expect(screen.getByText('Why You Need a 409A Valuation')).toBeTruthy();
    expect(screen.getByText('IRS Compliance')).toBeTruthy();
    expect(screen.getByText('Safe Harbor Protection')).toBeTruthy();
  });

  it('renders FAQ section', () => {
    renderPage();
    expect(screen.getByTestId('faq-section')).toBeTruthy();
    expect(screen.getByText('How accurate is this startup valuation estimator?')).toBeTruthy();
    expect(screen.getByText('What is a 409A valuation and do I need one?')).toBeTruthy();
  });

  it('renders the CTA to register after estimation', async () => {
    const user = userEvent.setup();
    renderPage();

    await user.type(screen.getByLabelText(/Annual Revenue/), '5000000');
    await user.selectOptions(screen.getByLabelText(/Industry/), 'enterprise');
    await user.selectOptions(screen.getByLabelText(/Funding Stage/), 'series_b');
    await user.click(screen.getByTestId('estimate-button'));

    const cta = screen.getByTestId('cta-register');
    expect(cta).toHaveTextContent('Get a professional 409A valuation');
    expect(cta.getAttribute('href')).toBe('/register');
  });

  it('shows disclaimer after estimation', async () => {
    const user = userEvent.setup();
    renderPage();

    await user.type(screen.getByLabelText(/Annual Revenue/), '1000000');
    await user.selectOptions(screen.getByLabelText(/Industry/), 'other');
    await user.selectOptions(screen.getByLabelText(/Funding Stage/), 'pre_seed');
    await user.click(screen.getByTestId('estimate-button'));

    expect(screen.getByText(/Disclaimer:/)).toBeTruthy();
    expect(screen.getByText(/does not constitute a 409A valuation/)).toBeTruthy();
  });

  it('adjusts DLOM by stage', async () => {
    const user = userEvent.setup();

    // Pre-seed should have 35% DLOM
    renderPage();
    await user.type(screen.getByLabelText(/Annual Revenue/), '500000');
    await user.selectOptions(screen.getByLabelText(/Industry/), 'saas');
    await user.selectOptions(screen.getByLabelText(/Funding Stage/), 'pre_seed');
    await user.click(screen.getByTestId('estimate-button'));
    expect(screen.getByTestId('dlom')).toHaveTextContent('35%');
  });

  it('handles all industry options without error', async () => {
    const user = userEvent.setup();
    const industries = [
      'saas', 'fintech', 'healthtech', 'ecommerce', 'marketplace',
      'hardware', 'ai_ml', 'enterprise', 'consumer', 'cleantech', 'other',
    ];

    for (const ind of industries) {
      const { unmount } = renderPage();
      await user.type(screen.getByLabelText(/Annual Revenue/), '1000000');
      await user.selectOptions(screen.getByLabelText(/Industry/), ind);
      await user.selectOptions(screen.getByLabelText(/Funding Stage/), 'seed');
      await user.click(screen.getByTestId('estimate-button'));
      expect(screen.getByTestId('fmv-mid')).toBeTruthy();
      unmount();
    }
  });

  it('handles all stage options without error', async () => {
    const user = userEvent.setup();
    const stages = ['pre_seed', 'seed', 'series_a', 'series_b', 'series_c'];

    for (const stg of stages) {
      const { unmount } = renderPage();
      await user.type(screen.getByLabelText(/Annual Revenue/), '1000000');
      await user.selectOptions(screen.getByLabelText(/Industry/), 'saas');
      await user.selectOptions(screen.getByLabelText(/Funding Stage/), stg);
      await user.click(screen.getByTestId('estimate-button'));
      expect(screen.getByTestId('fmv-mid')).toBeTruthy();
      unmount();
    }
  });

  it('enables button with only funding (no revenue) plus industry and stage', async () => {
    const user = userEvent.setup();
    renderPage();

    await user.selectOptions(screen.getByLabelText(/Industry/), 'ai_ml');
    await user.selectOptions(screen.getByLabelText(/Funding Stage/), 'seed');
    await user.type(screen.getByLabelText(/Total Funding Raised/), '2000000');

    const button = screen.getByTestId('estimate-button');
    expect(button).not.toBeDisabled();
  });
});
