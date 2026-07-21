import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { HelpPage } from '../src/pages/HelpPage';

afterEach(() => vi.restoreAllMocks());

function mockArticles(articles: unknown[] = []) {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(JSON.stringify({ articles }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  );
}

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/help" element={<HelpPage />} />
        <Route path="/help/:slug" element={<HelpPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('HelpPage (Help Center)', () => {
  it('renders the index with search and a category sidebar', async () => {
    mockArticles();
    renderAt('/help');
    expect(await screen.findByRole('heading', { name: 'Help Center', level: 1 })).toBeInTheDocument();
    expect(screen.getByLabelText('Search help articles')).toBeInTheDocument();
    // Category sidebar buttons.
    expect(screen.getByRole('button', { name: 'All topics' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Methodology' })).toBeInTheDocument();
  });

  it('filters the list by search query', async () => {
    mockArticles();
    const user = userEvent.setup();
    renderAt('/help');
    await screen.findByRole('heading', { name: 'Help Center', level: 1 });

    await user.type(screen.getByLabelText('Search help articles'), 'volatility');
    await waitFor(() => {
      expect(screen.getByText('Volatility')).toBeInTheDocument();
    });
    // An unrelated article drops out of the results.
    expect(screen.queryByText('Board approval')).toBeNull();
  });

  it('renders a single article with breadcrumbs and related links', async () => {
    mockArticles();
    renderAt('/help/methodology-opm');
    expect(
      await screen.findByRole('heading', { name: 'Option Pricing Method (OPM)', level: 1 }),
    ).toBeInTheDocument();
    // Breadcrumb back to the center.
    expect(screen.getByRole('navigation', { name: 'Breadcrumb' })).toBeInTheDocument();
    // Related article link (PWERM) is present.
    expect(screen.getByRole('link', { name: /PWERM: probability-weighted scenarios/ })).toBeInTheDocument();
  });

  it('renders a "Go to the feature" link for articles with a route', async () => {
    mockArticles();
    renderAt('/help/debt-valuation-overview');
    expect(
      await screen.findByRole('heading', { name: 'Debt valuation engine', level: 1 }),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Go to the feature/ })).toHaveAttribute('href', '/debt');
  });

  it('omits the feature link for articles without a route', async () => {
    mockArticles();
    renderAt('/help/methodology-opm');
    await screen.findByRole('heading', { name: 'Option Pricing Method (OPM)', level: 1 });
    expect(screen.queryByRole('link', { name: /Go to the feature/ })).toBeNull();
  });

  it('shows a not-found state for an unknown slug', async () => {
    mockArticles();
    renderAt('/help/does-not-exist');
    expect(await screen.findByText('Article not found')).toBeInTheDocument();
  });

  it('still renders the static knowledge base when the CMS fetch fails', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));
    renderAt('/help');
    expect(await screen.findByRole('heading', { name: 'Help Center', level: 1 })).toBeInTheDocument();
    // Static content is unaffected by the failed supplement.
    expect(screen.getByRole('button', { name: 'Assumptions' })).toBeInTheDocument();
  });
});
