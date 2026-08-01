import { beforeEach, describe, expect, it } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import { Analytics } from '../src/components/Analytics';
import { CONSENT_STORAGE_KEY, ConsentProvider, type ConsentValue } from '../src/lib/consent';
import type { AnalyticsConfig } from '../src/lib/analytics';

const CONFIG: AnalyticsConfig = { gtmId: 'GTM-GATE', ga4Id: '', fbPixelId: '' };

/** Analytics injects into the shared jsdom document — reset the state each test. */
beforeEach(() => {
  for (const id of ['n409-gtm', 'n409-ga4', 'n409-fbq']) document.getElementById(id)?.remove();
  const w = window as unknown as Record<string, unknown>;
  delete w.__n409AnalyticsLoaded;
  delete w.dataLayer;
  delete w.fbq;
  delete w._fbq;
});

function renderWithConsent(stored: ConsentValue | null) {
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
