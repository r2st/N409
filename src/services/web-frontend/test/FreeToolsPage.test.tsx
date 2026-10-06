import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { FreeToolsPage } from '../src/pages/marketing/FreeToolsPage';

describe('FreeToolsPage', () => {
  it('renders the heading and all four tool cards', () => {
    render(
      <MemoryRouter initialEntries={['/free-tools']}>
        <FreeToolsPage />
      </MemoryRouter>,
    );
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(/free 409a tools/i);
    expect(screen.getByText(/409A Valuation Calculator/)).toBeInTheDocument();
    expect(screen.getByText(/Safe Harbor Compliance Checker/)).toBeInTheDocument();
    expect(screen.getByText(/Startup Valuation Estimator/)).toBeInTheDocument();
    expect(screen.getByText(/Stock Option Tax Calculator/)).toBeInTheDocument();
  });

  it('links each tool to its page', () => {
    render(
      <MemoryRouter initialEntries={['/free-tools']}>
        <FreeToolsPage />
      </MemoryRouter>,
    );
    const links = screen.getAllByRole('link');
    const toolPaths = links.map((l) => l.getAttribute('href')).filter((h) => h?.startsWith('/tools/'));
    expect(toolPaths).toContain('/tools/409a-valuation-calculator');
    expect(toolPaths).toContain('/tools/409a-compliance-checker');
    expect(toolPaths).toContain('/tools/startup-valuation-estimator');
    expect(toolPaths).toContain('/tools/stock-option-tax-calculator');
  });
});
