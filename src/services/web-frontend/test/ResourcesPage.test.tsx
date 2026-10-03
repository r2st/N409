import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { HelmetProvider } from 'react-helmet-async';
import { ResourcesPage } from '../src/pages/marketing/ResourcesPage';

function renderPage() {
  return render(
    <HelmetProvider>
      <MemoryRouter initialEntries={['/resources']}>
        <Routes>
          <Route path="/resources" element={<ResourcesPage />} />
        </Routes>
      </MemoryRouter>
    </HelmetProvider>,
  );
}

describe('ResourcesPage', () => {
  it('renders the heading', () => {
    renderPage();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('409A Resources & Tools');
  });

  it('lists all three free tools', () => {
    renderPage();
    expect(screen.getByText('409A Valuation Calculator')).toBeTruthy();
    expect(screen.getByText('Stock Option Tax Calculator')).toBeTruthy();
    expect(screen.getByText('409A Compliance Checker')).toBeTruthy();
  });

  it('links to tool pages', () => {
    renderPage();
    const links = screen.getAllByRole('link');
    const toolLinks = links.filter(
      (l) =>
        l.getAttribute('href')?.startsWith('/tools/'),
    );
    expect(toolLinks.length).toBe(3);
  });

  it('lists educational guides', () => {
    renderPage();
    expect(screen.getByText('The 409A Valuation Guide')).toBeTruthy();
    expect(screen.getByText('When Do You Need a 409A?')).toBeTruthy();
    expect(screen.getByText('How Much Does a 409A Cost?')).toBeTruthy();
  });
});
