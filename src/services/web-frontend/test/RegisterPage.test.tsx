import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { AuthProvider } from '../src/lib/auth';
import { RegisterPage } from '../src/pages/RegisterPage';

/** Sign-up is gated by the `registration_enabled` system setting. */

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const publicSettings = (registration_enabled: boolean, support_email = 'help@409.ai') =>
  jsonResponse({ settings: { registration_enabled, maintenance_mode: false, support_email } });

function renderRegister() {
  return render(
    <MemoryRouter initialEntries={['/register']}>
      <AuthProvider>
        <Routes>
          <Route path="/register" element={<RegisterPage />} />
          <Route path="/login" element={<div>LOGIN</div>} />
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  );
}

describe('RegisterPage', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('shows the sign-up form when registration is open', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(publicSettings(true));
    renderRegister();
    expect(await screen.findByRole('button', { name: 'Create account' })).toBeInTheDocument();
  });

  it('replaces the form with a closed notice when registration is off', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(publicSettings(false));
    renderRegister();

    expect(await screen.findByText('Registration is closed')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Create account' })).not.toBeInTheDocument();
    // The support address comes from the same setting, so it stays current.
    expect(screen.getByRole('link', { name: 'help@409.ai' })).toHaveAttribute('href', 'mailto:help@409.ai');
  });

  it('falls back to showing the form if the settings call fails', async () => {
    // The API still rejects the POST, so the worst case is a clear error
    // rather than a blank page.
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));
    renderRegister();
    expect(await screen.findByRole('button', { name: 'Create account' })).toBeInTheDocument();
  });
});
