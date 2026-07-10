import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import {
  CONSENT_STORAGE_KEY,
  ConsentProvider,
  readStoredConsent,
  useConsent,
} from '../src/lib/consent';
import { CookieConsent } from '../src/components/CookieConsent';

function ConsentProbe() {
  const { consent, needsChoice } = useConsent();
  return <div data-testid="probe">{`${consent ?? 'null'}:${needsChoice}`}</div>;
}

function renderBanner() {
  return render(
    <MemoryRouter>
      <ConsentProvider>
        <CookieConsent />
        <ConsentProbe />
      </ConsentProvider>
    </MemoryRouter>,
  );
}

describe('consent storage (§25)', () => {
  it('reads only valid stored values', () => {
    expect(readStoredConsent()).toBeNull();
    localStorage.setItem(CONSENT_STORAGE_KEY, 'granted');
    expect(readStoredConsent()).toBe('granted');
    localStorage.setItem(CONSENT_STORAGE_KEY, 'garbage');
    expect(readStoredConsent()).toBeNull();
  });
});

describe('<CookieConsent>', () => {
  it('shows on first visit and grants consent on accept', async () => {
    renderBanner();
    expect(screen.getByRole('dialog', { name: /cookie consent/i })).toBeInTheDocument();
    expect(screen.getByTestId('probe').textContent).toBe('null:true');

    await userEvent.click(screen.getByRole('button', { name: 'Accept' }));

    expect(localStorage.getItem(CONSENT_STORAGE_KEY)).toBe('granted');
    expect(screen.getByTestId('probe').textContent).toBe('granted:false');
    expect(screen.queryByRole('dialog', { name: /cookie consent/i })).not.toBeInTheDocument();
  });

  it('records a decline and hides the banner', async () => {
    renderBanner();
    await userEvent.click(screen.getByRole('button', { name: 'Decline' }));
    expect(localStorage.getItem(CONSENT_STORAGE_KEY)).toBe('denied');
    expect(screen.queryByRole('dialog', { name: /cookie consent/i })).not.toBeInTheDocument();
  });

  it('stays hidden when a choice was already stored', () => {
    localStorage.setItem(CONSENT_STORAGE_KEY, 'denied');
    renderBanner();
    expect(screen.queryByRole('dialog', { name: /cookie consent/i })).not.toBeInTheDocument();
    expect(screen.getByTestId('probe').textContent).toBe('denied:false');
  });
});
