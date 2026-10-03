import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { HelmetProvider } from 'react-helmet-async';
import { TaxCalculatorPage } from '../src/pages/marketing/TaxCalculatorPage';

function renderPage() {
  return render(
    <HelmetProvider>
      <MemoryRouter initialEntries={['/tools/stock-option-tax-calculator']}>
        <Routes>
          <Route path="/tools/stock-option-tax-calculator" element={<TaxCalculatorPage />} />
        </Routes>
      </MemoryRouter>
    </HelmetProvider>,
  );
}

describe('TaxCalculatorPage', () => {
  it('renders the heading and empty state', () => {
    renderPage();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Stock Option Tax Calculator');
    expect(screen.getByText(/Enter your option details/)).toBeTruthy();
  });

  it('shows ISO result when all fields are filled', async () => {
    const user = userEvent.setup();
    renderPage();

    await user.type(screen.getByPlaceholderText('10,000'), '1000');
    await user.type(screen.getByPlaceholderText('$0.50'), '1');
    await user.type(screen.getByPlaceholderText('$5.00'), '10');

    const result = screen.getByTestId('tax-result');
    expect(result).toHaveTextContent('$9,000');
    expect(result).toHaveTextContent('AMT preference item');
  });

  it('switches to NSO and shows ordinary income', async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(screen.getByText('NSO (Non-Qualified Stock Option)'));
    await user.type(screen.getByPlaceholderText('10,000'), '1000');
    await user.type(screen.getByPlaceholderText('$0.50'), '1');
    await user.type(screen.getByPlaceholderText('$5.00'), '10');

    const result = screen.getByTestId('tax-result');
    expect(result).toHaveTextContent('Ordinary income at exercise');
    expect(result).toHaveTextContent('$9,000');
  });

  it('shows zero spread when FMV equals strike', async () => {
    const user = userEvent.setup();
    renderPage();

    await user.type(screen.getByPlaceholderText('10,000'), '100');
    await user.type(screen.getByPlaceholderText('$0.50'), '5');
    await user.type(screen.getByPlaceholderText('$5.00'), '5');

    const result = screen.getByTestId('tax-result');
    expect(result).toHaveTextContent('$0');
  });

  it('renders the share bar when result is shown', async () => {
    const user = userEvent.setup();
    renderPage();

    await user.type(screen.getByPlaceholderText('10,000'), '1000');
    await user.type(screen.getByPlaceholderText('$0.50'), '1');
    await user.type(screen.getByPlaceholderText('$5.00'), '10');

    expect(screen.getByText('Share on LinkedIn')).toBeTruthy();
  });
});
