import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { HelmetProvider } from 'react-helmet-async';
import { NotFoundPage } from '../src/pages/NotFoundPage';

function renderAt(path: string) {
  return render(
    <HelmetProvider>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/known" element={<p>Known page</p>} />
          <Route path="*" element={<NotFoundPage />} />
        </Routes>
      </MemoryRouter>
    </HelmetProvider>,
  );
}

describe('NotFoundPage (F-1 P2)', () => {
  it('renders a real 404 for an unknown route instead of redirecting', () => {
    renderAt('/does/not/exist');
    expect(screen.getByRole('heading', { name: 'Page not found' })).toBeInTheDocument();
    expect(screen.getByText('/does/not/exist')).toBeInTheDocument();
  });

  it('offers a link back home and to pricing', () => {
    renderAt('/nope');
    expect(screen.getByRole('link', { name: 'Back to home' })).toHaveAttribute('href', '/');
    expect(screen.getByRole('link', { name: 'See pricing' })).toHaveAttribute('href', '/pricing');
  });

  it('includes the marketing header for navigation', () => {
    renderAt('/nope');
    expect(screen.getByRole('banner')).toBeInTheDocument();
  });

  it('sets noindex SEO meta', () => {
    renderAt('/nope');
    expect(document.title).toContain('Page not found');
  });

  it('does not shadow a known route', () => {
    renderAt('/known');
    expect(screen.getByText('Known page')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Page not found' })).toBeNull();
  });
});
