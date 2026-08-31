import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { SignedInHandoff, handOffAfterSignIn } from '../src/components/SignedInHandoff';

/**
 * The crossing from the public surface into the product.
 *
 * `<Analytics>` will not inject once there is a session, which covers every
 * document that starts inside the product. The case it cannot cover is signing
 * in *within* a document that already loaded containers: a script cannot be
 * unloaded, and GA4's page views on history changes are configured in the
 * property rather than on the page. So the product gets a fresh document — and
 * only then, because a full page load on every sign-in would be a cost paid by
 * every deployment, including the ones with no container ids at all.
 */
const flags = () => window as unknown as Record<string, unknown>;

beforeEach(() => {
  delete flags().__n409AnalyticsLoaded;
  vi.restoreAllMocks();
});

function renderHandoff() {
  return render(
    <MemoryRouter initialEntries={['/login']}>
      <Routes>
        <Route path="/login" element={<SignedInHandoff to="/dashboard" />} />
        <Route path="/dashboard" element={<p>Dashboard</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('<SignedInHandoff>', () => {
  it('navigates within the SPA when this document carries no container', async () => {
    const replace = vi.fn();
    vi.spyOn(window, 'location', 'get').mockReturnValue({ replace } as unknown as Location);
    renderHandoff();
    expect(await screen.findByText('Dashboard')).toBeInTheDocument();
    expect(replace).not.toHaveBeenCalled();
  });

  it('hands the product a fresh document when one is loaded', () => {
    flags().__n409AnalyticsLoaded = { gtm: true };
    const replace = vi.fn();
    vi.spyOn(window, 'location', 'get').mockReturnValue({ replace } as unknown as Location);
    renderHandoff();
    // And it does not render the product into the document it is leaving.
    expect(screen.queryByText('Dashboard')).toBeNull();
    expect(replace).toHaveBeenCalledWith('/dashboard');
  });
});

describe('handOffAfterSignIn', () => {
  it('makes the same decision for a caller holding `navigate`', () => {
    const navigate = vi.fn();
    const replace = vi.fn();
    vi.spyOn(window, 'location', 'get').mockReturnValue({ replace } as unknown as Location);

    handOffAfterSignIn('/', navigate as never);
    expect(navigate).toHaveBeenCalledWith('/', { replace: true });
    expect(replace).not.toHaveBeenCalled();

    flags().__n409AnalyticsLoaded = { fbq: true };
    handOffAfterSignIn('/', navigate as never);
    expect(replace).toHaveBeenCalledWith('/');
    expect(navigate).toHaveBeenCalledTimes(1);
  });
});
