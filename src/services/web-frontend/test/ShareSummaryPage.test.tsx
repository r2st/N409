import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { HelmetProvider } from 'react-helmet-async';
import { ShareSummaryPage } from '../src/pages/ShareSummaryPage';

function renderPage(token = 'abc-123') {
  return render(
    <HelmetProvider>
      <MemoryRouter initialEntries={[`/share/${token}`]}>
        <Routes>
          <Route path="/share/:token" element={<ShareSummaryPage />} />
        </Routes>
      </MemoryRouter>
    </HelmetProvider>,
  );
}

describe('ShareSummaryPage', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('shows loading state initially', () => {
    vi.spyOn(globalThis, 'fetch').mockReturnValue(new Promise(() => {}));
    renderPage();
    expect(document.querySelector('[role="status"], .animate-spin')).toBeTruthy();
  });

  it('renders the summary card on success', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({
        company_name: 'Acme Corp',
        valuation_date: '2026-06-15',
        fmv_per_share: 1.25,
        state: 'published',
        kind: '409a',
        powered_by: 'DoAide 409A',
      }),
    } as Response);

    renderPage();

    await waitFor(() => {
      expect(screen.getByTestId('share-summary-card')).toBeTruthy();
    });

    expect(screen.getByText('Acme Corp')).toBeTruthy();
    expect(screen.getByText('$1.25')).toBeTruthy();
    expect(screen.getByText(/Powered by DoAide 409A/)).toBeTruthy();
  });

  it('shows error for expired token', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      status: 410,
    } as Response);

    renderPage();

    await waitFor(() => {
      expect(screen.getByText('This share link has expired.')).toBeTruthy();
    });
  });

  it('shows error for not-found token', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      status: 404,
    } as Response);

    renderPage();

    await waitFor(() => {
      expect(screen.getByText('Share link not found.')).toBeTruthy();
    });
  });

  it('includes WhatsApp share button in summary', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({
        company_name: 'TestCo',
        valuation_date: null,
        fmv_per_share: null,
        state: 'published',
        kind: '409a',
        powered_by: 'DoAide 409A',
      }),
    } as Response);

    renderPage();

    await waitFor(() => {
      expect(screen.getByTestId('share-summary-card')).toBeTruthy();
    });

    expect(screen.getByText('WhatsApp')).toBeTruthy();
  });

  it('shows CTA to start a valuation', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({
        company_name: 'TestCo',
        valuation_date: null,
        fmv_per_share: null,
        state: 'published',
        kind: '409a',
        powered_by: 'DoAide 409A',
      }),
    } as Response);

    renderPage();

    await waitFor(() => {
      expect(screen.getByRole('link', { name: 'Start your valuation' })).toBeTruthy();
    });
  });

  it('works without login — no auth required to view shared summary', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({
        company_name: 'SharedCo',
        valuation_date: '2026-06-15',
        fmv_per_share: 2.00,
        state: 'delivered',
        kind: '409a',
        powered_by: 'DoAide 409A',
      }),
    } as Response);

    renderPage('share-token-xyz');

    await waitFor(() => {
      expect(screen.getByTestId('share-summary-card')).toBeTruthy();
    });

    expect(screen.getByText('SharedCo')).toBeTruthy();
    expect(screen.queryByText(/sign in/i)).toBeNull();
    expect(screen.queryByText(/log in/i)).toBeNull();
  });
});
