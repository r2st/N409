import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { HelmetProvider } from 'react-helmet-async';
import { CostComparisonPage } from '../src/pages/marketing/CostComparisonPage';

function renderPage() {
  return render(
    <HelmetProvider>
      <MemoryRouter initialEntries={['/tools/cost-comparison']}>
        <Routes>
          <Route path="/tools/cost-comparison" element={<CostComparisonPage />} />
        </Routes>
      </MemoryRouter>
    </HelmetProvider>,
  );
}

describe('CostComparisonPage', () => {
  it('renders the heading and stage selector', () => {
    renderPage();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Cost Comparison');
    expect(screen.getByTestId('stage-preseed')).toBeTruthy();
    expect(screen.getByTestId('stage-seed')).toBeTruthy();
    expect(screen.getByTestId('stage-series_a')).toBeTruthy();
    expect(screen.getByTestId('stage-series_b')).toBeTruthy();
    expect(screen.getByTestId('stage-series_c')).toBeTruthy();
  });

  it('shows empty state before a stage is selected', () => {
    renderPage();
    expect(screen.getByTestId('comparison-result')).toHaveTextContent(/Select your company stage/);
  });

  it('shows comparison when a stage is selected', async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(screen.getByTestId('stage-seed'));

    const result = screen.getByTestId('comparison-result');
    expect(result).toHaveTextContent('Big 4');
    expect(result).toHaveTextContent('Boutique');
    expect(result).toHaveTextContent('DoAide 409A');
    expect(result).toHaveTextContent('Best value');
  });

  it('shows savings card with cost and time savings', async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(screen.getByTestId('stage-series_a'));

    const savings = screen.getByTestId('savings-card');
    expect(savings).toHaveTextContent('cost savings vs Big 4');
    expect(savings).toHaveTextContent('faster delivery');
  });

  it('shows disclaimer', async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(screen.getByTestId('stage-preseed'));
    expect(screen.getByText(/Disclaimer/)).toBeTruthy();
  });

  it('renders FAQ section', () => {
    renderPage();
    expect(screen.getByText('Frequently asked questions')).toBeTruthy();
    expect(screen.getByText(/Why is DoAide 409A so much cheaper/)).toBeTruthy();
  });

  it('updates comparison when switching stages', async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(screen.getByTestId('stage-preseed'));
    expect(screen.getByTestId('comparison-result')).toHaveTextContent('$5,000');

    await user.click(screen.getByTestId('stage-series_c'));
    expect(screen.getByTestId('comparison-result')).toHaveTextContent('$12,000');
  });
});
