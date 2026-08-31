import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import { Analytics } from '../src/components/Analytics';
import { CONSENT_STORAGE_KEY, ConsentProvider, type ConsentValue } from '../src/lib/consent';
import type { AnalyticsConfig } from '../src/lib/analytics';

const CONFIG: AnalyticsConfig = { gtmId: 'GTM-GATE', ga4Id: '', fbPixelId: '' };

/** The session the gate reads; set per test. */
let authStatus: 'loading' | 'anonymous' | 'authenticated' = 'anonymous';
vi.mock('../src/lib/auth', () => ({
  useAuth: () => ({ status: authStatus }),
}));

/** Analytics injects into the shared jsdom document — reset the state each test. */
beforeEach(() => {
  for (const id of ['n409-gtm', 'n409-ga4', 'n409-fbq']) document.getElementById(id)?.remove();
  const w = window as unknown as Record<string, unknown>;
  delete w.__n409AnalyticsLoaded;
  delete w.dataLayer;
  delete w.fbq;
  delete w._fbq;
});

function renderWithConsent(
  stored: ConsentValue | null,
  status: 'loading' | 'anonymous' | 'authenticated' = 'anonymous',
) {
  authStatus = status;
  if (stored) localStorage.setItem(CONSENT_STORAGE_KEY, stored);
  return render(
    <ConsentProvider>
      <Analytics config={CONFIG} />
    </ConsentProvider>,
  );
}

describe('<Analytics> consent gate (§23 + §25)', () => {
  it('injects tracking once consent is granted', async () => {
    renderWithConsent('granted');
    await waitFor(() => expect(document.getElementById('n409-gtm')).not.toBeNull());
  });

  it('injects nothing when consent is denied', async () => {
    renderWithConsent('denied');
    await Promise.resolve();
    expect(document.getElementById('n409-gtm')).toBeNull();
  });

  it('injects nothing before a choice is made', async () => {
    renderWithConsent(null);
    await Promise.resolve();
    expect(document.getElementById('n409-gtm')).toBeNull();
  });
});

/**
 * The gate consent cannot stand in for.
 *
 * A page view carries the URL, and this SPA serves the marketing site and the
 * signed-in product from one document — so a container running inside the
 * product reports engagement ids, a client's company name typed into a filter,
 * and the address an operator typed into the admin user search. Accepting
 * analytics cookies on a pricing page is not consent to that, and the banner
 * shows wherever the visitor first lands, `/login` included.
 */
describe('<Analytics> session gate', () => {
  it('injects nothing once there is a session, however the banner was answered', async () => {
    renderWithConsent('granted', 'authenticated');
    await Promise.resolve();
    expect(document.getElementById('n409-gtm')).toBeNull();
  });

  it('injects nothing while the session is still resolving', async () => {
    // What a hard reload of a product URL looks like for the first few hundred
    // milliseconds. Injecting on the optimistic reading is how this gate would
    // fail in exactly the place it exists for.
    renderWithConsent('granted', 'loading');
    await Promise.resolve();
    expect(document.getElementById('n409-gtm')).toBeNull();
  });

  it('injects for an anonymous visitor who accepted', async () => {
    renderWithConsent('granted', 'anonymous');
    await waitFor(() => expect(document.getElementById('n409-gtm')).not.toBeNull());
  });
});
